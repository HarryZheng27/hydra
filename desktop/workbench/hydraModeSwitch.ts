import { $, append, prepend, addDisposableListener } from '../base/browser/dom.js';
import { mainWindow } from '../base/browser/window.js';
import { renderIcon } from '../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../base/common/codicons.js';
import { Disposable } from '../base/common/lifecycle.js';
import { ICommandService } from '../platform/commands/common/commands.js';
import { IContextKeyService } from '../platform/contextkey/common/contextkey.js';
import { IProductService } from '../platform/product/common/productService.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from './common/contributions.js';
import { IWorkbenchLayoutService, Parts } from './services/layout/browser/layoutService.js';
import { IHostService } from './services/host/browser/host.js';

/**
 * The "Agent Manager | Editor" switch in the title bar (docs/Heads.md, "The Agents view"). The built-in extension owns
 * the two modes: it sets the `hydra.mode` context key and runs `hydra.openAgents` / `hydra.openEditor`. Until it has
 * set `hydra.mode` (not yet started, or switched off in a folder you haven't trusted) the switch stays hidden.
 *
 * In the Editor, a button next to it shows or hides the agent side bar (Claude Code and Codex, on the right).
 */
const modes = [
	{ mode: 'agents', label: 'Agent Manager', command: 'hydra.openAgents' },
	{ mode: 'editor', label: 'Editor', command: 'hydra.openEditor' },
] as const;

class HydraModeSwitch extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'hydra.workbench.contrib.modeSwitch';

	private readonly buttons = new Map<string, HTMLButtonElement>();
	private readonly element: HTMLElement | undefined;
	private readonly agentsPanel: HTMLButtonElement | undefined;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ICommandService commandService: ICommandService,
		@IProductService productService: IProductService,
	) {
		super();
		const right = layoutService.getContainer(mainWindow, Parts.TITLEBAR_PART)?.querySelector<HTMLElement>('.titlebar-right');
		if (productService.nameShort !== 'Hydra' || !right) { return; }
		this.element = prepend(right, $('.hydra-mode-switch-bar'));
		const group = append(this.element, $('.hydra-mode-switch'));
		group.setAttribute('role', 'group');
		group.setAttribute('aria-label', 'Hydra: Agent Manager or Editor (Alt+Shift+A)');
		for (const { mode, label, command } of modes) {
			const button = append(group, $<HTMLButtonElement>('button.hydra-mode-switch-option'));
			button.type = 'button';
			button.textContent = label;
			button.title = `${label} (Alt+Shift+A switches)`;
			this._register(addDisposableListener(button, 'click', () => { void commandService.executeCommand(command).catch(() => undefined); }));
			this.buttons.set(mode, button);
		}
		this.agentsPanel = append(this.element, $<HTMLButtonElement>('button.hydra-agents-panel-toggle'));
		this.agentsPanel.type = 'button';
		this.agentsPanel.appendChild(renderIcon(Codicon.layoutSidebarRight));
		this._register(addDisposableListener(this.agentsPanel, 'click', () => { void commandService.executeCommand('workbench.action.toggleAuxiliaryBar').catch(() => undefined); }));
		this._register({ dispose: () => this.element?.remove() });
		this.update();
		this._register(this.contextKeyService.onDidChangeContext(event => {
			if (event.affectsSome(new Set(['hydra.mode']))) { this.update(); }
		}));
		this._register(this.layoutService.onDidChangePartVisibility(() => this.update()));
	}

	private update(): void {
		const mode = this.contextKeyService.getContextKeyValue<string>('hydra.mode');
		if (!this.element || !this.agentsPanel) { return; }
		this.element.hidden = mode !== 'agents' && mode !== 'editor';
		for (const [option, button] of this.buttons) {
			button.classList.toggle('checked', option === mode);
			button.setAttribute('aria-pressed', String(option === mode));
		}
		const open = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART, mainWindow);
		this.agentsPanel.hidden = mode !== 'editor';
		this.agentsPanel.classList.toggle('checked', open);
		this.agentsPanel.setAttribute('aria-pressed', String(open));
		this.agentsPanel.setAttribute('aria-label', open ? 'Hide the agent side bar' : 'Show the agent side bar');
		this.agentsPanel.title = `${open ? 'Hide' : 'Show'} the agent side bar (Ctrl+Alt+B)`;
	}
}

registerWorkbenchContribution2(HydraModeSwitch.ID, HydraModeSwitch, WorkbenchPhase.AfterRestored);

/**
 * The window controls (minimize, maximize, close) are darkened while a dialog is up, by the main process. If the window
 * reloads with a dialog still showing (trusting a folder, a restart for an update), they stay darkened, a shade off the
 * title bar. A fresh window has no dialog yet, so it starts them undarkened.
 */
class HydraWindowControlsUndimmed implements IWorkbenchContribution {
	static readonly ID = 'hydra.workbench.contrib.windowControlsUndimmed';
	constructor(@IHostService hostService: IHostService) {
		void hostService.setWindowDimmed(mainWindow, false).catch(() => undefined);
	}
}

registerWorkbenchContribution2(HydraWindowControlsUndimmed.ID, HydraWindowControlsUndimmed, WorkbenchPhase.BlockStartup);
