// Fork test helper (not in upstream n8n): the harness of the golden tests of the evaluation
// editor. It gives a fake REST server, a router with the names and paths of the app routes,
// stores in a known state, and a description of what a user sees. See `../../FORK.md`.
import { setTelemetry, type Telemetry } from '@n8n/composables/registries/telemetryRegistry';
import { setNotify } from '@n8n/composables/useToast';
import { defaultSettings } from '@n8n/frontend-test-utils';
import { GLOBAL_SCOPE_MAP, PROJECT_SCOPE_MAP, type Scope } from '@n8n/permissions';
import type { IUserResponse } from '@n8n/rest-api-client/api/users';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import axios from 'axios';
import { deepCopy, type IConnections, type INode, type INodeTypeDescription } from 'n8n-workflow';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createApp, defineComponent, h, isProxy, isRef, provide, toRaw } from 'vue';
import {
	createMemoryHistory,
	createRouter,
	RouterView,
	type Router,
	type RouteRecordRaw,
} from 'vue-router';

import { createTestWorkflow } from '@/__tests__/mocks';
import { useWorkflowId } from '@/app/composables/useWorkflowId';
import { WorkflowIdKey } from '@/app/constants/injectionKeys';
import { routes as appRoutes } from '@/app/router';
import { useNodeTypesStore } from '@/app/stores/nodeTypes.store';
import {
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { useWorkflowsListStore } from '@/app/stores/workflowsList.store';
import { useUsersStore } from '@n8n/stores/users.store';

import nodeTypeFixtures from './node-types.json';

export let log: unknown[] = [];
export let pinia: Pinia;
export let router: Router;

// #region Recording

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

export const normalize = (text: string | null | undefined) =>
	(text ?? '').replace(/\s+/g, ' ').trim();

/** A value as plain data: refs and reactive values unwrapped, functions and errors as text. */
export function plain(value: unknown, depth = 0): unknown {
	if (depth > 10) return '<deep>';
	if (isRef(value)) return plain(value.value, depth);
	if (isProxy(value)) return plain(toRaw(value), depth);
	if (value instanceof Error) return `<${value.name}: ${value.message}>`;
	if (typeof value === 'function') return '<function>';
	if (value instanceof Date) return `<date ${value.toISOString()}>`;
	if (value instanceof Set) return { '<Set>': [...value].map((item) => plain(item, depth + 1)) };
	if (value instanceof Map) {
		return {
			'<Map>': [...value].map(([key, item]) => [plain(key, depth + 1), plain(item, depth + 1)]),
		};
	}
	if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1));
	if (isRecord(value)) {
		if ('on' in value && 'emit' in value && 'off' in value) return '<eventBus>';
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, plain(value[key], depth + 1)]),
		);
	}
	return value === undefined ? '<undefined>' : value;
}

export const oneLine = (value: unknown) => JSON.stringify(plain(value)).replaceAll('"', "'");

export function takeLog() {
	const taken = log;
	log = [];
	return taken;
}

export function record(...entry: unknown[]) {
	log.push(entry);
}

/** Lets the page finish its work. With fake timers, it moves the clock by 5 ms for each round. */
export async function settle(rounds = 30) {
	for (let index = 0; index < rounds; index++) {
		if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(5);
		else await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function isHidden(element: Element | null): boolean {
	for (let current = element; current; current = current.parentElement) {
		if (current.hasAttribute('hidden')) return true;
		if (current instanceof HTMLElement && current.style.display === 'none') return true;
	}
	return false;
}

function describeElement(element: Element) {
	const parts = [element.tagName.toLowerCase()];
	if (element instanceof HTMLInputElement) parts.push(`type=${element.type}`);
	if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') {
		parts.push('[disabled]');
	}
	if (element.getAttribute('role')) parts.push(`role=${element.getAttribute('role')}`);
	const testId = element.getAttribute('data-test-id');
	if (testId) parts.push(`#${testId}`);
	if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
		parts.push(`value=${JSON.stringify(element.value)}`);
	}
	if (element instanceof HTMLAnchorElement) parts.push(`href=${element.getAttribute('href')}`);
	const label =
		element.getAttribute('aria-label') ??
		element.getAttribute('placeholder') ??
		normalize(element.textContent);
	return `${parts.join(' ')}: ${label}`;
}

const CONTROLS =
	'button, input, textarea, a[href], [role="option"], [role="tab"], [role="checkbox"], [role="switch"], [role="slider"]';

/** What a user sees: the text, the elements with a test id, the controls and the icons. */
export function describeDom(root: Element | null) {
	if (!root) return '<none>';
	const hidden = [...root.querySelectorAll('*')]
		.filter(
			(element) =>
				isHidden(element) && !isHidden(element.parentElement) && normalize(element.textContent),
		)
		.map((element) => normalize(element.textContent));
	return {
		text: normalize(root.textContent),
		...(hidden.length ? { hidden } : {}),
		testIds: [...root.querySelectorAll('[data-test-id]')].map(
			(element) =>
				`${element.getAttribute('data-test-id')}${
					element.hasAttribute('disabled') ? ' [disabled]' : ''
				}: ${normalize(element.textContent).slice(0, 200)}`,
		),
		controls: [...root.querySelectorAll(CONTROLS)].map(describeElement),
		icons: [...root.querySelectorAll('[data-icon]')].map((element) =>
			element.getAttribute('data-icon'),
		),
	};
}

