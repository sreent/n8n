// Fork test (not in upstream n8n): the recording helpers of the golden tests of the editor of Git
// connections (promotions). They mount a component, act as a user, and record what the user sees:
// text, test ids, controls, icons, requests, navigation, toasts and open modals. They record no
// markup and no styles. See `../../FORK.md`.
import { modalRegistry } from '@n8n/frontend-module-sdk';
import { setNotify } from '@n8n/composables/useToast';
import { fireEvent } from '@testing-library/vue';
import axios, { type AxiosRequestConfig } from 'axios';
import { defineComponent, isVNode, type Component, type VNode } from 'vue';

import { createComponentRenderer, renderComponent } from '@/__tests__/render';
import { useUIStore } from '@/app/stores/ui.store';
import {
	describeDom,
	isRecord,
	normalize,
	pinia,
	plain,
	record,
	router,
	setUnmount,
	settle,
	setup,
	takeLog,
	type Scenario,
} from '@/features/ai/evaluation/__tests__/golden/harness';

import { SETTINGS } from './fixtures';
import * as subject from './subject';

// #region Recording

let container: Element;
export const vueErrors: string[] = [];

export function effects() {
	const entries = takeLog();
	const result: Record<string, unknown> = {};
	if (entries.length) result.effects = entries;
	if (vueErrors.length) result.errors = [...new Set(vueErrors)];
	vueErrors.length = 0;
	return result;
}

export function isShown(element: Element | null): boolean {
	for (let current = element; current; current = current.parentElement) {
		if (current.hasAttribute('hidden')) return false;
		if (current instanceof HTMLElement && current.style.display === 'none') return false;
	}
	return true;
}

/** A toast message that is a VNode, as the text, test ids and controls that it renders. */
export function renderMessage(message: VNode) {
	const rendered = renderComponent(defineComponent({ render: () => message }), {
		pinia,
		global: { plugins: [router] },
	});
	const text = plain(describeDom(rendered.container));
	rendered.unmount();
	rendered.container.remove();
	return text;
}

export function installToastRecorder() {
	setNotify((options) => {
		const { message, ...rest } = options as Record<string, unknown>;
		record('toast', {
			...(plain(rest) as object),
			...(message === undefined
				? {}
				: { message: isVNode(message) ? { rendered: renderMessage(message) } : plain(message) }),
		});
		return { close() {} };
	});
}

/** The open modals with their data, the open message boxes and the open dropdowns. */
export function view() {
	const result: Record<string, unknown> = {};
	const modals = Object.entries(useUIStore().modalsById)
		.filter(([, modal]) => modal.open)
		.map(([name, modal]) => {
			const { open: _open, ...state } = modal;
			return { name, ...(plain(state) as object) };
		});
	if (modals.length) result.modals = modals;
	const dialogs = [...document.body.querySelectorAll('.el-message-box')]
		.filter(isShown)
		.map((element) => plain(describeDom(element)));
	if (dialogs.length) result.dialogs = dialogs;
	const poppers = [
		...document.body.querySelectorAll('.el-popper, [data-reka-popper-content-wrapper]'),
	]
		.filter((element) => isShown(element) && !container.contains(element))
		.filter((element) => !element.closest('.el-message-box'))
		.map((element) => plain(describeDom(element)));
	if (poppers.length) result.dropdowns = poppers;
	result.route = router.currentRoute.value.fullPath;
	return result;
}

/** The page, or the dialog of a modal when it is open. */
export function screen(modalTestId?: string) {
	if (modalTestId) {
		const modal = document.body.querySelector(`[data-test-id="${modalTestId}"]`);
		if (modal && isShown(modal)) return { ...view(), modal: plain(describeDom(modal)) };
		// Another view of the modal: its dialog element.
		const dialogs = [...document.body.querySelectorAll('[role="dialog"]')]
			.filter((element) => isShown(element) && !element.closest('.el-message-box'))
			.map((element) => plain(describeDom(element)));
		return { ...view(), modal: dialogs.length ? { dialogs } : '<closed>' };
	}
	// Dialogs and drawers that the page opens outside its own element.
	const overlays = [...document.body.querySelectorAll('[role="dialog"]')]
		.filter(
			(element) =>
				isShown(element) && !container.contains(element) && !element.closest('.el-message-box'),
		)
		.map((element) => plain(describeDom(element)));
	return {
		...view(),
		...(overlays.length ? { overlays } : {}),
		page: plain(describeDom(container)),
	};
}

/**
 * Finds a control: by a CSS selector after `css:`, by a CSS selector and an exact text after
 * `text:` (`text:<selector>|<text>`, also hidden elements), by its test id, or by its text. A `#n`
 * at the end picks the n-th match.
 */
export function find(target: string): Element | undefined {
	if (target.startsWith('text:')) {
		const [selector, text] = target.slice(5).split('|');
		return [...document.body.querySelectorAll(selector)].find(
			(element) => normalize(element.textContent) === text,
		);
	}
	if (target.startsWith('css:')) {
		const [selector, position] = target.slice(4).split('#');
		return [...document.body.querySelectorAll(selector)].filter(isShown)[Number(position ?? 0)];
	}
	const [testId, position] = target.split('#');
	const byTestId = [...document.body.querySelectorAll(`[data-test-id="${testId}"]`)];
	if (byTestId.length) return byTestId[Number(position ?? 0)];
	const candidates = [
		...document.body.querySelectorAll(
			'button, a, [role="button"], [role="option"], [role="tab"], [role="radio"], [role="menuitem"], [role="checkbox"], li, label',
		),
	];
	const exact =
		candidates.find((element) => isShown(element) && normalize(element.textContent) === target) ??
		candidates.find((element) => normalize(element.textContent) === target) ??
		candidates.find((element) => element.getAttribute('aria-label') === target);
	if (exact) return exact;
	return [...document.body.querySelectorAll('*')]
		.filter(isShown)
		.filter((element) => normalize(element.textContent) === target)
		.pop();
}

