// Fork test (not in upstream n8n): the variables of the editor as black boxes: the constants, the
// store (`useEnvironmentsStore`), the completions of `$vars`, the usage badge and the variable
// modal. The test runs them against a fake server. The snapshot records the requests, the store
// state and getters, the completions, what a user sees in the badge and in the modal, the toasts,
// the telemetry and the clipboard. It records no markup and no styles. `../FORK.md` tells how the
// fork made the snapshot.
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { setTelemetry, type Telemetry } from '@n8n/composables/registries/telemetryRegistry';
import { setNotify } from '@n8n/composables/useToast';
import { defaultSettings } from '@n8n/frontend-test-utils';
import { GLOBAL_SCOPE_MAP, PROJECT_SCOPE_MAP, type Scope } from '@n8n/permissions';
import type { IUserResponse } from '@n8n/rest-api-client/api/users';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';
import { fireEvent } from '@testing-library/vue';
import axios from 'axios';
import { ElMessageBox } from 'element-plus';
import { jsonParse } from 'n8n-workflow';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createApp, defineComponent, h, isProxy, onMounted, toRaw, type PropType } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

import { createComponentRenderer } from '@/__tests__/render';
import ModalRoot from '@/app/components/ModalRoot.vue';
import { useUIStore } from '@/app/stores/ui.store';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import type { Project, ProjectListItem } from '@/features/collaboration/projects/projects.types';

// The code under test. `../FORK.md` tells how to record the snapshot against the original files.
import * as completionsModule from '@/features/settings/environments/completions/variables.completions';
import VariableModal from '@/features/settings/environments/components/VariableModal.vue';
import VariablesUsageBadge from '@/features/settings/environments/components/VariablesUsageBadge.vue';
import * as constantsModule from '@/features/settings/environments/environments.constants';
import * as storeModule from '@/features/settings/environments/environments.store';
import type { VariableModalOptions } from '@/features/settings/environments/environments.types';

const { useEnvironmentsStore } = storeModule;
const { VARIABLE_MODAL_KEY } = constantsModule;

const copies = vi.hoisted(() => ({ log: [] as unknown[] }));

vi.mock('@n8n/composables/useClipboard', async () => {
	const { ref } = await import('vue');
	return {
		useClipboard: () => ({
			copy: async (value: unknown) => {
				copies.log.push(['copy', typeof value === 'function' ? '<function>' : value]);
			},
			copied: ref(false),
			isSupported: ref(true),
			text: ref(''),
		}),
	};
});

// #region Recording

