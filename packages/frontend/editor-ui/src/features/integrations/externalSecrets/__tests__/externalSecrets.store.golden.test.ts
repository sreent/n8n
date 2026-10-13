// Fork test (not in upstream n8n): the behaviour of the store of external secrets
// (`useExternalSecretsStore`). For each licence state, mode of the module, user and project, the
// test calls the getters and the actions of the store against a fake server. The snapshot records
// the requests, the results and the errors of the actions, the toasts, and the state and the
// getters after each step. `../FORK.md` tells how the fork made the snapshot.
import { setNotify } from '@n8n/composables/useToast';
import { defaultSettings } from '@n8n/frontend-test-utils';
import { GLOBAL_SCOPE_MAP, type Scope } from '@n8n/permissions';
import type { IUserResponse } from '@n8n/rest-api-client/api/users';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';
import axios from 'axios';
import { createPinia, setActivePinia } from 'pinia';
import { createApp, defineComponent, isProxy, toRaw } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import type { Project, ProjectListItem } from '@/features/collaboration/projects/projects.types';

// The code under test. To record the snapshot against the original file in a checkout of upstream
// n8n, point this import at `@/features/integrations/externalSecrets.ee/externalSecrets.ee.store`.
import { useExternalSecretsStore } from '@/features/integrations/externalSecrets/externalSecrets.store';

// #region Recording

let log: unknown[] = [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

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
	if (value instanceof Map) return { '<map>': plain(Object.fromEntries(value), depth + 1) };
	if (value instanceof Set) return { '<set>': plain([...value], depth + 1) };
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, plain(value[key], depth + 1)]),
		);
	}
	return value === undefined ? '<undefined>' : value;
}

function takeLog() {
	const taken = log;
	log = [];
	return taken;
}

async function settle() {
	for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0));
}

// #endregion

// #region Fake server

type Request = { method: string; path: string; data?: unknown };
type Handler = (request: Request, match: RegExpMatchArray) => unknown;
const routes: Array<[string, RegExp, Handler]> = [];
const route = (method: string, pattern: RegExp, handler: Handler) =>
	routes.push([method, pattern, handler]);

class ServerError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const PROVIDER_PROPERTIES = [
	{ displayName: 'URL', name: 'url', type: 'string', default: '', required: true },
	{
		displayName: 'Token',
		name: 'token',
		type: 'string',
		default: '',
		typeOptions: { password: true },
	},
];

const providerList = () => [
	{
		icon: 'vault',
		name: 'vault',
		displayName: 'HashiCorp Vault',
		connected: true,
		connectedAt: '2026-01-02T03:04:05.000Z',
		state: 'connected',
		data: { url: 'https://vault.example.com/v1', token: '__n8n_BLANK_VALUE' },
	},
	{
		icon: 'awsSecretsManager',
		name: 'awsSecretsManager',
		displayName: 'AWS Secrets Manager',
		connected: false,
		connectedAt: false,
		state: 'initializing',
		data: {},
	},
	{
		icon: 'infisical',
		name: 'infisical',
		displayName: 'Infisical',
		connected: true,
		connectedAt: '2026-01-03T00:00:00.000Z',
		state: 'error',
		data: { siteURL: 'https://infisical.example.com' },
	},
];