/** The deepest element of a link or a button, where a click handler can sit. */
export function clickTarget(element: Element) {
	let current = element;
	while (
		current.children.length === 1 &&
		current.tagName !== 'BUTTON' &&
		current.tagName !== 'INPUT'
	) {
		current = current.children[0];
	}
	return current;
}

/** A click, a text to type into a field, a key, or a time to let pass. */
export type Step =
	| string
	| ['type', string, string]
	| ['key', string, string]
	| ['wait', number]
	| ['hover', string]
	| ['inner', string]
	| ['run', string, () => unknown];

export async function act(step: Step, modalTestId?: string) {
	if (typeof step === 'string') {
		const element = find(step);
		if (!element) return { click: step, missing: true };
		await fireEvent.click(element);
		await settle();
		return { click: step, ...effects(), screen: screen(modalTestId) };
	}
	if (step[0] === 'wait') {
		await vi.advanceTimersByTimeAsync(step[1]);
		await settle();
		return { wait: step[1], ...effects(), screen: screen(modalTestId) };
	}
	if (step[0] === 'run') {
		let outcome: unknown;
		try {
			outcome = { result: plain(await step[2]()) };
		} catch (error) {
			outcome = { error: error instanceof Error ? error.message : String(error) };
		}
		await settle();
		return { run: step[1], ...(outcome as object), ...effects(), screen: screen(modalTestId) };
	}
	const [kind, target, value] = step;
	const element = find(target);
	if (kind === 'inner') {
		if (!element) return { click: target, missing: true };
		await fireEvent.click(clickTarget(element));
		await settle();
		return { click: target, ...effects(), screen: screen(modalTestId) };
	}
	if (kind === 'hover') {
		if (!element) return { hover: target, missing: true };
		await fireEvent.mouseEnter(element);
		await settle();
		return { hover: target, ...effects(), screen: screen(modalTestId) };
	}
	const input = element?.matches('input, textarea')
		? element
		: element?.querySelector('input, textarea');
	if (!input) return { [kind]: target, missing: true };
	if (kind === 'key') {
		await fireEvent.keyDown(input, { key: value });
		await fireEvent.keyUp(input, { key: value });
		await settle();
		return { key: target, value, ...effects(), screen: screen(modalTestId) };
	}
	await fireEvent.update(input, value);
	await fireEvent.blur(input);
	await settle();
	return { type: target, text: value, ...effects(), screen: screen(modalTestId) };
}

export async function load(loader: unknown): Promise<Component> {
	if (typeof loader !== 'function') return loader as Component;
	const loaded: unknown = await (loader as () => Promise<unknown>)();
	return (isRecord(loaded) && 'default' in loaded ? loaded.default : loaded) as Component;
}

export async function mountComponent(component: Component, props: Record<string, unknown> = {}) {
	const rendered = createComponentRenderer(component, {
		global: {
			plugins: [router],
			config: {
				errorHandler: (error: unknown) => {
					vueErrors.push(String(error));
				},
				warnHandler: () => {},
			},
		},
	})({ pinia, props });
	setUnmount(rendered.unmount);
	container = rendered.container;
	await settle();
}

export async function prepare(scenario: Scenario, server: () => void) {
	vueErrors.length = 0;
	await setup({ settings: SETTINGS, ...scenario });
	// The public API answers under `/api/v1`. Its paths keep the prefix, so that the routes and
	// the log tell the two APIs apart.
	{
		const spy = vi.mocked(axios.request);
		const inner = spy.getMockImplementation() as (config: AxiosRequestConfig) => Promise<unknown>;
		spy.mockImplementation(async (config) => {
			const base = String(config.baseURL ?? '');
			if (!base.endsWith('/api/v1')) return (await inner(config)) as never;
			return (await inner({ ...config, baseURL: '', url: `/api/v1${config.url ?? ''}` })) as never;
		});
	}
	// Static files load with `axios.get`. The fake server answers them too.
	vi.spyOn(axios, 'get').mockImplementation(
		async (url: string, config?: AxiosRequestConfig) =>
			await axios.request({ ...config, url, method: 'get' }),
	);
	for (const modal of subject.PromotionsModule.modals ?? []) {
		if (!modalRegistry.has(modal.key)) modalRegistry.register(modal);
	}
	installToastRecorder();
	server();
}

// #endregion

/** A value as plain data: functions as `<function>`, and the result of the route functions. */
export function shape(value: unknown, depth = 0): unknown {
	if (typeof value === 'function') return '<function>';
	if (Array.isArray(value)) return value.map((entry) => shape(entry, depth + 1));
	if (isRecord(value)) {
		if (depth > 12) return '<deep>';
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, shape(entry, depth + 1)]),
		);
	}
	return value;
}