let log: unknown[] = [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

const normalize = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** A value as plain data: the raw object of a reactive value, functions and errors as text. */
function plain(value: unknown, depth = 0): unknown {
	if (depth > 8) return '<deep>';
	if (isProxy(value)) return plain(toRaw(value), depth);
	if (value instanceof Error) {
		const { httpStatusCode } = value as Error & { httpStatusCode?: unknown };
		return `<${value.name}: ${value.message}${httpStatusCode ? ` (${String(httpStatusCode)})` : ''}>`;
	}
	if (typeof value === 'function') return '<function>';
	if (value instanceof Date) return `<date ${value.toISOString()}>`;
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

/** A value as one line of JSON, with single quotes, so that the snapshot stays readable. */
const oneLine = (value: unknown) => JSON.stringify(plain(value)).replaceAll('"', "'");

function takeLog() {
	const taken = [...log, ...copies.log];
	log = [];
	copies.log = [];
	return taken;
}

async function settle() {
	for (let index = 0; index < 8; index++) await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * The visible text of an element as a list of its text nodes, so that the whitespace between
 * elements does not count.
 */
function textOf(element: Element) {
	const parts: string[] = [];
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = normalize(node.textContent);
		if (text) parts.push(text);
	}
	return parts.join(' | ');
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
	if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
		parts.push(`value=${JSON.stringify(element.value)}`);
		if (element.maxLength > 0) parts.push(`maxlength=${element.maxLength}`);
	}
	if (element instanceof HTMLAnchorElement) parts.push(`href=${element.getAttribute('href')}`);
	const label =
		element.getAttribute('aria-label') ?? element.getAttribute('placeholder') ?? textOf(element);
	return `${parts.join(' ')}: ${label}`;
}

/** What a user sees: the text, the elements with a test id, the controls and the icons. */
function describeDom(root: Element | null) {
	if (!root) return '<none>';
	const hidden = [...root.querySelectorAll('*')]
		.filter((element) => isHidden(element) && !isHidden(element.parentElement) && textOf(element))
		.map(textOf);
	return {
		text: textOf(root),
		...(hidden.length ? { hidden } : {}),
		testIds: [...root.querySelectorAll('[data-test-id]')].map(
			(element) =>
				`${element.getAttribute('data-test-id')}${
					element.hasAttribute('disabled') ? ' [disabled]' : ''
				}: ${textOf(element)}`,
		),
		controls: [...root.querySelectorAll('button, input, textarea, a[href], [role="option"]')].map(
			describeElement,
		),
		icons: [...root.querySelectorAll('[data-icon]')].map((element) =>
			element.getAttribute('data-icon'),
		),
	};
}

// #endregion

// #region Fake server

type Request = { method: string; path: string; params?: unknown; data?: unknown };

class ServerError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const server = {
	variables: [] as Array<Record<string, unknown>>,
	myProjects: [] as ProjectListItem[],
	projects: [] as ProjectListItem[],
	nextId: 1,
	failures: new Set<string>(),
};

function serverVariables() {
	return [
		{ id: 'v1', key: 'GLOBAL', value: 'global value', type: 'string', project: null },
		{ id: 'v2', key: 'EMPTY', value: '', type: 'string', project: null },
		{ id: 'v3', key: 'SHARED', value: 'global shared', type: 'string', project: null },
		{
			id: 'v4',
			key: 'IN_A',
			value: 'value in A',
			type: 'string',
			project: { id: 'pA', name: 'Project A' },
		},
		{
			id: 'v5',
			key: 'SHARED',
			value: 'shared in A',
			type: 'string',
			project: { id: 'pA', name: 'Project A' },
		},
		{
			id: 'v6',
			key: 'IN_B',
			value: 'value in B',
			type: 'string',
			project: { id: 'pB', name: 'Project B' },
		},
	];
}

function handle(request: Request): unknown {
	const key = `${request.method} ${request.path}`;
	if (server.failures.has(key) || server.failures.has(request.method)) {
		throw new ServerError(400, 'The server failed');
	}
	const byId = request.path.match(/^\/variables\/([^/]+)$/);
	if (request.method === 'GET' && request.path === '/projects/my-projects')
		return server.myProjects;
	const projectById = request.path.match(/^\/projects\/([^/]+)$/);
	if (request.method === 'GET' && projectById) {
		const found = server.projects.find((item) => item.id === projectById[1]);
		if (!found) throw new ServerError(404, 'Project not found');
		return { ...found, relations: [] };
	}
	if (request.method === 'GET' && request.path === '/variables') return server.variables;
	if (request.method === 'GET' && byId) {
		const found = server.variables.find((variable) => variable.id === byId[1]);
		if (!found) throw new ServerError(404, 'Variable not found');
		return found;
	}
	if (request.method === 'POST' && request.path === '/variables') {
		const body = isRecord(request.data) ? request.data : {};
		const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
		const created = {
			id: `new${server.nextId++}`,
			key: body.key,
			value: body.value,
			type: 'string',
			project: projectId ? { id: projectId, name: `Name of ${projectId}` } : null,
		};
		server.variables.push(created);
		return created;
	}
	if (request.method === 'PATCH' && byId) {
		const found = server.variables.find((variable) => variable.id === byId[1]);
		if (!found) throw new ServerError(404, 'Variable not found');
		const body = isRecord(request.data) ? request.data : {};
		Object.assign(found, body);
		if ('projectId' in body) {
			found.project =
				typeof body.projectId === 'string'
					? { id: body.projectId, name: `Name of ${body.projectId}` }
					: null;
			delete found.projectId;
		}
		return found;
	}
	if (request.method === 'DELETE' && byId) {
		server.variables = server.variables.filter((variable) => variable.id !== byId[1]);
		return true;
	}
	throw new ServerError(404, `Not found: ${key}`);
}

function installServer() {
	vi.spyOn(axios, 'request').mockImplementation(async (config) => {
		const method = (config.method ?? 'GET').toUpperCase();
		const url = config.url ?? '';
		const path = url.split('?')[0];
		// As over HTTP: the server and the page never share objects, and a value that JSON does not
		// have (for example `undefined`) does not arrive.
		const copy = <T>(value: T): T =>
			value === undefined ? value : jsonParse<T>(JSON.stringify(value));
		log.push([
			'request',
			[
				`${method} ${url}`,
				...(config.params === undefined ? [] : [`params ${oneLine(copy(config.params))}`]),
				...(config.data === undefined ? [] : [`data ${oneLine(copy(config.data))}`]),
			].join(' '),
		]);
		try {
			return {
				data: {
					data: copy(handle({ method, path, params: config.params, data: copy(config.data) })),
				},
			};
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

const Empty = defineComponent({ render: () => null });

const USERS = {
	owner: { id: 'u-owner', email: 'owner@example.com', role: 'global:owner' as const },
	admin: { id: 'u-admin', email: 'admin@example.com', role: 'global:admin' as const },
	member: { id: 'u-member', email: 'member@example.com', role: 'global:member' as const },
};

type ProjectRoleName = 'project:admin' | 'project:editor' | 'project:viewer' | 'none';

type Scenario = {
	user?: keyof typeof USERS;
	licensed?: boolean;
	/** The role of the user in project A and in project B. */
	roleInA?: ProjectRoleName;
	roleInB?: ProjectRoleName;
	route?: string;
	currentProject?: 'pA' | 'pB' | 'personal' | null;
};

let pinia: Pinia;
let router: Router;
let unmountLast: (() => void) | undefined;
let confirmAnswers: string[] = [];

function project(id: string, name: string, role: ProjectRoleName): ProjectListItem {
	return {
		id,
		name,
		type: 'team',
		icon: null,
		role: role === 'none' ? 'project:viewer' : role,
		scopes: role === 'none' ? [] : PROJECT_SCOPE_MAP[role],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	} as ProjectListItem;
}

async function setup(scenario: Scenario = {}) {
	unmountPrevious();
	pinia = createPinia();
	setActivePinia(pinia);
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/', component: Empty },
			{ path: '/home/variables', component: Empty },
			{ path: '/projects/:projectId/variables', component: Empty },
			{ path: '/workflow/:name', component: Empty },
		],
	});
	await router.push(scenario.route ?? '/home/variables');
	createApp(Empty).use(router).use(pinia);

	server.variables = serverVariables();
	server.myProjects = [];
	server.projects = [];
	server.nextId = 1;
	confirmAnswers = [];
	server.failures = new Set();
	installServer();

	const settingsStore = useSettingsStore();
	settingsStore.setSettings({
		...defaultSettings,
		enterprise: { ...defaultSettings.enterprise, variables: scenario.licensed ?? true },
	});
	const user = USERS[scenario.user ?? 'owner'];
	const scopes: Scope[] = GLOBAL_SCOPE_MAP[user.role];
	const usersStore = useUsersStore();
	const currentUser: IUserResponse = {
		...user,
		firstName: 'Test',
		lastName: 'User',
		isPending: false,
		globalScopes: scopes,
	};
	usersStore.addUsers([currentUser]);
	usersStore.currentUserId = user.id;
	useRBACStore().setGlobalScopes(scopes);

	const projects = [
		project('pA', 'Project A', scenario.roleInA ?? 'none'),
		project('pB', 'Project B', scenario.roleInB ?? 'none'),
	];
	const personal = {
		...project('personal', 'Test User <owner@example.com>', 'project:admin'),
		type: 'personal',
		role: 'project:personalOwner',
		scopes: PROJECT_SCOPE_MAP['project:personalOwner'],
	} as ProjectListItem;
	const roles = [scenario.roleInA, scenario.roleInB];
	// The server knows the projects before the projects store starts: the store reads the project
	// of the route when it starts.
	server.projects = [...projects, personal];
	server.myProjects = [
		...projects.filter((_, index) => roles[index] && roles[index] !== 'none'),
		personal,
	];
	const projectsStore = useProjectsStore();
	projectsStore.projects = server.projects;
	projectsStore.myProjects = server.myProjects;
	projectsStore.personalProject = personal as unknown as Project;
	if (scenario.currentProject) {
		const current = [...projects, personal].find((item) => item.id === scenario.currentProject);
		projectsStore.currentProject = current as unknown as Project;
	}
	log = [];
	copies.log = [];
}

function unmountPrevious() {
	const unmount = unmountLast;
	unmountLast = undefined;
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

/** The state and the getters of the store. */
function storeState() {
	const store = useEnvironmentsStore();
	return plain({
		variables: store.variables,
		variablesAsObject: store.variablesAsObject,
		scopedVariables: store.scopedVariables,
	});
}

beforeEach(() => {
	setNotify((options) => {
		log.push(['toast', plain(options)]);
		return { close() {} };
	});
	const record =
		(kind: string) =>
		(...args: unknown[]) => {
			log.push([`telemetry.${kind}`, plain(args)]);
		};
	const telemetry: Telemetry = {
		init() {},
		identify() {},
		track: record('track'),
		page() {},
		reset() {},
		flushPageEvents() {},
		trackAskAI: record('trackAskAI'),
		trackAiTransform: record('trackAiTransform'),
		trackNodeParametersValuesChange: record('trackNodeParametersValuesChange'),
	};
	setTelemetry(telemetry);
	const recordBox =
		(kind: string) =>
		async (message: unknown, ...rest: unknown[]) => {
			const answer = kind === 'confirm' ? (confirmAnswers.shift() ?? 'confirm') : 'confirm';
			log.push([kind, plain({ message, rest, answer })]);
			if (answer === 'confirm') return 'confirm' as never;
			throw answer;
		};
	vi.spyOn(ElMessageBox, 'confirm').mockImplementation(recordBox('confirm'));
	vi.spyOn(ElMessageBox, 'alert').mockImplementation(recordBox('alert'));
	vi.spyOn(ElMessageBox, 'prompt').mockImplementation(recordBox('prompt'));
	Object.defineProperty(window.navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				log.push(['clipboard.writeText', text]);
			},
		},
	});
});