function setupRoutes() {
	routes.length = 0;
	route('GET', /^\/external-secrets\/providers$/, () => providerList());
	route('GET', /^\/external-secrets\/providers\/([^/]+)$/, (_, match) => {
		const provider = providerList().find(({ name }) => name === match[1]);
		if (!provider) throw new ServerError(404, `Could not find provider "${match[1]}"`);
		return { ...provider, properties: PROVIDER_PROPERTIES };
	});
	route('POST', /^\/external-secrets\/providers\/([^/]+)\/test$/, (_, match) => {
		if (match[1] === 'infisical') throw new ServerError(400, 'The test failed');
		return { success: true, testState: match[1] === 'vault' ? 'connected' : 'tested' };
	});
	route('POST', /^\/external-secrets\/providers\/([^/]+)\/connect$/, () => ({}));
	route('POST', /^\/external-secrets\/providers\/([^/]+)\/update$/, (_, match) => {
		if (match[1] === 'infisical') throw new ServerError(400, 'The update failed');
		return { updated: true };
	});
	route('POST', /^\/external-secrets\/providers\/([^/]+)$/, () => ({}));
	route('GET', /^\/external-secrets\/secrets$/, () => ({
		vault: ['first', 'second', 'nested.key', 'with-dash'],
		awsSecretsManager: ['awsSecret'],
	}));
	route('GET', /^\/secret-providers\/completions\/secrets\/global$/, () => ({
		globalVault: ['globalOne', 'global.two'],
	}));
	route('GET', /^\/secret-providers\/completions\/secrets\/global\/([^/]+)$/, (_, match) => {
		if (match[1] === 'fail') throw new ServerError(403, 'Not allowed');
		if (match[1] === 'conflict') return { conflictVault: ['a', 'a.b'] };
		return {
			globalVault: [`globalFor-${match[1]}`, 'x.y.z', 'with-dash', 'trailing.', 'two..dots'],
			emptyVault: [],
		};
	});
	route('GET', /^\/secret-providers\/completions\/secrets\/project\/([^/]+)$/, (_, match) => {
		if (match[1] === 'fail') throw new ServerError(403, 'Not allowed');
		if (match[1] === 'conflict') return { conflictVault: ['ok'] };
		return { [`projectVault${match[1]}`]: ['projectOne', 'project.two'], globalVault: ['shadow'] };
	});
	// The projects store loads the project of the route.
	route('GET', /^\/projects\/([^/]+)$/, (_, match) => ({
		...PROJECT,
		id: match[1],
		name: `Project ${match[1]}`,
	}));
}

/** Paths whose requests fail with status 500. */
const failingPaths = new Set<string>();

/** Requests that wait until the test releases them: `METHOD path` to the wait. */
const holds = new Map<string, Promise<void>>();
const releases: Array<() => void> = [];

function holdRequest(key: string) {
	holds.set(
		key,
		new Promise((resolve) => {
			releases.push(resolve);
		}),
	);
}

function installServer() {
	vi.spyOn(axios, 'request').mockImplementation(async (config) => {
		const method = (config.method ?? 'GET').toUpperCase();
		const path = (config.url ?? '').split('?')[0];
		log.push([
			'request',
			`${method} ${config.url ?? ''}${config.params ? ` params=${JSON.stringify(config.params)}` : ''}${
				config.data !== undefined ? ` body=${JSON.stringify(config.data)}` : ''
			}`,
		]);
		await holds.get(`${method} ${path}`);
		if (failingPaths.has(path)) {
			throw Object.assign(new Error('Request failed'), {
				response: { status: 500, data: { message: 'The server failed', code: 500 } },
			});
		}
		const found = routes
			.map(([m, pattern, handler]) => [m, path.match(pattern), handler] as const)
			.find(([m, match]) => m === method && match);
		if (!found) {
			log.push(['unrouted', `${method} ${path}`]);
			throw Object.assign(new Error('Not found'), {
				response: { status: 404, data: { message: `Not found: ${method} ${path}`, code: 404 } },
			});
		}
		try {
			return { data: { data: found[2]({ method, path, data: config.data }, found[1]!) } };
		} catch (error) {
			if (!(error instanceof ServerError)) throw error;
			throw Object.assign(new Error('Request failed'), {
				response: { status: error.status, data: { message: error.message, code: error.status } },
			});
		}
	});
}

// #endregion

// #region Setup

const Empty = defineComponent({ render: () => null });

type Mode = 'settings' | 'multiple' | 'projects' | 'both' | 'no module settings';

type Scenario = {
	licensed: boolean;
	mode: Mode;
	user: 'owner' | 'member';
	/** The current project p1: none, from the projects store (with or without scopes), or from the route. */
	project: 'none' | 'current project' | 'current project with scopes' | 'route';
	/** Leave the module out of the active modules of the settings. */
	inactiveModule?: boolean;
};

