import { beforeEach, describe, expect, test } from 'bun:test'
import type { App } from 'obsidian'
import { HiddenFoldersIndexer } from './hidden-folders-indexer'

interface FakeAdapter {
    list: (path: string) => Promise<{ files: string[]; folders: string[] }>
}

interface FakeApp {
    vault: {
        adapter: FakeAdapter
        configDir: string
        getAllLoadedFiles: () => []
    }
}

const DEFAULT_CONFIG_DIR = `.${'obsidian'}`

/**
 * Build a fake App. Pass an array to return the same folder list for any
 * `list()` call (back-compat with root-only callers), or a map of path →
 * folder list to vary the response per path (needed for nested behaviour).
 */
function makeApp(folders: string[], configDir?: string): FakeApp
function makeApp(listings: Record<string, string[]>, configDir?: string): FakeApp
function makeApp(
    foldersOrListings: string[] | Record<string, string[]>,
    configDir = DEFAULT_CONFIG_DIR
): FakeApp {
    const list = Array.isArray(foldersOrListings)
        ? async (): Promise<{ files: string[]; folders: string[] }> => ({
              files: [],
              folders: foldersOrListings
          })
        : async (path: string): Promise<{ files: string[]; folders: string[] }> => ({
              files: [],
              folders: foldersOrListings[path] ?? []
          })
    return {
        vault: {
            adapter: { list },
            configDir,
            getAllLoadedFiles: () => []
        }
    }
}