afterEach(() => {
	unmountPrevious();
	vi.restoreAllMocks();
});

// #endregion

describe('the modules', () => {
	test('export these names and constants', async () => {
		await setup();
		const store = useEnvironmentsStore();

		expect({
			constants: plain({ ...constantsModule }),
			store: Object.keys(storeModule).sort(),
			defaultExportIsTheStore: storeModule.default === storeModule.useEnvironmentsStore,
			storeId: store.$id,
			storeMembers: Object.keys(store)
				.filter((key) => !key.startsWith('$') && !key.startsWith('_'))
				.sort()
				.map((key) => `${key}: ${typeof (store as unknown as Record<string, unknown>)[key]}`),
			completions: Object.keys(completionsModule).sort(),
		}).toMatchSnapshot();
	});
});

describe('the store', () => {
	test('fetches, deletes and resolves the variables', async () => {
		await setup();
		const store = useEnvironmentsStore();
		const steps: Record<string, unknown> = {};

		steps.initial = storeState();
		steps.fetch = {
			result: plain(await store.fetchAllVariables()),
			calls: takeLog(),
			state: storeState(),
		};
		steps.delete = {
			result: plain(await store.deleteVariable({ id: 'v2', key: 'EMPTY', value: '' })),
			calls: takeLog(),
			state: storeState(),
		};
		server.failures.add('GET');
		try {
			steps.failedFetch = { result: plain(await store.fetchAllVariables()) };
		} catch (error) {
			steps.failedFetch = { error: plain(error) };
		}
		steps.failedFetchCalls = takeLog();
		steps.stateAfterFailedFetch = storeState();
		server.failures.add('DELETE');
		try {
			steps.failedDelete = {
				result: plain(
					await store.deleteVariable({ id: 'v1', key: 'GLOBAL', value: 'global value' }),
				),
			};
		} catch (error) {
			steps.failedDelete = { error: plain(error) };
		}
		steps.failedDeleteCalls = takeLog();
		steps.stateAfterFailedDelete = storeState();

		expect(steps).toMatchSnapshot();
	});

	test('creates and updates variables, and gets the variables of a scope', async () => {
		await setup({ roleInA: 'project:admin' });
		const store = useEnvironmentsStore();
		await store.fetchAllVariables();
		takeLog();
		// The store takes the arguments that the modal gives it.
		const call = async (run: () => Promise<unknown>) => {
			try {
				return { result: plain(await run()), calls: takeLog(), state: storeState() };
			} catch (error) {
				return { error: plain(error), calls: takeLog(), state: storeState() };
			}
		};
		const steps: Record<string, unknown> = {};

		steps.createGlobal = await call(
			async () => await store.createVariable({ key: 'NEW', value: 'new' } as never),
		);
		steps.createInA = await call(
			async () =>
				await store.createVariable({ key: 'NEW_A', value: 'a', projectId: 'pA' } as never),
		);
		steps.createInUnknownProject = await call(
			async () =>
				await store.createVariable({ key: 'NEW_Z', value: 'z', projectId: 'pZ' } as never),
		);
		steps.updateGlobal = await call(
			async () =>
				await store.updateVariable({ id: 'v1', key: 'GLOBAL', value: 'changed' } as never),
		);
		steps.updateInA = await call(
			async () =>
				await store.updateVariable({
					id: 'v4',
					key: 'IN_A',
					value: 'changed in A',
					projectId: 'pA',
				} as never),
		);
		steps.moveToB = await call(
			async () =>
				await store.updateVariable({
					id: 'v4',
					key: 'IN_A',
					value: 'moved',
					projectId: 'pB',
				} as never),
		);
		server.failures.add('POST');
		steps.failedCreate = await call(
			async () => await store.createVariable({ key: 'FAILS', value: 'x' } as never),
		);
		server.failures.add('PATCH');
		steps.failedUpdate = await call(
			async () => await store.updateVariable({ id: 'v1', key: 'GLOBAL', value: 'x' } as never),
		);
		steps.inScope = Object.fromEntries(
			Object.entries({
				none: [],
				undefined: [undefined],
				null: [null],
				empty: [''],
				pA: ['pA'],
				pB: ['pB'],
				unknown: ['unknown'],
			}).map(([name, args]) => [
				name,
				plain((store.getVariablesInScope as (...values: unknown[]) => unknown)(...args)),
			]),
		);

		expect(steps).toMatchSnapshot();
	});

	test.each([
		['no current project', {}],
		['current project A', { currentProject: 'pA' }],
		['current project B', { currentProject: 'pB' }],
		['route of project A', { route: '/projects/pA/variables' }],
		[
			'route of project A, current project B',
			{ route: '/projects/pA/variables', currentProject: 'pB' },
		],
		['query of project A', { route: '/workflow/new?projectId=pA' }],
		['personal project', { currentProject: 'personal' }],
	] as Array<[string, Scenario]>)('resolves the variables with %s', async (_name, scenario) => {
		await setup(scenario);
		const store = useEnvironmentsStore();
		await store.fetchAllVariables();
		takeLog();

		expect(storeState()).toMatchSnapshot();
	});
});