const PROJECT: Project = {
	id: 'p1',
	name: 'Project One',
	type: 'team',
	icon: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	relations: [],
	scopes: [],
	rolesManaged: false,
};

const USERS = {
	owner: { id: 'u-owner', role: 'global:owner' as const, email: 'owner@example.com' },
	member: { id: 'u-member', role: 'global:member' as const, email: 'member@example.com' },
};

function moduleSettings(mode: Mode) {
	if (mode === 'no module settings') return {};
	return {
		'external-secrets': {
			multipleConnections: mode === 'multiple' || mode === 'both',
			forProjects: mode === 'projects' || mode === 'both',
			roleBasedAccess: true,
			systemRolesEnabled: false,
		},
	};
}

let router: Router;

async function setup(scenario: Scenario) {
	const pinia = createPinia();
	setActivePinia(pinia);
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/', name: 'home', component: Empty },
			{ path: '/projects/:projectId/credentials', name: 'project-credentials', component: Empty },
		],
	});
	await router.push(scenario.project === 'route' ? '/projects/p1/credentials' : '/');
	// The app gives the stores the route, as in the editor.
	createApp(Empty).use(router).use(pinia);
	setupRoutes();
	failingPaths.clear();
	holds.clear();
	releases.length = 0;
	installServer();
	setNotify((options) => {
		log.push(['toast', plain(options)]);
		return { close: () => {} } as never;
	});
	const settingsStore = useSettingsStore();
	settingsStore.setSettings({
		...defaultSettings,
		enterprise: { ...defaultSettings.enterprise, externalSecrets: scenario.licensed },
		activeModules: scenario.inactiveModule ? [] : ['external-secrets'],
	});
	settingsStore.moduleSettings = moduleSettings(scenario.mode);
	const user = USERS[scenario.user];
	const usersStore = useUsersStore();
	const currentUser: IUserResponse = {
		...user,
		firstName: scenario.user,
		lastName: 'User',
		isPending: false,
		globalScopes: GLOBAL_SCOPE_MAP[user.role],
	};
	usersStore.addUsers([currentUser]);
	usersStore.currentUserId = user.id;
	useRBACStore().setGlobalScopes(GLOBAL_SCOPE_MAP[user.role]);
	// The projects store follows the route, as in the editor. The test makes it here, so that the
	// log does not depend on when the store under test uses it first.
	useProjectsStore();
	await settle();
	if (scenario.project === 'current project') useProjectsStore().setCurrentProject(PROJECT);
	if (scenario.project === 'current project with scopes') {
		useProjectsStore().setCurrentProject({
			...PROJECT,
			scopes: ['externalSecret:list', 'externalSecretsProvider:list'],
		});
	}
	log = [];
}

// #endregion

// #region Steps

type Store = ReturnType<typeof useExternalSecretsStore>;

/** The state and every getter of the store. */
function storeView(store: Store) {
	const view: Record<string, unknown> = {};
	for (const key of Object.keys(store).sort()) {
		if (key.startsWith('$') || key.startsWith('_')) continue;
		// A getter can throw for some secret names. The view records the error.
		let value: unknown;
		try {
			value = (store as unknown as Record<string, unknown>)[key];
		} catch (error) {
			view[key] = `<getter throws: ${String(error)}>`;
			continue;
		}
		if (typeof value === 'function') continue;
		view[key] = plain(value);
	}
	return view;
}

/** Call an action of the store by its name. The steps use probe arguments. */
function callAction(store: Store, name: string, ...args: unknown[]) {
	const action = (store as unknown as Record<string, unknown>)[name];
	if (typeof action !== 'function') throw new Error(`The store has no action "${name}"`);
	return (action as (...given: unknown[]) => unknown)(...args);
}