// #endregion

// #region Fake server

export class ServerError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export type Request = { method: string; path: string; params?: unknown; data?: unknown };
export type Handler = (request: Request, match: RegExpMatchArray) => unknown;

const RAW = Symbol('raw body');

/** A body that the server sends as it is, without the `data` wrapper of most routes. */
export const raw = (body: unknown) => ({ [RAW]: body });

const isRaw = (value: unknown): value is { [RAW]: unknown } =>
	typeof value === 'object' && value !== null && RAW in value;

let routes: Array<[string, RegExp, Handler]> = [];

/** Adds a route of the fake server. A later route wins over an earlier one. */
export function route(method: string, pattern: RegExp, handler: Handler) {
	routes.unshift([method, pattern, handler]);
}

function installServer() {
	routes = [];
	vi.spyOn(axios, 'request').mockImplementation(async (config) => {
		const method = (config.method ?? 'GET').toUpperCase();
		const url = config.url ?? '';
		const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
		const data: unknown = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
		log.push([
			'request',
			[
				`${method} ${path}`,
				...(config.params === undefined ? [] : [`params ${oneLine(config.params)}`]),
				...(data === undefined ? [] : [`data ${oneLine(data)}`]),
			].join(' '),
		]);
		const copy = <T>(value: T): T => (value === undefined ? value : deepCopy(value));
		const found = routes.find(
			([routeMethod, pattern]) => routeMethod === method && pattern.test(path),
		);
		try {
			if (!found) throw new ServerError(404, `No route: ${method} ${path}`);
			const match = path.match(found[1]) ?? ([] as unknown as RegExpMatchArray);
			const result = found[2]({ method, path, params: config.params, data: copy(data) }, match);
			return isRaw(result) ? { data: copy(result[RAW]) } : { data: { data: copy(result) } };
		} catch (error) {
			if (!(error instanceof ServerError)) throw error;
			throw Object.assign(new Error(error.message), {
				response: { status: error.status, data: { message: error.message, code: error.status } },
			});
		}
	});
}

// #endregion

// #region Setup

export const Empty = defineComponent({ render: () => null });

type AnyRoute = { path: string; name?: unknown; children?: AnyRoute[] };

/** The names and paths of the app routes, with empty components and without guards. */
function namedRoutes(skipPath: string): RouteRecordRaw[] {
	const copy = (record: AnyRoute): RouteRecordRaw | undefined => {
		if (record.path === skipPath) return undefined;
		const children = (record.children ?? [])
			.map(copy)
			.filter((child): child is RouteRecordRaw => !!child);
		return {
			path: record.path,
			...(typeof record.name === 'string' ? { name: record.name } : {}),
			component: Empty,
			...(children.length ? { children } : {}),
		} as RouteRecordRaw;
	};
	return (appRoutes as AnyRoute[]).map(copy).filter((item): item is RouteRecordRaw => !!item);
}

export type Scenario = {
	/** Routes under test. They replace the app route with the same path. */
	routes?: RouteRecordRaw[];
	path?: string;
	settings?: Record<string, unknown>;
	evaluation?: Partial<(typeof defaultSettings)['evaluation']>;
	role?: 'global:owner' | 'global:admin' | 'global:member';
	projectRole?: 'project:admin' | 'project:editor' | 'project:viewer';
};

let unmountLast: (() => void) | undefined;
export function setUnmount(unmount: () => void) {
	unmountLast = unmount;
}

export function unmountPrevious() {
	const unmount = unmountLast;
	unmountLast = undefined;
	// The timers of the previous page (for example its polling) must not reach the next page.
	if (vi.isFakeTimers()) vi.clearAllTimers();
	try {
		unmount?.();
	} catch {
		// After an error in a render, Vue cannot unmount the tree.
	}
	for (const element of [...document.body.children]) {
		if (element.id === 'app-grid' || element.id === 'app-modals') {
			element.replaceChildren();
		} else if (!element.id.startsWith('el-popper-container')) {
			element.remove();
		}
	}
}

/**
 * Unmounts the last page of a test file. Some components (the tables of Element Plus) start a
 * real timer of their own, so the file waits until those timers end, while the DOM is still there.
 */
export async function finishPages() {
	unmountPrevious();
	vi.useRealTimers();
	await new Promise((resolve) => setTimeout(resolve, 200));
}