describe('the completions', () => {
	const context = (doc: string, explicit = false) =>
		new CompletionContext(EditorState.create({ doc }), doc.length, explicit);

	test('add the variable type, and complete $vars', async () => {
		await setup({ currentProject: 'pA' });
		await useEnvironmentsStore().fetchAllVariables();
		takeLog();
		const { addVarType, useVariablesCompletions } = completionsModule;
		const { variablesCompletions } = useVariablesCompletions();
		const complete = (doc: string, matcher?: string) => {
			try {
				return plain(
					matcher
						? variablesCompletions(context(doc), matcher)
						: variablesCompletions(context(doc)),
				);
			} catch (error) {
				return { error: plain(error) };
			}
		};

		expect({
			addVarType: [
				plain(addVarType({ label: 'a' })),
				plain(addVarType({ label: 'b', type: 'keyword', info: 'info' })),
			],
			dot: complete('$vars.'),
			partial: complete('$vars.SH'),
			noDot: complete('$vars'),
			other: complete('$json.'),
			inCode: complete('const x = $vars.'),
			matcher: complete('myVars.', 'myVars'),
			calls: takeLog(),
		}).toMatchSnapshot();
	});

	test('complete $vars without variables', async () => {
		await setup();
		server.variables = [];
		await useEnvironmentsStore().fetchAllVariables();
		takeLog();
		const { variablesCompletions } = completionsModule.useVariablesCompletions();

		expect(plain(variablesCompletions(context('$vars.')))).toMatchSnapshot();
	});
});

