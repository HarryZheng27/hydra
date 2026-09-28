import { $, append, addDisposableListener } from '../base/browser/dom.js';
import { renderIcon } from '../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../base/common/codicons.js';
import { CommandsRegistry } from '../platform/commands/common/commands.js';
import { IProductService } from '../platform/product/common/productService.js';
import { ILayoutService } from '../platform/layout/browser/layoutService.js';
import { IWorkbenchEnvironmentService } from './services/environment/common/environmentService.js';

/**
 * Hydra's own notifications (docs/Heads.md, "Hydra's notifications"): a Hydra-styled toast stack drawn over the
 * whole window, for the messages Hydra's built-in extension shows, instead of the editor's standard toasts. The
 * extension calls the commands below (src/notices.ts); modal confirmations stay native dialogs.
 *
 * Any installed extension can run a command, so every input is checked here and rendered as plain text, never HTML.
 */
type NoticeKind = 'info' | 'warning' | 'error';
interface NoticeRequest { id: string; kind: NoticeKind; message: string; detail?: string; actions?: string[]; progress?: boolean | number; sticky?: boolean }
interface NoticeUpdate { message?: string; detail?: string; progress?: boolean | number }
interface Entry { request: NoticeRequest; element: HTMLElement; resolve: (choice: string | undefined) => void; timer?: ReturnType<typeof setTimeout>; dispose: () => void }

const kinds: readonly NoticeKind[] = ['info', 'warning', 'error'];
const idPattern = /^[\w.:-]{1,64}$/;
const maxVisible = 5;
/** How long a notice with nothing to answer stays up; hovering or focusing it holds it. Errors stay until closed. */
const lingerMs: Record<NoticeKind, number> = { info: 8000, warning: 14000, error: 0 };

const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;

function parseRequest(value: unknown): NoticeRequest {
	const source = value as Partial<NoticeRequest> | undefined;
	if (!source || typeof source !== 'object') { throw new Error('A Hydra notice must be an object.'); }
	if (typeof source.id !== 'string' || !idPattern.test(source.id)) { throw new Error('A Hydra notice needs an id.'); }
	if (!kinds.includes(source.kind as NoticeKind)) { throw new Error('A Hydra notice is info, warning or error.'); }
	const message = text(source.message, 1000);
	if (!message) { throw new Error('A Hydra notice needs a message.'); }
	const actions = Array.isArray(source.actions) ? source.actions.map(action => text(action, 40)).filter((action): action is string => !!action).slice(0, 3) : [];
	const progress = source.progress === true || (typeof source.progress === 'number' && Number.isFinite(source.progress)) ? source.progress : undefined;
	return { id: source.id, kind: source.kind as NoticeKind, message, detail: text(source.detail, 2000), actions, progress, sticky: source.sticky === true };
}

const entries = new Map<string, Entry>();
/** Ids closed before their show arrived (each command waits on its own activation, so close can overtake show). */
const closedEarly = new Set<string>();
let stack: HTMLElement | undefined;

function container(layout: ILayoutService): HTMLElement {
	if (!stack || !stack.isConnected) {
		stack = append(layout.mainContainer, $('.hydra-notices'));
		stack.setAttribute('role', 'region');
		stack.setAttribute('aria-label', 'Hydra notifications');
	}
	return stack;
}

function renderProgress(element: HTMLElement, progress: boolean | number | undefined): void {
	let bar = element.querySelector<HTMLElement>('.hydra-notice-progress');
	if (progress === undefined || progress === false) { bar?.remove(); return; }
	if (!bar) {
		bar = $('.hydra-notice-progress');
		append(bar, $('.hydra-notice-progress-bar'));
		element.querySelector('.hydra-notice-actions')?.before(bar) ?? append(element, bar);
	}
	const fill = bar.firstElementChild as HTMLElement;
	bar.classList.toggle('indeterminate', progress === true);
	fill.style.width = progress === true ? '' : `${Math.max(0, Math.min(100, progress))}%`;
}

function setText(element: HTMLElement, selector: string, value: string | undefined, className: string, after: HTMLElement): void {
	let node = element.querySelector<HTMLElement>(selector);
	if (!value) { node?.remove(); return; }
	if (!node) { node = $(className); after.after(node); }
	node.textContent = value;
}

function finish(id: string, choice: string | undefined): void {
	const entry = entries.get(id);
	if (!entry) { return; }
	entries.delete(id);
	if (entry.timer) { clearTimeout(entry.timer); }
	entry.dispose();
	entry.element.classList.add('leaving');
	setTimeout(() => entry.element.remove(), 160);
	entry.resolve(choice);
}

function schedule(entry: Entry): void {
	if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
	const { request } = entry;
	const linger = lingerMs[request.kind];
	// Something to answer, a progress bar, or an error: it stays until it's answered, done, or closed.
	if (request.sticky || request.actions?.length || request.progress !== undefined || !linger) { return; }
	entry.timer = setTimeout(() => finish(request.id, undefined), linger);
}