describe('HiddenFoldersIndexer', () => {
    let indexer: HiddenFoldersIndexer

    beforeEach(() => {
        indexer = new HiddenFoldersIndexer(makeApp([]) as unknown as App)
    })

    describe('extension allowlist', () => {
        test('is empty by default (no filtering)', () => {
            expect(indexer.getAllowedExtensions()).toEqual([])
        })

        test('setAllowedExtensions normalizes input', () => {
            indexer.setAllowedExtensions(['.MD', 'Canvas ', '  base', '.PDF'])
            expect(indexer.getAllowedExtensions()).toEqual(['base', 'canvas', 'md', 'pdf'])
        })

        test('setAllowedExtensions drops empty entries', () => {
            indexer.setAllowedExtensions(['md', '', '  ', '.'])
            expect(indexer.getAllowedExtensions()).toEqual(['md'])
        })

        test('setAllowedExtensions deduplicates', () => {
            indexer.setAllowedExtensions(['md', 'MD', '.md', 'canvas'])
            expect(indexer.getAllowedExtensions()).toEqual(['canvas', 'md'])
        })

        test('setAllowedExtensions can be called multiple times and replaces the list', () => {
            indexer.setAllowedExtensions(['md'])
            indexer.setAllowedExtensions(['canvas', 'base'])
            expect(indexer.getAllowedExtensions()).toEqual(['base', 'canvas'])
        })
    })

    describe('enabled prefixes', () => {
        test('starts empty', () => {
            expect(indexer.getEnabledPrefixes()).toEqual([])
        })

        test('isBusy returns false for any path when idle', () => {
            expect(indexer.isBusy('.claude')).toBe(false)
            expect(indexer.isBusy('.github')).toBe(false)
        })
    })

    describe('enablePath with missing folder', () => {
        test('resolves silently without throwing', async () => {
            const app = makeApp(['/.claude']) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            await idx.enablePath('.missing')
            expect(idx.getEnabledPrefixes()).toEqual([])
        })

        test('does not patch the adapter when the folder is missing', async () => {
            const app = makeApp([]) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            await idx.enablePath('.missing')
            const adapter = app.vault.adapter as unknown as { listRecursiveChild?: unknown }
            expect(adapter.listRecursiveChild).toBeUndefined()
        })

        test('is idempotent when called repeatedly for a missing folder', async () => {
            const app = makeApp([]) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            await idx.enablePath('.missing')
            await idx.enablePath('.missing')
            expect(idx.getEnabledPrefixes()).toEqual([])
        })
    })

    describe('pathExistsOnDisk', () => {
        test('returns true when the folder is at the vault root', async () => {
            const app = makeApp(['/.claude', '/.github']) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect(await idx.pathExistsOnDisk('.claude')).toBe(true)
            expect(await idx.pathExistsOnDisk('/.claude')).toBe(true)
        })

        test('returns false when the folder is not on disk', async () => {
            const app = makeApp(['/.claude']) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect(await idx.pathExistsOnDisk('.missing')).toBe(false)
        })

        test('returns false for an empty path', async () => {
            const app = makeApp(['/.claude']) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect(await idx.pathExistsOnDisk('')).toBe(false)
            expect(await idx.pathExistsOnDisk('/')).toBe(false)
        })
    })

    describe('listHiddenRootFolders', () => {
        test('returns only folders that start with a dot', async () => {
            const app = makeApp(['/.claude', '/.github', '/Projects', '/Archive']) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect(await idx.listHiddenRootFolders()).toEqual(['.claude', '.github'])
        })

        test('excludes the Obsidian config directory', async () => {
            const app = makeApp([
                '/.claude',
                `/${DEFAULT_CONFIG_DIR}`,
                '/.github'
            ]) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect(await idx.listHiddenRootFolders()).toEqual(['.claude', '.github'])
        })

        test('returns entries sorted alphabetically', async () => {
            const app = makeApp(['/.zeta', '/.alpha', '/.mu']) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect(await idx.listHiddenRootFolders()).toEqual(['.alpha', '.mu', '.zeta'])
        })

        test('normalises leading slashes in folder names', async () => {
            const app = makeApp(['///.claude', '.github']) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect(await idx.listHiddenRootFolders()).toEqual(['.claude', '.github'])
        })

        test('honours a custom configDir', async () => {
            const app = makeApp(['/.claude', '/.custom-config'], '.custom-config') as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect(await idx.listHiddenRootFolders()).toEqual(['.claude'])
        })
    })

    describe('listChildFolders', () => {
        test('returns empty arrays for an empty vault root', async () => {
            const app = makeApp({ '/': [] }) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect(await idx.listChildFolders('')).toEqual({
                dotFolders: [],
                regularFolders: []
            })
        })

        test('partitions root listing into dot vs regular folders', async () => {
            const app = makeApp({
                '/': ['.claude', '.github', 'Projects', 'Archive']
            }) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            const result = await idx.listChildFolders('')
            expect(result.dotFolders).toEqual(['.claude', '.github'])
            expect(result.regularFolders).toEqual(['Archive', 'Projects'])
        })

        test('excludes the Obsidian config directory at root', async () => {
            const app = makeApp({
                '/': ['.claude', DEFAULT_CONFIG_DIR, '.github']
            }) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect((await idx.listChildFolders('')).dotFolders).toEqual(['.claude', '.github'])
        })

        test('excludes .git, .trash and node_modules at root', async () => {
            const app = makeApp({
                '/': ['.claude', '.git', '.trash', 'node_modules', 'Projects']
            }) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            const result = await idx.listChildFolders('')
            expect(result.dotFolders).toEqual(['.claude'])
            expect(result.regularFolders).toEqual(['Projects'])
        })

        test('excludes .git, .trash and node_modules at any depth', async () => {
            const app = makeApp({
                '/': ['Projects'],
                'Projects': [
                    'Projects/.archive',
                    'Projects/.git',
                    'Projects/.trash',
                    'Projects/node_modules',
                    'Projects/subproj'
                ]
            }) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            const result = await idx.listChildFolders('Projects')
            expect(result.dotFolders).toEqual(['Projects/.archive'])
            expect(result.regularFolders).toEqual(['Projects/subproj'])
        })

        test('returns dot- and regular folders sorted alphabetically', async () => {
            const app = makeApp({
                '/': ['.zeta', '.alpha', '.mu', 'Zulu', 'Alpha', 'Mike']
            }) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            const result = await idx.listChildFolders('')
            expect(result.dotFolders).toEqual(['.alpha', '.mu', '.zeta'])
            expect(result.regularFolders).toEqual(['Alpha', 'Mike', 'Zulu'])
        })

        test('returns full vault-relative paths for nested listings', async () => {
            const app = makeApp({
                '/': ['notes'],
                'notes': ['notes/.archive', 'notes/projects', 'notes/drafts']
            }) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            const result = await idx.listChildFolders('notes')
            expect(result.dotFolders).toEqual(['notes/.archive'])
            expect(result.regularFolders).toEqual(['notes/drafts', 'notes/projects'])
        })

        test('returns empty arrays when the parent directory has no entries', async () => {
            const app = makeApp({ '/': [] }) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect(await idx.listChildFolders('missing/path')).toEqual({
                dotFolders: [],
                regularFolders: []
            })
        })

        test('returns empty arrays when adapter.list throws', async () => {
            const app: FakeApp = {
                vault: {
                    adapter: {
                        list: async (path: string) => {
                            if (path === '/') return { files: [], folders: [] }
                            throw new Error('ENOENT: no such file or directory')
                        }
                    },
                    configDir: DEFAULT_CONFIG_DIR,
                    getAllLoadedFiles: () => []
                }
            }
            const idx = new HiddenFoldersIndexer(app as unknown as App)
            expect(await idx.listChildFolders('missing/deep')).toEqual({
                dotFolders: [],
                regularFolders: []
            })
        })

        test('honours a custom configDir at any depth', async () => {
            const app = makeApp(
                {
                    '/': ['.claude', '.custom-config'],
                    'sub': ['sub/.custom-config', 'sub/.keepme']
                },
                '.custom-config'
            ) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect((await idx.listChildFolders('')).dotFolders).toEqual(['.claude'])
            expect((await idx.listChildFolders('sub')).dotFolders).toEqual(['sub/.keepme'])
        })
    })

    describe('pathExistsOnDisk for nested paths', () => {
        test('returns true for a nested folder that exists', async () => {
            const app = makeApp({
                '/': ['notes'],
                'notes': ['notes/.archive', 'notes/drafts']
            }) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect(await idx.pathExistsOnDisk('notes/.archive')).toBe(true)
        })

        test('returns false for a nested folder that does not exist', async () => {
            const app = makeApp({
                '/': ['notes'],
                'notes': ['notes/drafts']
            }) as unknown as App
            const idx = new HiddenFoldersIndexer(app)
            expect(await idx.pathExistsOnDisk('notes/.missing')).toBe(false)
        })

        test('returns false (does not throw) when the parent directory is missing', async () => {
            const app: FakeApp = {
                vault: {
                    adapter: {
                        list: async (path: string) => {
                            if (path === '/') return { files: [], folders: [] }
                            throw new Error('ENOENT: no such file or directory')
                        }
                    },
                    configDir: DEFAULT_CONFIG_DIR,
                    getAllLoadedFiles: () => []
                }
            }
            const idx = new HiddenFoldersIndexer(app as unknown as App)
            expect(await idx.pathExistsOnDisk('missing/deep/path')).toBe(false)
        })
    })
})
