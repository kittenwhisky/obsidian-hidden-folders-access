import { App, ButtonComponent, Notice, PluginSettingTab, Setting, setIcon } from 'obsidian'
import type { HiddenFoldersAccessPlugin } from '../plugin'
import { DEFAULT_ALLOWED_EXTENSIONS } from '../types/plugin-settings.intf'
import { parseExtensions } from '../../utils/extensions'
import { log } from '../../utils/log'
import { BUY_ME_A_COFFEE_BADGE_DATA_URL } from '../assets/buy-me-a-coffee'

const INDENT_REM = 1.25

const basenameOf = (path: string): string => {
    const slash = path.lastIndexOf('/')
    return slash === -1 ? path : path.slice(slash + 1)
}

export class HiddenFoldersAccessSettingsTab extends PluginSettingTab {
    plugin: HiddenFoldersAccessPlugin

    constructor(app: App, plugin: HiddenFoldersAccessPlugin) {
        super(app, plugin)
        this.plugin = plugin
    }

    override display(): void {
        const { containerEl } = this
        containerEl.empty()

        this.renderIntro(containerEl)
        void this.renderFolderList(containerEl)
        this.renderFileTypes(containerEl)
        this.renderSupportHeader(containerEl)
    }

    private renderIntro(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('Hidden folders').setHeading()

        const desc = containerEl.createDiv()
        desc.createEl('p', {
            text: 'Select which hidden folders (names starting with a dot) Obsidian should index. Toggling a folder on kicks off indexing in the background — you can close this tab and keep working while it runs. A notification updates live and disappears when the folder is fully indexed.'
        })
        desc.createEl('p', {
            text: 'Browse the vault as a tree: click any regular folder to expand it and reveal nested hidden folders. The Obsidian configuration folder, .git, .trash and node_modules are always excluded.'
        })

        new Setting(containerEl)
            .setName('Refresh folder list')
            .setDesc(
                'Re-scan to pick up newly created folders. This does not re-index folders that are already enabled — it only refreshes the list below. Collapsed branches reset to closed.'
            )
            .addButton((button) =>
                button
                    .setButtonText('Refresh')
                    .setCta()
                    .onClick(() => {
                        this.display()
                        new Notice('Hidden folder list refreshed')
                    })
            )
    }

    private async renderFolderList(containerEl: HTMLElement): Promise<void> {
        const tree = containerEl.createDiv({ cls: 'hfa-tree' })
        const loading = tree.createEl('p', { text: 'Scanning vault root…' })

        let listing: { dotFolders: string[]; regularFolders: string[] }
        try {
            listing = await this.plugin.indexer.listChildFolders('')
        } catch (err) {
            log('Failed to list hidden folders', 'error', err)
            loading.setText('Failed to list hidden folders. Check the developer console.')
            return
        }

        loading.remove()

        if (listing.dotFolders.length === 0 && listing.regularFolders.length === 0) {
            tree.createEl('p', {
                text: 'No folders found at the vault root.',
                cls: 'hfa-tree-empty'
            })
            return
        }

        // Enabled entries that no longer exist on disk are intentionally kept
        // in the config. The indexer silently skips them and the plugin will
        // pick them up again if/when the folder reappears (restart, toggle,
        // rescan command).

        this.renderTreeChildren(tree, listing, 0)
    }

    private renderTreeChildren(
        container: HTMLElement,
        listing: { dotFolders: string[]; regularFolders: string[] },
        depth: number
    ): void {
        for (const fullPath of listing.dotFolders) {
            this.renderDotFolderRow(container, fullPath, depth)
        }
        for (const fullPath of listing.regularFolders) {
            this.renderExpandableRow(container, fullPath, depth)
        }
    }

    private renderDotFolderRow(container: HTMLElement, fullPath: string, depth: number): void {
        const row = container.createDiv({ cls: 'hfa-tree-row' })
        row.style.paddingLeft = `${depth * INDENT_REM}rem`

        const setting = new Setting(row).setName(basenameOf(fullPath))
        if (depth > 0) {
            setting.setDesc(fullPath)
        }
        setting.addToggle((toggle) => {
            toggle
                .setValue(this.plugin.settings.enabledFolders.includes(fullPath))
                .onChange((value) => {
                    // Compute the new list from the latest persisted state,
                    // not from a snapshot taken when the tab was rendered.
                    const current = new Set(this.plugin.settings.enabledFolders)
                    if (value) {
                        current.add(fullPath)
                    } else {
                        current.delete(fullPath)
                    }
                    // Don't await: settings are saved and the background
                    // task is spawned inside updateEnabledFolders. Blocking
                    // here would freeze the toggle animation.
                    void this.plugin.updateEnabledFolders([...current])
                })
        })
    }