export async function setup(scenario: Scenario = {}) {
	unmountPrevious();
	pinia = createPinia();
	setActivePinia(pinia);
	const tested = scenario.routes ?? [];
	router = createRouter({
		history: createMemoryHistory(),
		routes: [...tested, ...namedRoutes(tested[0]?.path ?? '')],
	});
	router.afterEach((to) => {
		log.push(['navigate', to.fullPath]);
	});
	await router.push(scenario.path ?? '/');
	createApp(Empty).use(router).use(pinia);

	installServer();

	useSettingsStore().setSettings({
		...defaultSettings,
		...scenario.settings,
		evaluation: { ...defaultSettings.evaluation, ...scenario.evaluation },
	});
	const role = scenario.role ?? 'global:owner';
	const scopes: Scope[] = GLOBAL_SCOPE_MAP[role];
	const usersStore = useUsersStore();
	const currentUser: IUserResponse = {
		id: 'u-1',
		email: 'user@example.com',
		role,
		firstName: 'Test',
		lastName: 'User',
		isPending: false,
		globalScopes: scopes,
	};
	usersStore.addUsers([currentUser]);
	usersStore.currentUserId = currentUser.id;
	useRBACStore().setGlobalScopes(scopes);
	for (const scope of scenario.projectRole ? PROJECT_SCOPE_MAP[scenario.projectRole] : []) {
		useRBACStore().addProjectScope(scope, { projectId: 'p1' });
	}
	log = [];
}

/** Toasts, telemetry and new windows go to the log. */
export function installRecorders() {
	setNotify((options) => {
		log.push(['toast', plain(options)]);
		return { close() {} };
	});
	const recordCall =
		(kind: string) =>
		(...args: unknown[]) => {
			log.push([`telemetry.${kind}`, plain(args)]);
		};
	const telemetry: Telemetry = {
		init() {},
		identify() {},
		track: recordCall('track'),
		page() {},
		reset() {},
		flushPageEvents() {},
		trackAskAI: recordCall('trackAskAI'),
		trackAiTransform: recordCall('trackAiTransform'),
		trackNodeParametersValuesChange: recordCall('trackNodeParametersValuesChange'),
	};
	setTelemetry(telemetry);
	vi.spyOn(window, 'open').mockImplementation((...args) => {
		log.push(['window.open', plain(args)]);
		return null;
	});
}

/** The router view of the app, with the workflow ID that App.vue provides. */
export const RouteHost = defineComponent({
	setup() {
		provide(WorkflowIdKey, useWorkflowId());
		return () => h(RouterView);
	},
});

// #endregion

// #region The current workflow and the node types

/** Makes a saved workflow the current workflow of the editor. */
export function setWorkflow(workflow: {
	id: string;
	name?: string;
	nodes: INode[];
	connections: IConnections;
	versionId?: string;
}) {
	const full = createTestWorkflow({ name: 'Evaluated', ...workflow });
	useWorkflowsStore().setWorkflowId(workflow.id);
	// A workflow in the list store is a saved workflow.
	useWorkflowsListStore().addWorkflow(full);
	useWorkflowDocumentStore(createWorkflowDocumentId(workflow.id)).hydrate(full);
	return full;
}

/**
 * Loads node type descriptions into the node types store. `node-types.json` holds the built
 * descriptions of the Evaluation nodes, the manual trigger, the AI Agent (version 3) and the
 * OpenAI chat model, with their full names. `../../FORK.md` tells how to make it again.
 */
export function loadNodeTypes(names: string[]) {
	const wanted = new Set(names);
	const descriptions = nodeTypeFixtures as unknown as INodeTypeDescription[];
	useNodeTypesStore().setNodeTypes(
		descriptions.filter((description) => wanted.has(description.name)),
	);
}

// #endregion

// #region Outline

/** An indented outline of the DOM: tags, test ids, roles, design-system classes and own text. */
export function outline(root: Element | null, maxLines = 400): string[] {
	const lines: string[] = [];
	const walk = (element: Element, depth: number) => {
		if (lines.length >= maxLines) return;
		const ownText = normalize(
			[...element.childNodes]
				.filter((child) => child.nodeType === 3)
				.map((child) => child.textContent)
				.join(' '),
		);
		const testId = element.getAttribute('data-test-id');
		const role = element.getAttribute('role');
		const designClasses = [...element.classList]
			.filter((name) => /^(n8n-|el-)/.test(name))
			.slice(0, 3);
		const tag = element.tagName.toLowerCase();
		const interesting =
			testId ||
			role ||
			ownText ||
			designClasses.length ||
			/^(button|a|input|textarea|table|th|td|h[1-6]|svg|canvas)$/.test(tag);
		const label = [
			tag,
			testId ? `#${testId}` : '',
			role ? `role=${role}` : '',
			designClasses.length ? `.${designClasses.join('.')}` : '',
			element.getAttribute('data-icon') ? `icon=${element.getAttribute('data-icon')}` : '',
			isHidden(element) ? '[hidden]' : '',
			ownText ? `"${ownText.slice(0, 120)}"` : '',
		]
			.filter(Boolean)
			.join(' ');
		if (interesting) lines.push(`${'  '.repeat(depth)}${label}`);
		if (tag === 'svg') return;
		for (const child of element.children) walk(child, interesting ? depth + 1 : depth);
	};
	if (root) walk(root, 0);
	return lines;
}

// #endregion