function show(layout: ILayoutService, request: NoticeRequest): Promise<string | undefined> {
	if (closedEarly.delete(request.id)) { return Promise.resolve(undefined); }
	if (entries.has(request.id)) { finish(request.id, undefined); }
	const root = container(layout);
	const element = $(`.hydra-notice.hydra-notice-${request.kind}`);
	element.setAttribute('role', request.kind === 'info' ? 'status' : 'alert');
	element.tabIndex = -1;

	const head = append(element, $('.hydra-notice-head'));
	append(head, $('span.hydra-notice-mark'));
	append(head, $('span.hydra-notice-brand', undefined, 'Hydra'));
	const close = append(head, $('button.hydra-notice-close'));
	close.setAttribute('aria-label', 'Dismiss');
	close.title = 'Dismiss';
	close.appendChild(renderIcon(Codicon.close));

	const message = append(element, $('.hydra-notice-message'));
	message.textContent = request.message;
	setText(element, '.hydra-notice-detail', request.detail, '.hydra-notice-detail', message);

	if (request.actions?.length) {
		const actions = append(element, $('.hydra-notice-actions'));
		request.actions.forEach((label, index) => {
			const button = append(actions, $(index === 0 ? 'button.hydra-notice-action.primary' : 'button.hydra-notice-action'));
			button.textContent = label;
			button.onclick = () => finish(request.id, label);
		});
	}
	renderProgress(element, request.progress);

	const listeners = [
		addDisposableListener(close, 'click', () => finish(request.id, undefined)),
		addDisposableListener(element, 'keydown', event => { if (event.key === 'Escape') { finish(request.id, undefined); } }),
		// Reading it (hover or focus) holds it; leaving starts the clock again.
		addDisposableListener(element, 'mouseenter', () => { const entry = entries.get(request.id); if (entry?.timer) { clearTimeout(entry.timer); entry.timer = undefined; } }),
		addDisposableListener(element, 'mouseleave', () => { const entry = entries.get(request.id); if (entry) { schedule(entry); } }),
	];
	root.appendChild(element);

	return new Promise(resolve => {
		const entry: Entry = { request, element, resolve, dispose: () => listeners.forEach(listener => listener.dispose()) };
		entries.set(request.id, entry);
		schedule(entry);
		// Never more than a few at once: the oldest one that isn't waiting on an answer or in progress goes first.
		while (entries.size > maxVisible) {
			const oldest = [...entries.values()].find(item => !item.request.actions?.length && item.request.progress === undefined) ?? entries.values().next().value!;
			finish(oldest.request.id, undefined);
		}
	});
}

const requireHydra = (product: IProductService) => { if (product.nameShort !== 'Hydra') { throw new Error('Hydra desktop is required.'); } };

/** Shows a notice; resolves with the action pressed, or undefined when it was dismissed, expired or replaced. */
CommandsRegistry.registerCommand('hydra.desktop.notice.show', (accessor, value: unknown) => {
	requireHydra(accessor.get(IProductService));
	return show(accessor.get(ILayoutService), parseRequest(value));
});
/** Changes a shown notice's message, detail or progress (a progress task reporting as it goes). */
CommandsRegistry.registerCommand('hydra.desktop.notice.update', (accessor, id: unknown, value: unknown) => {
	requireHydra(accessor.get(IProductService));
	const entry = typeof id === 'string' ? entries.get(id) : undefined;
	if (!entry) { return false; }
	const update = (value && typeof value === 'object' ? value : {}) as NoticeUpdate;
	const message = text(update.message, 1000);
	if (message) { entry.request.message = message; entry.element.querySelector('.hydra-notice-message')!.textContent = message; }
	if ('detail' in update) {
		entry.request.detail = text(update.detail, 2000);
		setText(entry.element, '.hydra-notice-detail', entry.request.detail, '.hydra-notice-detail', entry.element.querySelector<HTMLElement>('.hydra-notice-message')!);
	}
	if ('progress' in update) {
		const progress = update.progress === true || (typeof update.progress === 'number' && Number.isFinite(update.progress)) ? update.progress : undefined;
		entry.request.progress = progress;
		renderProgress(entry.element, progress);
		schedule(entry);
	}
	return true;
});
CommandsRegistry.registerCommand('hydra.desktop.notice.close', (accessor, id: unknown) => {
	requireHydra(accessor.get(IProductService));
	if (typeof id !== 'string' || !idPattern.test(id)) { return; }
	if (entries.has(id)) { finish(id, undefined); return; }
	closedEarly.add(id);
	if (closedEarly.size > 100) { closedEarly.delete(closedEarly.values().next().value!); }
});
/**
 * list and choose exist for the desktop smoke only: in a normal window they refuse, so no other extension can read
 * Hydra's notices or press their buttons.
 */
const requireTestHost = (environment: IWorkbenchEnvironmentService) => { if (!environment.isExtensionDevelopment && !environment.extensionTestsLocationURI) { throw new Error('Only a Hydra test host can read or answer notices.'); } };
CommandsRegistry.registerCommand('hydra.desktop.notice.list', accessor => {
	requireHydra(accessor.get(IProductService));
	requireTestHost(accessor.get(IWorkbenchEnvironmentService));
	return [...entries.values()].map(({ request }) => ({ id: request.id, kind: request.kind, message: request.message, actions: request.actions ?? [], progress: request.progress }));
});
/** Presses a shown notice's action, as a click would. */
CommandsRegistry.registerCommand('hydra.desktop.notice.choose', (accessor, id: unknown, action: unknown) => {
	requireHydra(accessor.get(IProductService));
	requireTestHost(accessor.get(IWorkbenchEnvironmentService));
	const entry = typeof id === 'string' ? entries.get(id) : undefined;
	if (!entry || typeof action !== 'string' || !entry.request.actions?.includes(action)) { return false; }
	finish(entry.request.id, action);
	return true;
});