describe('the usage badge', () => {
	test('shows the usage syntax, and copies it', async () => {
		await setup();
		const rendered = createComponentRenderer(VariablesUsageBadge, {
			global: { plugins: [router] },
		})({ pinia, props: { name: 'MY_VAR' } });
		unmountLast = rendered.unmount;
		await settle();
		const records: Record<string, unknown> = {};

		const tooltips = () =>
			[...document.querySelectorAll('[role="tooltip"]')]
				.filter((tooltip) => !isHidden(tooltip))
				.map((tooltip) => normalize(tooltip.textContent));
		records.shown = { dom: describeDom(rendered.container), tooltips: tooltips() };
		// The element that holds the text, as a user points at it.
		const textElement =
			[...rendered.container.querySelectorAll('*')]
				.reverse()
				.find((element) => normalize(element.textContent) === '$vars.MY_VAR') ?? rendered.container;
		await fireEvent.mouseEnter(textElement);
		await new Promise((resolve) => setTimeout(resolve, 300));
		records.hovered = { tooltips: tooltips(), calls: takeLog() };
		await fireEvent.click(textElement);
		await new Promise((resolve) => setTimeout(resolve, 300));
		records.clicked = {
			dom: describeDom(rendered.container),
			tooltips: tooltips(),
			calls: takeLog(),
		};

		expect(records).toMatchSnapshot();
	});
});

// #region The modal

const modalApi: { close?: () => Promise<void>; props?: () => unknown } = {};

/** In place of the ordinary `Modal`: the same close logic, and it records the props it gets. */
const ModalStub = defineComponent({
	name: 'ModalStub',
	props: {
		name: { type: String, required: true },
		title: String,
		subtitle: String,
		eventBus: Object,
		showClose: { type: Boolean, default: true },
		loading: Boolean,
		classic: Boolean,
		beforeClose: Function as PropType<() => unknown>,
		customClass: String,
		center: { type: Boolean, default: true },
		width: String,
		minWidth: String,
		maxWidth: String,
		height: String,
		minHeight: String,
		maxHeight: String,
		scrollable: Boolean,
		centerTitle: Boolean,
		closeOnClickModal: { type: Boolean, default: true },
		closeOnPressEscape: { type: Boolean, default: true },
		appendToBody: Boolean,
	},
	setup(props, { slots }) {
		const uiStore = useUIStore();
		async function closeDialog() {
			if (props.beforeClose) {
				const shouldClose = await props.beforeClose();
				if (shouldClose === false) return;
			}
			uiStore.closeModal(props.name);
			(props.eventBus as { emit?: (event: string) => void } | undefined)?.emit?.('closed');
		}
		onMounted(() => {
			(props.eventBus as { on?: (event: string, fn: () => void) => void } | undefined)?.on?.(
				'close',
				() => {
					closeDialog().catch((error: unknown) => log.push(['close error', plain(error)]));
				},
			);
			modalApi.close = closeDialog;
			modalApi.props = () => plain({ ...props });
		});
		return () =>
			h('div', { role: 'dialog', 'data-test-id': `${props.name}-modal` }, [
				slots.header ? slots.header({ closeDialog }) : props.title ? h('h1', props.title) : null,
				props.loading ? h('div', 'loading') : slots.content?.(),
				!props.loading && slots.footer ? slots.footer({ close: closeDialog }) : null,
			]);
	},
});

const Host = defineComponent({
	name: 'VariableModalHost',
	setup() {
		return () =>
			h(ModalRoot, { name: VARIABLE_MODAL_KEY }, {
				default: ({ data }: { data: VariableModalOptions }) => h(VariableModal, data),
			} as never);
	},
});

const errorHandler = (error: unknown) => {
	log.push(['vue error', plain(error)]);
};

async function openModal(scenario: Scenario, data: Record<string, unknown>) {
	await setup(scenario);
	await useEnvironmentsStore().fetchAllVariables();
	takeLog();
	useUIStore().openModalWithData({ name: VARIABLE_MODAL_KEY, data });
	const rendered = createComponentRenderer(Host, {
		global: { stubs: { Modal: ModalStub }, plugins: [router], config: { errorHandler } },
	})({ pinia });
	unmountLast = rendered.unmount;
	await settle();
	return rendered;
}