/** Each step of a scenario: an action of the store, with probe arguments. */
const STEPS: Array<[string, unknown[]]> = [
	['getProvider', ['awsSecretsManager']],
	['fetchGlobalSecrets', []],
	['fetchGlobalSecrets', ['p2']],
	['fetchGlobalSecrets', ['conflict']],
	['fetchSecretsForProject', ['conflict']],
	['fetchGlobalSecrets', ['fail']],
	['fetchProjectSecrets', []],
	['fetchProjectSecrets', ['p2']],
	['fetchProjectSecrets', ['p1']],
	['fetchProjectSecrets', ['fail']],
	['fetchSecretsForProject', ['p3']],
	['fetchSecretsForProject', ['p1']],
	['fetchSecretsForProject', ['fail']],
	['fetchSecretsForProject', []],
	['getProviders', []],
	['getProvider', ['vault']],
	['getProvider', ['missing']],
	['testProviderConnection', ['vault', { url: 'https://vault.example.com/v1' }]],
	['testProviderConnection', ['awsSecretsManager', { region: 'us-east-1' }]],
	['testProviderConnection', ['infisical', {}]],
	['updateProvider', ['vault', { data: { url: 'https://vault.example.com/v2' } }]],
	['updateProvider', ['vault', { data: { token: 'new token' }, connected: false, state: 'error' }]],
	['updateProvider', ['awsSecretsManager', { region: 'eu-west-1' }]],
	['updateProvider', ['missing', { data: { url: 'x' } }]],
	['updateProviderConnected', ['vault', false]],
	['updateProviderConnected', ['awsSecretsManager', true]],
	['updateProviderConnected', ['missing', true]],
	['reloadProvider', ['vault']],
	['reloadProvider', ['infisical']],
	['setConnectionState', ['vault', 'error']],
	['setConnectionState', ['missing', 'tested']],
	['updateStoredProvider', ['vault', { connected: true }]],
	['updateStoredProvider', ['vault', { data: { extra: 'x' }, state: 'tested' }]],
	['updateStoredProvider', ['infisical', { connectedAt: false }]],
	['updateStoredProvider', ['missing', { connected: true }]],
	['getProviders', []],
];

async function runStep(store: Store, name: string, args: unknown[]) {
	let outcome: Record<string, unknown>;
	try {
		outcome = { result: plain(await callAction(store, name, ...args)) };
	} catch (error) {
		outcome = { error: plain(error) };
	}
	await settle();
	return { ...outcome, log: takeLog(), store: storeView(store) };
}

/** The view of a step keeps only the getters that changed since the step before it. */
function onlyChanges(previous: Record<string, unknown>, current: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(current).filter(
			([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value),
		),
	);
}

async function runScenario(scenario: Scenario) {
	await setup(scenario);
	const store = useExternalSecretsStore();
	await settle();
	const start = storeView(store);
	const record: Record<string, unknown> = { '00 start': start, '00 start log': takeLog() };
	let previous = start;
	for (const [index, [name, args]] of STEPS.entries()) {
		const step = await runStep(store, name, args);
		// A number keeps the order of the steps in the snapshot, which sorts the keys.
		const shownArgs = args.map((arg) => JSON.stringify(arg).replaceAll('"', "'")).join(', ');
		record[`${String(index + 1).padStart(2, '0')} ${name}(${shownArgs})`] = {
			...step,
			store: onlyChanges(previous, step.store),
		};
		previous = step.store;
	}
	return record;
}

// #endregion

const SCENARIOS: Array<[string, Scenario]> = [];
for (const licensed of [true, false]) {
	for (const mode of ['settings', 'multiple', 'projects', 'both', 'no module settings'] as const) {
		for (const user of ['owner', 'member'] as const) {
			for (const project of [
				'none',
				'current project',
				'current project with scopes',
				'route',
			] as const) {
				if (user === 'owner' && project === 'current project with scopes') continue;
				if (user === 'member' && project !== 'none' && mode !== 'both') continue;
				if (!licensed && (project !== 'none' || user !== 'owner')) continue;
				SCENARIOS.push([
					`${licensed ? 'licensed' : 'unlicensed'}, ${mode}, ${user}, project: ${project}`,
					{ licensed, mode, user, project },
				]);
			}
		}
	}
}

SCENARIOS.push(
	[
		'licensed, both, owner, project: none, module not active',
		{ licensed: true, mode: 'both', user: 'owner', project: 'none', inactiveModule: true },
	],
	[
		'licensed, settings, owner, project: none, module not active',
		{ licensed: true, mode: 'settings', user: 'owner', project: 'none', inactiveModule: true },
	],
);

