import { CommandsRegistry } from '../platform/commands/common/commands.js';
import { MenuId, MenuRegistry } from '../platform/actions/common/actions.js';
import { IProductService } from '../platform/product/common/productService.js';
import { IConfigurationRegistry, Extensions } from '../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../platform/registry/common/platform.js';
import { IUserDataProfilesService } from '../platform/userDataProfile/common/userDataProfile.js';
import { IUserDataProfileService } from './services/userDataProfile/common/userDataProfile.js';
import { IWorkbenchThemeService } from './services/themes/common/workbenchThemeService.js';
import { IWorkbenchEnvironmentService } from './services/environment/common/environmentService.js';
import { Disposable, MutableDisposable } from '../base/common/lifecycle.js';
import { mainWindow } from '../base/browser/window.js';
import { IStorageService, StorageScope, StorageTarget } from '../platform/storage/common/storage.js';
import { IEditorGroupsService } from './services/editor/common/editorGroupsService.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from './common/contributions.js';
import { IWorkbenchLayoutService, Parts } from './services/layout/browser/layoutService.js';
import { IWorkspaceContextService, WorkbenchState } from '../platform/workspace/common/workspace.js';
import { IContextKeyService } from '../platform/contextkey/common/contextkey.js';
import './hydraNotices.js';
import './hydraModeSwitch.js';

CommandsRegistry.registerCommand('hydra.desktop.startupContext', accessor => {
	if (accessor.get(IProductService).nameShort !== 'Hydra') { throw new Error('Hydra desktop is required.'); }
	const environment = accessor.get(IWorkbenchEnvironmentService);
	return { development: environment.isExtensionDevelopment || !!environment.extensionTestsLocationURI };
});

// Hydra Settings leads the title bar gear (Manage) menu, above Command Palette.
MenuRegistry.appendMenuItem(MenuId.GlobalActivity, { command: { id: 'hydra.openSettings', title: 'Hydra Settings' }, group: '0_hydra', order: 1 });

// Owned desktop API: extensions do not infer active profiles from global storage.
CommandsRegistry.registerCommand('hydra.desktop.profileResources', async accessor => {
	if (accessor.get(IProductService).nameShort !== 'Hydra') { throw new Error('Hydra desktop is required.'); }
	const profile = accessor.get(IUserDataProfileService).currentProfile;
	const root = accessor.get(IUserDataProfilesService).defaultProfile.location;
	const themes = await accessor.get(IWorkbenchThemeService).getColorThemes();
	return {
		id: profile.id, name: profile.name, root: root.fsPath,
		settings: profile.settingsResource.fsPath, keybindings: profile.keybindingsResource.fsPath,
		snippets: profile.snippetsHome.fsPath,
		inherited: (['settings', 'keybindings', 'snippets'] as const).filter(category => profile.useDefaultFlags?.[category]),
		knownSettings: Object.keys(Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationProperties()),
		themes: themes.map(theme => theme.settingsId)
	};
});

// The agent side bar stays hidden on the empty start surface (no folder open) and
// reappears once a folder or workspace opens; the terminal panel never
// auto-opens, matching Cursor's clean landing state.
//
// The Agent Manager is the whole window (docs/Heads.md, "The Agents view"): while
// it's open, only the title bar (with the Agent Manager | Editor switch) stays;
// the side bars, panel, status bar, tab strip and other editor groups go.
// Switching back to the Editor puts every one of them back as it was. What was
// showing is kept in workspace storage, so a window closed in the Agent Manager
// still comes back to the Editor it had.
const editorLayoutParts = [Parts.SIDEBAR_PART, Parts.AUXILIARYBAR_PART, Parts.PANEL_PART, Parts.STATUSBAR_PART] as const;
type EditorLayout = { visible: Parts[]; maximized: boolean };
const editorLayoutKey = 'hydra.agentManager.editorLayout';

class HydraWindowLayout extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'hydra.workbench.contrib.startSurfaceLayout';

	private readonly tabs = this._register(new MutableDisposable());
	private mode: string | undefined;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IEditorGroupsService private readonly editorGroups: IEditorGroupsService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		this.layoutService.setPartHidden(this.contextService.getWorkbenchState() === WorkbenchState.EMPTY, Parts.AUXILIARYBAR_PART);
		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
		this._register(this.contextService.onDidChangeWorkbenchState(() => {
			if (this.mode !== 'agents') this.layoutService.setPartHidden(this.contextService.getWorkbenchState() === WorkbenchState.EMPTY, Parts.AUXILIARYBAR_PART);
		}));
		this.modeChanged();
		this._register(this.contextKeyService.onDidChangeContext(event => {
			if (event.affectsSome(new Set(['hydra.mode']))) this.modeChanged();
		}));
	}

	private modeChanged(): void {
		const mode = this.contextKeyService.getContextKeyValue<string>('hydra.mode');
		if (mode === this.mode) return;
		const previous = this.mode;
		this.mode = mode;
		if (mode === 'agents') this.enterAgentManager();
		// Back from the Agent Manager, or a window that closed in it and opened again in the Editor.
		else if (mode === 'editor' && (previous === 'agents' || previous === undefined)) this.restoreEditor();
	}

	private enterAgentManager(): void {
		if (!this.storage.get(editorLayoutKey, StorageScope.WORKSPACE)) {
			const layout: EditorLayout = { visible: editorLayoutParts.filter(part => this.layoutService.isVisible(part, mainWindow)), maximized: false };
			if (this.editorGroups.mainPart.count > 1 && !this.editorGroups.mainPart.hasMaximizedGroup()) {
				this.editorGroups.mainPart.toggleMaximizeGroup(this.editorGroups.mainPart.activeGroup);
				layout.maximized = true;
			}
			this.storage.store(editorLayoutKey, JSON.stringify(layout), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
		for (const part of editorLayoutParts) this.layoutService.setPartHidden(true, part);
		this.tabs.value = this.editorGroups.mainPart.enforcePartOptions({ showTabs: 'none' });
	}

	private restoreEditor(): void {
		this.tabs.clear();
		const saved = this.storage.get(editorLayoutKey, StorageScope.WORKSPACE);
		if (!saved) return;
		this.storage.remove(editorLayoutKey, StorageScope.WORKSPACE);
		let layout: EditorLayout;
		try { layout = JSON.parse(saved); } catch { return; }
		for (const part of editorLayoutParts) this.layoutService.setPartHidden(!layout.visible?.includes(part), part);
		if (layout.maximized && this.editorGroups.mainPart.hasMaximizedGroup()) this.editorGroups.mainPart.toggleMaximizeGroup();
	}
}

registerWorkbenchContribution2(HydraWindowLayout.ID, HydraWindowLayout, WorkbenchPhase.AfterRestored);
