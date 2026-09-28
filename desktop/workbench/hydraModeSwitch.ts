import { $, append, prepend, addDisposableListener } from '../base/browser/dom.js';
import { mainWindow } from '../base/browser/window.js';
import { Disposable } from '../base/common/lifecycle.js';
import { ICommandService } from '../platform/commands/common/commands.js';
import { IContextKeyService } from '../platform/contextkey/common/contextkey.js';
import { IProductService } from '../platform/product/common/productService.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from './common/contributions.js';
import { IWorkbenchLayoutService, Parts } from './services/layout/browser/layoutService.js';

/**
 * The "Agent Manager | Editor" switch in the title bar (docs/Heads.md, "The Agents view"). The built-in extension owns
 * the two modes: it sets the `hydra.mode` context key and runs `hydra.openAgents` / `hydra.openEditor`. Until it has
 * set `hydra.mode` (not yet started, or switched off in a folder you haven't trusted) the switch stays hidden.
 */
const modes = [
	{ mode: 'agents', label: 'Agent Manager', command: 'hydra.openAgents' },
	{ mode: 'editor', label: 'Editor', command: 'hydra.openEditor' },
] as const;

class HydraModeSwitch extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'hydra.workbench.contrib.modeSwitch';

	private readonly buttons = new Map<string, HTMLButtonElement>();
	private readonly element: HTMLElement | undefined;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ICommandService commandService: ICommandService,
		@IProductService productService: IProductService,
	) {
		super();
		const right = layoutService.getContainer(mainWindow, Parts.TITLEBAR_PART)?.querySelector<HTMLElement>('.titlebar-right');
		if (productService.nameShort !== 'Hydra' || !right) { return; }
		this.element = prepend(right, $('.hydra-mode-switch'));
		this.element.setAttribute('role', 'group');
		this.element.setAttribute('aria-label', 'Hydra: Agent Manager or Editor (Alt+Shift+A)');
		for (const { mode, label, command } of modes) {
			const button = append(this.element, $<HTMLButtonElement>('button.hydra-mode-switch-option'));
			button.type = 'button';
			button.textContent = label;
			button.title = `${label} (Alt+Shift+A switches)`;
			this._register(addDisposableListener(button, 'click', () => { void commandService.executeCommand(command).catch(() => undefined); }));
			this.buttons.set(mode, button);
		}
		this._register({ dispose: () => this.element?.remove() });
		this.update();
		this._register(this.contextKeyService.onDidChangeContext(event => {
			if (event.affectsSome(new Set(['hydra.mode']))) { this.update(); }
		}));
	}

	private update(): void {
		const mode = this.contextKeyService.getContextKeyValue<string>('hydra.mode');
		if (!this.element) { return; }
		this.element.hidden = mode !== 'agents' && mode !== 'editor';
		for (const [option, button] of this.buttons) {
			button.classList.toggle('checked', option === mode);
			button.setAttribute('aria-pressed', String(option === mode));
		}
	}
}

registerWorkbenchContribution2(HydraModeSwitch.ID, HydraModeSwitch, WorkbenchPhase.AfterRestored);