    private renderExpandableRow(container: HTMLElement, fullPath: string, depth: number): void {
        const row = container.createDiv({ cls: 'hfa-tree-row' })
        row.style.paddingLeft = `${depth * INDENT_REM}rem`

        const header = row.createEl('button', { cls: 'hfa-tree-header', type: 'button' })
        const chevron = header.createSpan({ cls: 'hfa-chevron' })
        setIcon(chevron, 'chevron-right')
        header.createSpan({ cls: 'hfa-tree-name', text: basenameOf(fullPath) })

        const childContainer = row.createDiv({ cls: 'hfa-tree-children is-collapsed' })

        let loaded = false
        header.addEventListener('click', () => {
            const collapsed = childContainer.classList.contains('is-collapsed')
            if (collapsed) {
                if (!loaded) {
                    loaded = true
                    void this.expandInto(childContainer, fullPath, depth + 1)
                }
                childContainer.classList.remove('is-collapsed')
                chevron.empty()
                setIcon(chevron, 'chevron-down')
            } else {
                childContainer.classList.add('is-collapsed')
                chevron.empty()
                setIcon(chevron, 'chevron-right')
            }
        })
    }

    private async expandInto(
        container: HTMLElement,
        parentPath: string,
        depth: number
    ): Promise<void> {
        const loading = container.createEl('p', {
            text: `Scanning ${parentPath}…`,
            cls: 'hfa-tree-empty'
        })
        loading.style.paddingLeft = `${depth * INDENT_REM}rem`

        let listing: { dotFolders: string[]; regularFolders: string[] }
        try {
            listing = await this.plugin.indexer.listChildFolders(parentPath)
        } catch (err) {
            log(`Failed to list folder "${parentPath}"`, 'error', err)
            loading.setText('Failed to list folder. Check the developer console.')
            return
        }

        loading.remove()

        if (listing.dotFolders.length === 0 && listing.regularFolders.length === 0) {
            const empty = container.createEl('p', {
                text: 'Empty.',
                cls: 'hfa-tree-empty'
            })
            empty.style.paddingLeft = `${depth * INDENT_REM}rem`
            return
        }

        this.renderTreeChildren(container, listing, depth)
    }

    private renderFileTypes(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('File types').setHeading()

        const desc = containerEl.createDiv()
        desc.createEl('p', {
            text: 'Comma-separated list of file extensions (without leading dot) that should be indexed inside enabled hidden folders. Folders are always traversed — this list only filters which files are injected into Obsidian. Defaults cover every format Obsidian supports natively (Markdown, Canvas, Bases, images, PDF, audio, video).'
        })
        desc.createEl('p', {
            text: 'Changes are applied when you click Save — this triggers a full rebuild of every enabled folder in the background.'
        })

        let pending = this.plugin.settings.allowedExtensions.join(', ')
        let saveButton: ButtonComponent | null = null

        // A change is "effective" only when the parsed extension list differs
        // from what's currently persisted — whitespace, casing, duplicates and
        // leading dots in the textarea must not count as dirty, otherwise the
        // button is enabled when the user has changed nothing meaningful.
        const isDirty = (raw: string): boolean => {
            const parsed = parseExtensions(raw).join(',')
            const current = this.plugin.settings.allowedExtensions.join(',')
            return parsed !== current
        }

        const refreshDirty = (): void => {
            saveButton?.setDisabled(!isDirty(pending))
        }

        new Setting(containerEl)
            .setName('Allowed extensions')
            .setDesc('e.g. md, canvas, base, png, pdf')
            .addTextArea((textArea) => {
                textArea
                    .setPlaceholder('md, canvas, base, …')
                    .setValue(pending)
                    .onChange((value) => {
                        pending = value
                        refreshDirty()
                    })
                textArea.inputEl.rows = 3
                textArea.inputEl.classList.add('w-full')
            })

        new Setting(containerEl)
            .addButton((button) => {
                saveButton = button
                button
                    .setButtonText('Save')
                    .setCta()
                    .setDisabled(true)
                    .onClick(() => {
                        if (!isDirty(pending)) return
                        const extensions = parseExtensions(pending)
                        void this.plugin.updateAllowedExtensions(extensions)
                        new Notice('Rebuilding enabled folders with the new file-type filter…')
                        saveButton?.setDisabled(true)
                    })
            })
            .addButton((button) =>
                button.setButtonText('Reset to defaults').onClick(() => {
                    pending = [...DEFAULT_ALLOWED_EXTENSIONS].join(', ')
                    void this.plugin.updateAllowedExtensions([...DEFAULT_ALLOWED_EXTENSIONS])
                    new Notice('Allowed extensions reset to defaults. Rebuilding…')
                    this.display()
                })
            )
    }

    private renderSupportHeader(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('Support').setHeading()

        const supportDesc = new DocumentFragment()
        supportDesc.createDiv({
            text: 'Buy me a coffee to support the development of this plugin ❤️'
        })

        new Setting(containerEl).setDesc(supportDesc)

        this.renderBuyMeACoffeeBadge(containerEl)
        const spacing = containerEl.createDiv()
        spacing.classList.add('support-header-margin')
    }

    private renderBuyMeACoffeeBadge(contentEl: HTMLElement | DocumentFragment, width = 175): void {
        const linkEl = contentEl.createEl('a', {
            href: 'https://www.buymeacoffee.com/dsebastien'
        })
        const imgEl = linkEl.createEl('img')
        imgEl.src = BUY_ME_A_COFFEE_BADGE_DATA_URL
        imgEl.alt = 'Buy me a coffee'
        imgEl.width = width
    }
}