const listItem = (id: string, scopes: Scope[]): ProjectListItem => ({
	id,
	name: `Project ${id}`,
	type: 'team',
	icon: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	role: 'project:editor',
	scopes,
});

/** Each place that can give the member the scope to read the secrets of a project. */
const PERMISSION_CASES: Array<[string, { route?: string; apply: () => void }]> = [
	[
		'the current project p1 has the scope',
		{
			apply: () =>
				useProjectsStore().setCurrentProject({ ...PROJECT, scopes: ['externalSecret:list'] }),
		},
	],
	[
		'the current project p1 has the scope, the route shows p2',
		{
			route: '/projects/p2/credentials',
			apply: () =>
				useProjectsStore().setCurrentProject({ ...PROJECT, scopes: ['externalSecret:list'] }),
		},
	],
	[
		'the current project p1 has only the scope to list the providers',
		{
			apply: () =>
				useProjectsStore().setCurrentProject({
					...PROJECT,
					scopes: ['externalSecretsProvider:list'],
				}),
		},
	],
	[
		'my projects: p2 has the scope',
		{
			apply: () => {
				useProjectsStore().myProjects = [listItem('p2', ['externalSecret:list'])];
			},
		},
	],
	[
		'my projects: p1 without the scope, the current project p1 has the scope',
		{
			apply: () => {
				const projectsStore = useProjectsStore();
				projectsStore.myProjects = [listItem('p1', [])];
				projectsStore.setCurrentProject({ ...PROJECT, scopes: ['externalSecret:list'] });
			},
		},
	],
	[
		'my projects: p1 has the scope, the current project p1 without the scope',
		{
			apply: () => {
				const projectsStore = useProjectsStore();
				projectsStore.myProjects = [listItem('p1', ['externalSecret:list'])];
				projectsStore.setCurrentProject({ ...PROJECT, scopes: [] });
			},
		},
	],
	[
		'my projects: p1 with no scopes, the current project p1 has the scope',
		{
			apply: () => {
				const projectsStore = useProjectsStore();
				const { scopes, ...withoutScopes } = listItem('p1', []);
				projectsStore.myProjects = [withoutScopes];
				projectsStore.setCurrentProject({ ...PROJECT, scopes: ['externalSecret:list'] });
			},
		},
	],
	[
		'all projects: p2 has the scope',
		{
			apply: () => {
				useProjectsStore().projects = [listItem('p2', ['externalSecret:list'])];
			},
		},
	],
	[
		'the personal project p2 has the scope',
		{
			apply: () => {
				useProjectsStore().personalProject = {
					...PROJECT,
					id: 'p2',
					type: 'personal',
					scopes: ['externalSecret:list'],
				};
			},
		},
	],
	[
		'the RBAC store: p2 has the scope',
		{ apply: () => useRBACStore().addProjectScope('externalSecret:list', { projectId: 'p2' }) },
	],
	[
		'the RBAC store: the global scope',
		{ apply: () => useRBACStore().addGlobalScope('externalSecret:list') },
	],
	[
		'the user: the global scope',
		{
			apply: () => {
				const usersStore = useUsersStore();
				const user = usersStore.currentUser;
				if (!user) throw new Error('No current user');
				const withScope: IUserResponse = {
					...user,
					isPending: false,
					globalScopes: [...GLOBAL_SCOPE_MAP['global:member'], 'externalSecret:list'],
				};
				usersStore.addUsers([withScope]);
			},
		},
	],
];