const modalRoot = () => document.querySelector(`[data-test-id="${VARIABLE_MODAL_KEY}-modal"]`);

/** The element with the focus: the test id of its closest element with one, and its tag. */
function focused() {
	const active = document.activeElement;
	if (!active || active === document.body) return '<body>';
	const owner = active.closest('[data-test-id]');
	return `${active.tagName.toLowerCase()} in ${owner?.getAttribute('data-test-id') ?? '<none>'}`;
}

function checkpoint() {
	return {
		dom: describeDom(modalRoot()),
		focus: focused(),
		open: useUIStore().modalsById[VARIABLE_MODAL_KEY]?.open ?? false,
		modal: modalApi.props?.(),
		calls: takeLog(),
	};
}

function field(testId: string) {
	return document.querySelector(`[data-test-id="${testId}"]`)?.querySelector('input, textarea');
}

async function type(testId: string, value: string) {
	const input = field(testId);
	if (!input) {
		log.push(['missing field', testId]);
		return;
	}
	await fireEvent.update(input, value);
	await fireEvent.blur(input);
	await settle();
}

async function clickTestId(testId: string) {
	const element = document.querySelector(`[data-test-id="${testId}"]`);
	if (!element) {
		log.push(['missing element', testId]);
		return;
	}
	await fireEvent.click(element);
	await settle();
}

function buttonByText(text: string) {
	return [...(modalRoot()?.querySelectorAll('button') ?? [])].find(
		(button) => normalize(button.textContent) === text,
	);
}

async function openSelect(root: Element | null) {
	const input = root?.querySelector('input');
	if (!input) return '<no select>';
	await fireEvent.click(input);
	await settle();
	return [...document.querySelectorAll('[role="option"], .el-select-dropdown__item')]
		.filter((option) => !isHidden(option))
		.map(
			(option) =>
				`${normalize(option.textContent)}${
					option.classList.contains('is-disabled') ||
					option.getAttribute('aria-disabled') === 'true'
						? ' [disabled]'
						: ''
				}${option.classList.contains('is-selected') || option.getAttribute('aria-selected') === 'true' ? ' [selected]' : ''}`,
		);
}