/** Module settings of external secrets that the modes above do not cover. */
const MODULE_SETTINGS_CASES: Array<[string, Record<string, boolean>]> = [
	['an empty object', {}],
	[
		'all flags off',
		{
			multipleConnections: false,
			forProjects: false,
			roleBasedAccess: false,
			systemRolesEnabled: false,
		},
	],
	['only forProjects', { forProjects: true }],
	['only multipleConnections', { multipleConnections: true }],
	['only roleBasedAccess', { roleBasedAccess: true }],
	[
		'forProjects without roleBasedAccess',
		{
			multipleConnections: true,
			forProjects: true,
			roleBasedAccess: false,
			systemRolesEnabled: false,
		},
	],
	[
		'forProjects with the system roles',
		{
			multipleConnections: true,
			forProjects: true,
			roleBasedAccess: true,
			systemRolesEnabled: true,
		},
	],
];

const MODULE_SETTINGS_SCENARIOS = MODULE_SETTINGS_CASES.flatMap(([name, settings]) =>
	(['owner', 'member'] as const).map((user) => [`${name}, ${user}`, settings, user] as const),
);

describe('The store of external secrets', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test.each(SCENARIOS)('%s', async (_, scenario) => {
		expect(await runScenario(scenario)).toMatchSnapshot();
	});

	test.each(PERMISSION_CASES)(
		'the permission to read the secrets of a project: %s',
		async (_, permissionCase) => {
			await setup({ licensed: true, mode: 'both', user: 'member', project: 'none' });
			if (permissionCase.route) {
				await router.push(permissionCase.route);
				await settle();
			}
			permissionCase.apply();
			const store = useExternalSecretsStore();
			await settle();
			const start = takeLog();
			const record: Record<string, unknown> = { start };
			for (const [name, projectId] of [
				['fetchProjectSecrets', 'p1'],
				['fetchProjectSecrets', 'p2'],
				['fetchSecretsForProject', 'p2'],
			] as const) {
				const step = await runStep(store, name, [projectId]);
				record[`${name}('${projectId}')`] = { log: step.log, state: step.store.state };
			}
			expect(record).toMatchSnapshot();
		},
	);

	test.each(MODULE_SETTINGS_SCENARIOS)(
		'the fetches with the module settings: %s',
		async (_, settings, user) => {
			await setup({
				licensed: true,
				mode: 'both',
				user,
				project: user === 'member' ? 'current project with scopes' : 'none',
			});
			useSettingsStore().moduleSettings = { 'external-secrets': settings } as never;
			const store = useExternalSecretsStore();
			await settle();
			const record: Record<string, unknown> = { '00 start': takeLog() };
			const steps: Array<[string, string[]]> = [
				['fetchGlobalSecrets', []],
				['fetchGlobalSecrets', ['p1']],
				['fetchProjectSecrets', []],
				['fetchProjectSecrets', ['p1']],
				['fetchSecretsForProject', []],
				['fetchSecretsForProject', ['p2']],
				['fetchSecretsForProject', ['p1']],
				['the server fails', []],
				['fetchSecretsForProject', ['p1']],
			];
			for (const [index, [name, args]] of steps.entries()) {
				const label = `${String(index + 1).padStart(2, '0')} ${name}(${args.map((arg) => `'${arg}'`).join(', ')})`;
				if (name === 'the server fails') {
					for (const path of [
						'/external-secrets/secrets',
						'/secret-providers/completions/secrets/global',
						'/secret-providers/completions/secrets/global/p1',
						'/secret-providers/completions/secrets/project/p1',
					]) {
						failingPaths.add(path);
					}
					record[label] = 'the GET requests of the secrets fail from here';
					continue;
				}
				const step = await runStep(store, name, args);
				record[label] = {
					...('error' in step ? { error: step.error } : {}),
					log: step.log,
					state: step.store.state,
				};
			}
			expect(record).toMatchSnapshot();
		},
	);

	test('the two fetches for a project when the first one waits', async () => {
		await setup({ licensed: true, mode: 'both', user: 'owner', project: 'none' });
		const store = useExternalSecretsStore();
		holdRequest('GET /secret-providers/completions/secrets/global/p3');
		const done = callAction(store, 'fetchSecretsForProject', 'p3') as Promise<unknown>;
		await settle();
		const whileWaiting = takeLog();
		for (const release of releases) release();
		await done;
		await settle();
		expect({ whileWaiting, afterRelease: takeLog(), store: storeView(store) }).toMatchSnapshot();
	});
});