describe('the variable modal', () => {
	test('creates a global variable', async () => {
		await openModal({}, { mode: 'new' });
		const steps: Record<string, unknown> = {};

		steps.opened = checkpoint();
		await type('variable-modal-key-input', 'NEW_KEY');
		steps.key = checkpoint();
		await type('variable-modal-value-input', 'new value');
		steps.value = checkpoint();
		await clickTestId('variable-modal-save-button');
		steps.saved = { ...checkpoint(), state: storeState() };

		expect(steps).toMatchSnapshot();
	});

	test('checks the key and the value', async () => {
		await openModal({}, { mode: 'new' });
		const steps: Record<string, unknown> = {};

		for (const [name, key] of [
			['empty', ''],
			['invalidCharacter', 'BAD$KEY'],
			['startsWithNumber', '1KEY'],
			['dash', 'BAD-KEY'],
			['space', 'BAD KEY'],
			['long', 'K'.repeat(51)],
			['max', 'M'.repeat(50)],
			['existingGlobal', 'GLOBAL'],
			['existingInA', 'IN_A'],
			['lowercase', 'lower_case'],
		]) {
			await type('variable-modal-key-input', key);
			steps[name] = checkpoint();
		}
		await type('variable-modal-key-input', 'GOOD');
		await type('variable-modal-value-input', 'v'.repeat(1001));
		steps.longValue = checkpoint();
		await type('variable-modal-value-input', '');
		steps.emptyValue = checkpoint();

		expect(steps).toMatchSnapshot();
	});

	test('chooses the scope', async () => {
		await openModal({ roleInA: 'project:admin' }, { mode: 'new' });
		const steps: Record<string, unknown> = {};

		steps.opened = checkpoint();
		steps.options = await openSelect(
			document.querySelector('[data-test-id="variable-modal-scope-select"]'),
		);
		steps.afterOpen = checkpoint();
		const option = [
			...document.querySelectorAll('[role="option"], .el-select-dropdown__item'),
		].find((item) => normalize(item.textContent) === 'Project A');
		if (option) await fireEvent.click(option);
		await settle();
		steps.chosen = checkpoint();
		await type('variable-modal-key-input', 'SHARED');
		steps.sharedKeyInA = checkpoint();
		await type('variable-modal-key-input', 'IN_A');
		steps.existingKeyInA = checkpoint();
		await type('variable-modal-key-input', 'NEW_IN_A');
		await type('variable-modal-value-input', 'in A');
		await clickTestId('variable-modal-save-button');
		steps.saved = { ...checkpoint(), state: storeState() };

		expect(steps).toMatchSnapshot();
	});

	test.each([
		['an owner', {}],
		['a member', { user: 'member' }],
		['a member who is admin of project A', { user: 'member', roleInA: 'project:admin' }],
		['a member who is editor of project A', { user: 'member', roleInA: 'project:editor' }],
		['a member who is viewer of project A', { user: 'member', roleInA: 'project:viewer' }],
		['an admin, unlicensed', { user: 'admin', licensed: false }],
	] as Array<[string, Scenario]>)('shows the scopes to %s', async (_name, scenario) => {
		await openModal(scenario, { mode: 'new' });

		expect({
			opened: checkpoint(),
			options: await openSelect(
				document.querySelector('[data-test-id="variable-modal-scope-select"]'),
			),
		}).toMatchSnapshot();
	});

	test('warns about a key of a global variable in a project', async () => {
		await openModal({ roleInA: 'project:admin' }, { mode: 'new' });
		const steps: Record<string, unknown> = {};

		await openSelect(document.querySelector('[data-test-id="variable-modal-scope-select"]'));
		const option = [
			...document.querySelectorAll('[role="option"], .el-select-dropdown__item'),
		].find((item) => normalize(item.textContent) === 'Project A');
		if (option) await fireEvent.click(option);
		await settle();
		await type('variable-modal-key-input', 'GLOBAL');
		steps.globalKeyInA = checkpoint();
		await type('variable-modal-value-input', 'overrides');
		await clickTestId('variable-modal-save-button');
		steps.saved = { ...checkpoint(), state: storeState() };

		expect(steps).toMatchSnapshot();
	});

	test('submits with the Enter key, and asks before it closes with changes', async () => {
		await openModal({}, { mode: 'new' });
		const steps: Record<string, unknown> = {};

		await type('variable-modal-key-input', 'TYPED');
		confirmAnswers = ['cancel'];
		await modalApi.close?.();
		await settle();
		steps.closeWithChangesCancelled = checkpoint();
		confirmAnswers = ['confirm'];
		await modalApi.close?.();
		await settle();
		steps.closeWithChangesConfirmed = checkpoint();

		await openModal({}, { mode: 'new' });
		await modalApi.close?.();
		await settle();
		steps.closeWithoutChanges = checkpoint();

		await openModal({}, { mode: 'new' });
		await type('variable-modal-key-input', 'ENTERED');
		await type('variable-modal-value-input', 'entered');
		const valueField = field('variable-modal-value-input');
		if (valueField) {
			await fireEvent.keyDown(valueField, { key: 'Enter', code: 'Enter' });
			await fireEvent.keyUp(valueField, { key: 'Enter', code: 'Enter' });
		}
		await settle();
		steps.enterInValue = checkpoint();
		const keyField = field('variable-modal-key-input');
		if (keyField) {
			await fireEvent.keyDown(keyField, { key: 'Enter', code: 'Enter' });
			await fireEvent.keyUp(keyField, { key: 'Enter', code: 'Enter' });
		}
		await settle();
		steps.enterInKey = checkpoint();

		expect(steps).toMatchSnapshot();
	});

	test('edits a variable without a change, and keeps the key of a variable', async () => {
		const variable = serverVariables()[2];
		await openModal({}, { mode: 'edit', variable });
		const steps: Record<string, unknown> = {};

		steps.opened = checkpoint();
		await type('variable-modal-key-input', 'GLOBAL');
		steps.keyOfOtherVariable = checkpoint();
		await type('variable-modal-key-input', 'SHARED');
		steps.ownKey = checkpoint();
		await clickTestId('variable-modal-save-button');
		steps.saved = { ...checkpoint(), state: storeState() };

		expect(steps).toMatchSnapshot();
	});

	test('creates a variable in the project of the page', async () => {
		await openModal(
			{ roleInA: 'project:editor', route: '/projects/pA/variables', currentProject: 'pA' },
			{ mode: 'new', projectId: 'pA' },
		);
		const steps: Record<string, unknown> = {};

		steps.opened = checkpoint();
		await type('variable-modal-key-input', 'SHARED');
		steps.sharedKey = checkpoint();
		await type('variable-modal-key-input', 'PAGE_KEY');
		await type('variable-modal-value-input', 'page value');
		await clickTestId('variable-modal-save-button');
		steps.saved = { ...checkpoint(), state: storeState() };

		expect(steps).toMatchSnapshot();
	});

	test('edits a variable', async () => {
		const variable = serverVariables()[0];
		await openModal({}, { mode: 'edit', variable });
		const steps: Record<string, unknown> = {};

		steps.opened = checkpoint();
		await type('variable-modal-value-input', 'changed value');
		steps.value = checkpoint();
		await clickTestId('variable-modal-save-button');
		steps.saved = { ...checkpoint(), state: storeState() };

		expect(steps).toMatchSnapshot();
	});

	test('edits a project variable, and renames it', async () => {
		const variable = serverVariables()[3];
		await openModal({ roleInA: 'project:admin' }, { mode: 'edit', variable });
		const steps: Record<string, unknown> = {};

		steps.opened = checkpoint();
		await type('variable-modal-key-input', 'RENAMED_IN_A');
		steps.key = checkpoint();
		await clickTestId('variable-modal-save-button');
		steps.saved = { ...checkpoint(), state: storeState() };

		expect(steps).toMatchSnapshot();
	});

	test('shows an error when the save fails, and cancels', async () => {
		await openModal({}, { mode: 'new' });
		server.failures.add('POST');
		const steps: Record<string, unknown> = {};

		await type('variable-modal-key-input', 'FAILS');
		await type('variable-modal-value-input', 'x');
		await clickTestId('variable-modal-save-button');
		steps.failed = { ...checkpoint(), state: storeState() };
		const cancel = buttonByText('Cancel');
		if (cancel) await fireEvent.click(cancel);
		await settle();
		steps.cancelled = checkpoint();

		expect(steps).toMatchSnapshot();
	});
});

// #endregion

describe('the variable modal of a binding', () => {
	const onCreate =
		(result: unknown = { id: 'created' }) =>
		async (values: unknown) => {
			log.push(['onCreate', plain(values)]);
			if (result instanceof Error) throw result;
			return result;
		};
	const resolvedA = {
		kind: 'resolved',
		project: { ...project('pA', 'Project A', 'project:admin'), relations: [] },
	};
	const pending = (create: boolean) => ({
		kind: 'pending',
		id: 'pNew',
		name: 'New project',
		permissions: { create },
	});

	async function flow(scenario: Scenario, data: Record<string, unknown>, value = 'new value') {
		await openModal(scenario, data);
		const steps: Record<string, unknown> = {};
		steps.opened = checkpoint();
		await type('variable-modal-key-input', 'CHANGED_KEY');
		steps.key = checkpoint();
		await type('variable-modal-value-input', value);
		steps.value = checkpoint();
		await clickTestId('variable-modal-save-button');
		steps.saved = { ...checkpoint(), state: storeState() };
		return steps;
	}

	test('creates a global variable through the callback', async () => {
		expect(
			await flow(
				{},
				{
					mode: 'new',
					projectId: null,
					fixedKey: true,
					initialValues: { key: 'API_URL', value: '' },
					onCreate: onCreate(),
					appendToBody: true,
				},
			),
		).toMatchSnapshot();
	});

	test('creates a project variable in a resolved destination', async () => {
		expect(
			await flow(
				{ roleInA: 'project:admin' },
				{
					mode: 'new',
					projectId: 'pA',
					destination: resolvedA,
					fixedKey: true,
					initialValues: { key: 'TEAM_KEY', value: 'source value' },
					onCreate: onCreate(),
					appendToBody: true,
				},
			),
		).toMatchSnapshot();
	});

	test('creates a variable in a pending destination', async () => {
		expect(
			await flow(
				{},
				{
					mode: 'new',
					projectId: 'pNew',
					destination: pending(true),
					fixedKey: true,
					initialValues: { key: 'NEW_KEY', value: '' },
					onCreate: onCreate(),
					appendToBody: true,
				},
			),
		).toMatchSnapshot();
	});

	test('a pending destination without the permission to create it', async () => {
		expect(
			await flow(
				{ user: 'member' },
				{
					mode: 'new',
					projectId: 'pNew',
					destination: pending(false),
					fixedKey: true,
					initialValues: { key: 'NEW_KEY', value: '' },
					onCreate: onCreate(),
				},
			),
		).toMatchSnapshot();
	});

	test('a callback that fails', async () => {
		expect(
			await flow(
				{},
				{
					mode: 'new',
					projectId: null,
					fixedKey: true,
					initialValues: { key: 'API_URL', value: '' },
					onCreate: onCreate(new Error('Create failed')),
				},
			),
		).toMatchSnapshot();
	});

	test('initial values without a fixed key and without a callback', async () => {
		expect(
			await flow(
				{},
				{ mode: 'new', initialValues: { key: 'PREFILLED', value: 'prefilled value' } },
			),
		).toMatchSnapshot();
	});

	test('a fixed key that exists in the scope', async () => {
		expect(
			await flow(
				{},
				{
					mode: 'new',
					projectId: null,
					fixedKey: true,
					initialValues: { key: 'GLOBAL', value: '' },
					onCreate: onCreate(),
				},
			),
		).toMatchSnapshot();
	});

	test('a member and a global binding', async () => {
		expect(
			await flow(
				{ user: 'member' },
				{
					mode: 'new',
					projectId: null,
					fixedKey: true,
					initialValues: { key: 'API_URL', value: '' },
					onCreate: onCreate(),
				},
			),
		).toMatchSnapshot();
	});

	test('an unlicensed instance and a binding', async () => {
		expect(
			await flow(
				{ licensed: false },
				{
					mode: 'new',
					projectId: null,
					fixedKey: true,
					initialValues: { key: 'API_URL', value: '' },
					onCreate: onCreate(),
				},
			),
		).toMatchSnapshot();
	});

	test('a project binding without a destination', async () => {
		expect(
			await flow(
				{ roleInA: 'project:admin' },
				{
					mode: 'new',
					projectId: 'pA',
					fixedKey: true,
					initialValues: { key: 'TEAM_KEY', value: '' },
					onCreate: onCreate(),
				},
			),
		).toMatchSnapshot();
	});
});
