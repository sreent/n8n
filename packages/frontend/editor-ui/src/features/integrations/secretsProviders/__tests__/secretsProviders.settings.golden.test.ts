// Fork test (not in upstream n8n): the behaviour of the settings page of the external secrets
// connections (`SettingsSecretsProviders`), of the connection modal
// (`SecretsProviderConnectionModal`), of the delete modal (`DeleteSecretsProviderModal`), and of
// the two composables that the settings of a project also use (`useSecretsProvidersList` and
// `useSecretsProviderConnection`). For a fixed set of connections, provider types and projects,
// the test records what a user sees (texts, test ids, controls, icons and images), what the page
// sends to the server, and the toasts, dialogs, telemetry and store state that follow. It records
// no markup and no styles. `../FORK.md` tells how the fork made the snapshot.
import { setNotify } from '@n8n/composables/useToast';
import { setTelemetry, type Telemetry } from '@n8n/composables/registries/telemetryRegistry';
import { VIEWS } from '@n8n/frontend-constants/views';
import { defaultSettings } from '@n8n/frontend-test-utils';
import { GLOBAL_SCOPE_MAP, type Scope } from '@n8n/permissions';
import type { IUserResponse } from '@n8n/rest-api-client/api/users';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';
import { fireEvent } from '@testing-library/vue';
import axios from 'axios';
import { ElMessageBox } from 'element-plus';
import { jsonParse } from 'n8n-workflow';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import {
	createApp,
	defineComponent,
	h,
	isRef,
	isVNode,
	onBeforeUnmount,
	onMounted,
	render as renderVNode,
	type PropType,
} from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

import { createComponentRenderer } from '@/__tests__/render';
import ModalRoot from '@/app/components/ModalRoot.vue';
import {
	DELETE_SECRETS_PROVIDER_MODAL_KEY,
	SECRETS_PROVIDER_CONNECTION_MODAL_KEY,
} from '@/app/constants';
import { APP_MODALS_ELEMENT_ID } from '@/app/constants/selectors';
import { useUIStore } from '@/app/stores/ui.store';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import { useExternalSecretsStore } from '@/features/integrations/externalSecrets/externalSecrets.store';

// The code under test. To record the snapshot against the original files in a checkout of upstream
// n8n, point these imports at the files in `@/features/integrations/secretsProviders.ee/`.
import SettingsSecretsProviders from '@/features/integrations/secretsProviders/views/SettingsSecretsProviders.vue';
import SecretsProviderConnectionModal from '@/features/integrations/secretsProviders/components/SecretsProviderConnectionModal.vue';
import DeleteSecretsProviderModal from '@/features/integrations/secretsProviders/components/DeleteSecretsProviderModal.vue';
import { useSecretsProviderConnection } from '@/features/integrations/secretsProviders/composables/useSecretsProviderConnection';
import { useSecretsProvidersList } from '@/features/integrations/secretsProviders/composables/useSecretsProvidersList';

// #region Recording

type Outcomes = Record<string, unknown>;
let log: unknown[] = [];

const UNCHANGED = '<unchanged>';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;
const isCheckpoint = (value: unknown): value is Record<string, unknown> =>
	isRecord(value) && 'screen' in value;

/** The parts of `current` that differ from `previous`, down to `depth` levels. */
function changes(previous: unknown, current: unknown, depth: number): unknown {
	if (JSON.stringify(previous) === JSON.stringify(current)) return UNCHANGED;
	if (depth === 0) return current;
	if (Array.isArray(previous) && Array.isArray(current) && previous.length === current.length) {
		return current.map((value, index) => changes(previous[index], value, depth - 1));
	}
	if (
		isRecord(previous) &&
		isRecord(current) &&
		!Array.isArray(previous) &&
		!Array.isArray(current)
	) {
		return Object.fromEntries(
			Object.entries(current).map(([key, value]) => [
				key,
				key in previous ? changes(previous[key], value, depth - 1) : value,
			]),
		);
	}
	return current;
}

/**
 * Keep the first checkpoint of a case in full. Each later checkpoint keeps only what changed since
 * the checkpoint before it, and all of its calls.
 */
function onlyChanges(outcomes: Outcomes): Outcomes {
	let previous: Record<string, unknown> | undefined;
	return Object.fromEntries(
		Object.entries(outcomes).map(([step, value]) => {
			if (!isCheckpoint(value)) return [step, value];
			const { calls, ...seen } = value;
			const recorded = previous ? changes(previous, seen, 4) : seen;
			previous = seen;
			return [step, recorded === UNCHANGED ? { calls } : { ...(recorded as object), calls }];
		}),
	);
}

const normalize = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

function vnodeText(value: unknown) {
	try {
		const element = document.createElement('div');
		renderVNode(value as Parameters<typeof renderVNode>[0], element);
		const text = normalize(element.textContent);
		renderVNode(null, element);
		return `<vnode: ${text}>`;
	} catch {
		return '<vnode>';
	}
}

function plain(value: unknown, depth = 0): unknown {
	if (typeof value === 'function') return '<function>';
	if (value === undefined) return '<undefined>';
	if (value === null || typeof value !== 'object') return value;
	if (isVNode(value)) return vnodeText(value);
	if (value instanceof Error) {
		const { httpStatusCode } = value as Error & { httpStatusCode?: unknown };
		return `${value.name}: ${value.message}${httpStatusCode ? ` (${String(httpStatusCode)})` : ''}`;
	}
	if (value instanceof Date) return `<date ${value.toISOString()}>`;
	if (depth > 8) return '<deep>';
	if (Array.isArray(value)) return value.map((entry) => plain(entry, depth + 1));
	if ('on' in value && 'emit' in value && 'off' in value) return '<eventBus>';
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => [key, plain(entry, depth + 1)]),
	);
}

/** A value as one line of JSON, with single quotes, so that the snapshot stays readable. */
const oneLine = (value: unknown) => JSON.stringify(plain(value)).replaceAll('"', "'");

/** A request as one line: the method and the URL, then the params and the body when there are. */
function requestLine(method: string, url: string, params: unknown, data: unknown) {
	return [
		`${method} ${url}`,
		...(params === undefined ? [] : [`params ${oneLine(params)}`]),
		...(data === undefined ? [] : [`data ${oneLine(data)}`]),
	].join(' ');
}

function isHidden(element: Element | null): boolean {
	for (let current = element; current; current = current.parentElement) {
		if (current.hasAttribute('hidden')) return true;
		if (current instanceof HTMLElement && current.style.display === 'none') return true;
	}
	return false;
}

/** The file name of an image without its folder and its extension. */
const imageName = (src: string | null) =>
	(src ?? '')
		.split('?')[0]
		.split('/')
		.pop()
		?.replace(/\.[^.]+$/, '') ?? '';

function describeElement(element: Element) {
	const parts = [element.tagName.toLowerCase()];
	if (element instanceof HTMLInputElement) parts.push(`type=${element.type}`);
	if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') {
		parts.push('[disabled]');
	}
	if (element.getAttribute('aria-busy') === 'true') parts.push('[busy]');
	if (element.getAttribute('role')) parts.push(`role=${element.getAttribute('role')}`);
	if (element.hasAttribute('aria-checked')) {
		parts.push(`aria-checked=${element.getAttribute('aria-checked')}`);
	}
	if (element instanceof HTMLInputElement) {
		if (element.type === 'checkbox' || element.type === 'radio') {
			parts.push(element.checked ? '[checked]' : '[unchecked]');
		} else {
			parts.push(`value=${JSON.stringify(element.value)}`);
		}
	}
	if (element instanceof HTMLTextAreaElement) parts.push(`value=${JSON.stringify(element.value)}`);
	if (element instanceof HTMLAnchorElement) parts.push(`href=${element.getAttribute('href')}`);
	if (element instanceof HTMLImageElement) {
		parts.push(`image=${imageName(element.getAttribute('src'))}`);
		parts.push(`alt=${JSON.stringify(element.getAttribute('alt'))}`);
	}
	const label =
		element.getAttribute('aria-label') ??
		element.getAttribute('placeholder') ??
		normalize(element.textContent);
	return `${parts.join(' ')}: ${label}`;
}

/** What a user sees: the text, the elements with a test id, the controls and the icons. */
function describeDom(root: Element) {
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
				}: ${normalize(element.textContent)}`,
		),
		controls: [
			...root.querySelectorAll(
				'button, input, textarea, a[href], img, svg:not([data-icon]), [role="switch"], [role="menuitem"], [role="option"]',
			),
		].map(describeElement),
		icons: [...root.querySelectorAll('[data-icon]')].map((element) =>
			element.getAttribute('data-icon'),
		),
	};
}

/** What a user sees in several parts of the page, as one description. */
function describeRoots(roots: Element[]) {
	const parts = roots.map(describeDom);
	return {
		text: parts
			.map(({ text }) => text)
			.filter(Boolean)
			.join(' | '),
		...(parts.some(({ hidden }) => hidden)
			? { hidden: parts.flatMap(({ hidden }) => hidden ?? []) }
			: {}),
		testIds: parts.flatMap(({ testIds }) => testIds),
		controls: parts.flatMap(({ controls }) => controls),
		icons: parts.flatMap(({ icons }) => icons),
	};
}

async function settle() {
	for (let index = 0; index < 8; index++) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Take the log of the calls since the last checkpoint. */
function takeLog() {
	const taken = log;
	log = [];
	return taken;
}

// #endregion

// #region Fake server

type Request = { method: string; url: string; path: string; params?: unknown; data?: unknown };
type Handler = (request: Request, match: RegExpMatchArray) => unknown;
const routes: Array<[string, RegExp, Handler]> = [];
const route = (method: string, pattern: RegExp, handler: Handler) =>
	routes.push([method, pattern, handler]);

/**
 * An error answer of the server. With a `message`, n8n sends `{ message, code }`, as for a
 * `NotFoundError`. Without one, the route set the status and gave a body, as the test route of a
 * provider does.
 */
class ServerError extends Error {
	constructor(
		readonly status: number,
		readonly body: Record<string, unknown>,
	) {
		super(`Request failed with status code ${status}`);
	}
}

/** Requests that wait until the test releases them, by `METHOD path`. */
const holds = new Map<string, { wait: Promise<void>; release: () => void }>();

function holdRequest(key: string) {
	let release = () => {};
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	holds.set(key, { wait, release });
}

/** Let a held request go on, or all of them. */
function releaseRequest(key?: string) {
	for (const [heldKey, hold] of [...holds]) {
		if (key !== undefined && heldKey !== key) continue;
		hold.release();
		holds.delete(heldKey);
	}
}

function installServer() {
	vi.spyOn(axios, 'request').mockImplementation(async (config) => {
		const method = (config.method ?? 'GET').toUpperCase();
		const url = config.url ?? '';
		const path = url.split('?')[0];
		log.push(['request', requestLine(method, url, config.params, config.data)]);
		await holds.get(`${method} ${path}`)?.wait;
		let found: { handler: Handler; match: RegExpMatchArray } | undefined;
		for (const [routeMethod, pattern, handler] of routes) {
			const match = routeMethod === method ? path.match(pattern) : null;
			if (match) {
				found = { handler, match };
				break;
			}
		}
		if (!found) {
			log.push(['unrouted', `${method} ${path}`]);
			throw Object.assign(new Error('Not found'), {
				response: { status: 404, data: { message: `Not found: ${method} ${path}`, code: 404 } },
			});
		}
		try {
			// As over HTTP: the server and the page never share objects, and a value that JSON does
			// not have (for example `undefined`) does not arrive.
			const copy = <T>(value: T): T =>
				value === undefined ? value : jsonParse<T>(JSON.stringify(value));
			const request = { method, url, path, params: config.params, data: copy(config.data) };
			return { data: { data: copy(found.handler(request, found.match)) } };
		} catch (error) {
			if (!(error instanceof ServerError)) throw error;
			throw Object.assign(new Error(error.message), {
				response: { status: error.status, data: error.body },
			});
		}
	});
}

// #endregion

// #region Fixture

const NOTICE = {
	displayName:
		'Need help filling out these fields? <a href="https://docs.n8n.io/external-secrets/#connect-n8n-to-your-secrets-store" target="_blank">Open docs</a>',
	name: 'notice',
	type: 'notice',
	noDataExpression: true,
	default: '',
};

/** The form fields of each provider type, as the server sends them. */
const PROPERTIES: Record<string, unknown[]> = {
	awsSecretsManager: [
		NOTICE,
		{
			displayName: 'Region',
			name: 'region',
			type: 'string',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. eu-west-3',
			default: '',
		},
		{
			displayName: 'Authentication Method',
			name: 'authMethod',
			type: 'options',
			required: true,
			noDataExpression: true,
			default: 'iamUser',
			options: [
				{ name: 'IAM User', value: 'iamUser', description: 'Credentials for IAM user.' },
				{ name: 'Auto Detect', value: 'autoDetect', description: 'Use automatic detection.' },
			],
		},
		{
			displayName: 'Access Key ID',
			name: 'accessKeyId',
			type: 'string',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. ACHXUQMBAQEVTE2RKMWP',
			default: '',
			displayOptions: { show: { authMethod: ['iamUser'] } },
		},
		{
			displayName: 'Secret Access Key',
			name: 'secretAccessKey',
			type: 'string',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. cbmjrH/xNAjPwlQR3i/1HRSDD+esQX/Lan3gcmBc',
			default: '',
			typeOptions: { password: true },
			displayOptions: { show: { authMethod: ['iamUser'] } },
		},
	],
	onePassword: [
		NOTICE,
		{
			displayName: 'Connect Server URL',
			name: 'serverUrl',
			type: 'string',
			hint: 'URL of your 1Password Connect Server.',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. http://localhost:8080',
			default: '',
		},
		{
			displayName: 'Access Token',
			name: 'accessToken',
			type: 'string',
			hint: 'Token created for your Connect Server integration.',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. eyJhbGciOiJFUzI1NiIsImtpZCI6...',
			default: '',
			typeOptions: { password: true },
		},
	],
	vault: [
		NOTICE,
		{
			displayName: 'Vault URL',
			name: 'url',
			type: 'string',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. https://example.com/v1/',
			default: '',
		},
		{
			displayName: 'Vault Namespace (optional)',
			name: 'namespace',
			type: 'string',
			hint: 'Leave blank if not using namespaces',
			required: false,
			noDataExpression: true,
			placeholder: 'e.g. admin',
			default: '',
		},
		{
			displayName: 'Authentication Method',
			name: 'authMethod',
			type: 'options',
			required: true,
			noDataExpression: true,
			default: 'token',
			options: [
				{ name: 'Token', value: 'token' },
				{ name: 'Username and Password', value: 'usernameAndPassword' },
			],
		},
		{
			displayName: 'Token',
			name: 'token',
			type: 'string',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. hvs.2OCsZxZA6Z9lChbt0janOOZI',
			default: '',
			typeOptions: { password: true },
			displayOptions: { show: { authMethod: ['token'] } },
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			required: true,
			noDataExpression: true,
			placeholder: 'Username',
			default: '',
			displayOptions: { show: { authMethod: ['usernameAndPassword'] } },
		},
	],
	infisical: [
		NOTICE,
		{
			displayName: 'Site URL',
			name: 'siteURL',
			type: 'string',
			hint: 'The absolute URL of the Infisical instance.',
			required: true,
			noDataExpression: true,
			placeholder: 'https://app.infisical.com',
			default: 'https://app.infisical.com',
		},
		{
			displayName: 'Project ID',
			name: 'projectId',
			type: 'string',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. 7c1cbe9c-3f1b-4a92-b3a2-9d5e2f1c8a4b',
			default: '',
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'string',
			required: true,
			noDataExpression: true,
			placeholder: '***************',
			default: '',
			typeOptions: { password: true },
		},
	],
	azureKeyVault: [
		NOTICE,
		{
			displayName: 'Vault Name',
			name: 'vaultName',
			type: 'string',
			hint: 'The name of your existing Azure Key Vault.',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. my-vault',
			default: '',
		},
		{
			displayName: 'Tenant ID',
			name: 'tenantId',
			type: 'string',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. 7dec9324-7074-72b7-a3ca-a9bb3012f466',
			default: '',
		},
	],
	gcpSecretsManager: [
		NOTICE,
		{
			displayName: 'Service Account Key',
			name: 'serviceAccountKey',
			type: 'json',
			hint: 'Content of JSON file downloaded from Google Cloud Console.',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. { "type": "service_account", ... }',
			default: '',
			typeOptions: { password: true },
		},
	],
};

/** The provider types in the order of the registry of the module, as `GET /secret-providers/types` sends them. */
const PROVIDER_TYPES = [
	['awsSecretsManager', 'AWS Secrets Manager'],
	['infisical', 'Infisical'],
	['vault', 'HashiCorp Vault'],
	['azureKeyVault', 'Azure Key Vault'],
	['gcpSecretsManager', 'GCP Secrets Manager'],
	['onePassword', '1Password'],
].map(([type, displayName]) => ({
	type,
	displayName,
	icon: type,
	properties: PROPERTIES[type] ?? [NOTICE],
}));

const BLANK = '__n8n_BLANK_VALUE_e5362baf';

type ProjectRow = { id: string; name: string; role: string };

type Connection = {
	id: string;
	name: string;
	type: string;
	isEnabled: boolean;
	state: string;
	settings: Record<string, unknown>;
	secrets: string[];
	projects: ProjectRow[];
	createdAt: string;
	updatedAt: string;
};

const OWNER_ROLE = 'secretsProviderConnection:owner';
const USER_ROLE = 'secretsProviderConnection:user';

type Project = {
	id: string;
	name: string;
	type: 'personal' | 'team';
	icon: { type: 'icon'; value: string } | null;
};

const PROJECTS: Project[] = [
	{ id: 'p-personal', name: 'Test User <owner@example.com>', type: 'personal', icon: null },
	{ id: 'p-alpha', name: 'Alpha', type: 'team', icon: { type: 'icon', value: 'layers' } },
	{ id: 'p-beta', name: 'Beta', type: 'team', icon: { type: 'icon', value: 'layers' } },
	{ id: 'p-gamma', name: 'Gamma', type: 'team', icon: null },
];

/** The connections of the server at the start of each case. */
const connectionFixtures = (): Connection[] => [
	{
		id: '1',
		name: 'awsProduction',
		type: 'awsSecretsManager',
		isEnabled: true,
		state: 'connected',
		settings: {
			region: 'eu-west-1',
			authMethod: 'iamUser',
			accessKeyId: 'AKIA',
			secretAccessKey: BLANK,
		},
		secrets: ['database', 'api.key', 'api.secret'],
		projects: [],
		createdAt: '2026-01-02T12:00:00.000Z',
		updatedAt: '2026-01-05T12:00:00.000Z',
	},
	{
		id: '2',
		name: 'vaultShared',
		type: 'vault',
		isEnabled: true,
		state: 'connected',
		settings: { url: 'https://vault.example.com/v1/', authMethod: 'token', token: BLANK },
		secrets: ['token'],
		projects: [{ id: 'p-alpha', name: 'Alpha', role: USER_ROLE }],
		createdAt: '2026-01-03T12:00:00.000Z',
		updatedAt: '2026-01-03T12:00:00.000Z',
	},
	{
		id: '3',
		name: 'infisicalBroken',
		type: 'infisical',
		isEnabled: true,
		state: 'error',
		settings: { siteURL: 'https://app.infisical.com', projectId: 'project', clientSecret: BLANK },
		secrets: [],
		projects: [],
		createdAt: '2026-01-04T12:00:00.000Z',
		updatedAt: '2026-01-04T12:00:00.000Z',
	},
	{
		id: '4',
		name: 'onePasswordOff',
		type: 'onePassword',
		isEnabled: false,
		state: 'initializing',
		settings: { serverUrl: 'http://localhost:8080', accessToken: BLANK },
		secrets: [],
		projects: [],
		createdAt: '2026-01-05T12:00:00.000Z',
		updatedAt: '2026-01-06T12:00:00.000Z',
	},
	{
		id: '5',
		name: 'azureAlpha',
		type: 'azureKeyVault',
		isEnabled: true,
		state: 'connected',
		settings: { vaultName: 'my-vault', tenantId: 'tenant' },
		secrets: ['one', 'two'],
		projects: [{ id: 'p-alpha', name: 'Alpha', role: OWNER_ROLE }],
		createdAt: '2026-01-06T12:00:00.000Z',
		updatedAt: '2026-01-06T12:00:00.000Z',
	},
];

/** The credentials that use the secrets of each connection, by provider key. */
const credentialFixtures = (): Record<
	string,
	Array<{ id: string; name: string; type: string }>
> => ({
	awsProduction: [
		{ id: 'c1', name: 'Database prod', type: 'postgres' },
		{ id: 'c2', name: 'Payments API', type: 'httpHeaderAuth' },
	],
	vaultShared: [{ id: 'c3', name: 'Vault token', type: 'httpHeaderAuth' }],
});

/** The state of the fake server for one case. */
const server = {
	credentials: credentialFixtures(),
	moduleSettings: {} as Record<string, unknown>,
	connections: connectionFixtures(),
	types: PROVIDER_TYPES,
	projects: PROJECTS,
	systemRolesEnabled: false,
	/** The result of a test of each connection, by provider key. Without one, the test passes. */
	testResults: {} as Record<string, { success: boolean; testState: string; error?: string }>,
	/** `METHOD path` of each request that fails with status 500. */
	failing: new Set<string>(),
	/** The state and the secrets that a new connection gets after its create or update. */
	nextState: { state: 'connected', secrets: ['newSecret'] } as { state: string; secrets: string[] },
	nextId: 100,
};

const listView = (connection: Connection) => ({
	id: connection.id,
	name: connection.name,
	type: connection.type,
	state: connection.isEnabled ? connection.state : 'initializing',
	isEnabled: connection.isEnabled,
	projects: connection.projects,
	secretsCount: connection.isEnabled ? connection.secrets.length : 0,
	createdAt: connection.createdAt,
	updatedAt: connection.updatedAt,
});

const detailView = (connection: Connection) => ({
	...listView(connection),
	settings: connection.settings,
	secrets: (connection.isEnabled ? connection.secrets : []).map((name) => ({ name })),
});

/** The connections that a project may see: its own, then the global connections. */
const projectConnections = (projectId: string) => [
	...server.connections.filter(({ projects }) => projects.some(({ id }) => id === projectId)),
	...server.connections.filter(({ projects }) => projects.length === 0),
];

function findConnection(key: string, projectId?: string) {
	const pool = projectId
		? server.connections.filter(({ projects }) => projects.some(({ id }) => id === projectId))
		: server.connections;
	const connection = pool.find(({ name }) => name === key);
	if (!connection) {
		const where = projectId ? ` in project "${projectId}"` : '';
		throw new ServerError(404, {
			message: `Connection with key "${key}" not found${where}`,
			code: 404,
		});
	}
	return connection;
}

function projectRows(projectIds: unknown, role: string): ProjectRow[] {
	if (!Array.isArray(projectIds)) return [];
	return projectIds.map((id) => ({
		id: String(id),
		name: server.projects.find((project) => project.id === id)?.name ?? String(id),
		role,
	}));
}

/** Merge new settings into stored settings. A blanking value keeps the stored value. */
function mergeSettings(stored: Record<string, unknown>, next: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(next).map(([key, value]) => [key, value === BLANK ? stored[key] : value]),
	);
}

function createConnection(data: unknown, projectRole: string, projectIds: unknown) {
	const body = (isRecord(data) ? data : {}) as Record<string, unknown>;
	const key = String(body.providerKey ?? '');
	if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) {
		throw new ServerError(400, { message: 'Invalid provider key', code: 400 });
	}
	if (server.connections.some(({ name }) => name === key)) {
		throw new ServerError(400, {
			message: `Connection with key "${key}" already exists`,
			code: 400,
		});
	}
	const connection: Connection = {
		id: String(server.nextId++),
		name: key,
		type: String(body.type),
		isEnabled: true,
		state: server.nextState.state,
		settings: isRecord(body.settings) ? { ...body.settings } : {},
		secrets: [...server.nextState.secrets],
		projects: projectRows(projectIds, projectRole),
		createdAt: '2026-10-11T12:00:00.000Z',
		updatedAt: '2026-10-11T12:00:00.000Z',
	};
	server.connections.push(connection);
	return connection;
}

function updateConnection(connection: Connection, data: unknown, changeProjects: boolean) {
	const body = (isRecord(data) ? data : {}) as Record<string, unknown>;
	if (body.type !== undefined && body.type !== connection.type && body.settings === undefined) {
		throw new ServerError(400, {
			message: 'When changing the connection type, new settings must be provided as well',
			code: 400,
		});
	}
	if (typeof body.type === 'string') connection.type = body.type;
	if (isRecord(body.settings))
		connection.settings = mergeSettings(connection.settings, body.settings);
	if (typeof body.isEnabled === 'boolean') connection.isEnabled = body.isEnabled;
	if (changeProjects && Array.isArray(body.projectIds)) {
		connection.projects = projectRows(body.projectIds, USER_ROLE);
	}
	if (connection.isEnabled && (body.settings !== undefined || body.isEnabled === true)) {
		connection.state = server.nextState.state;
	}
	connection.updatedAt = '2026-10-11T12:00:00.000Z';
	return connection;
}

/** The scopes of the roles that a project has for a connection, as in the permission data of n8n. */
const SHARING_ROLE_SCOPES: Record<string, Scope[]> = {
	[OWNER_ROLE]: [
		'externalSecretsProvider:sync',
		'externalSecretsProvider:read',
		'externalSecretsProvider:update',
		'externalSecretsProvider:delete',
		'externalSecretsProvider:list',
		'externalSecret:list',
	],
	[USER_ROLE]: [
		'externalSecretsProvider:read',
		'externalSecretsProvider:list',
		'externalSecret:list',
	],
};

/**
 * The scopes of the user for a connection in a project, as the server gives them: the global
 * scopes, and the scopes of the user in the project that the role of the project for the
 * connection allows. A global connection gives a project the user role.
 */
function connectionScopes(connection: Connection, projectId: string) {
	const role = connection.projects.find(({ id }) => id === projectId)?.role ?? USER_ROLE;
	const allowed = SHARING_ROLE_SCOPES[role] ?? [];
	const scopes = new Set([...currentScopes, ...projectScopes.filter((s) => allowed.includes(s))]);
	return [...scopes]
		.filter((s) => s.startsWith('externalSecretsProvider:') || s.startsWith('externalSecret:'))
		.sort((a, b) => a.localeCompare(b));
}

const testResult = (key: string) =>
	server.testResults[key] ?? { success: true, testState: 'tested' };

function failWhen(request: Request) {
	if (server.failing.has(`${request.method} ${request.path}`)) {
		throw new ServerError(500, { message: 'Something went wrong', code: 500 });
	}
}

function setupRoutes() {
	routes.length = 0;
	const P = '/secret-providers/projects/([^/]+)/connections';
	route('GET', /^\/secret-providers\/types$/, (request) => {
		failWhen(request);
		return server.types;
	});
	route('GET', /^\/secret-providers\/connections$/, (request) => {
		failWhen(request);
		return server.connections.map(listView);
	});
	route('POST', /^\/secret-providers\/connections$/, (request) => {
		failWhen(request);
		const body = isRecord(request.data) ? request.data : {};
		return detailView(createConnection(body, USER_ROLE, body.projectIds));
	});
	route('GET', /^\/secret-providers\/connections\/([^/]+)$/, (request, match) => {
		failWhen(request);
		return detailView(findConnection(match[1]));
	});
	route('PATCH', /^\/secret-providers\/connections\/([^/]+)$/, (request, match) => {
		failWhen(request);
		return detailView(updateConnection(findConnection(match[1]), request.data, true));
	});
	route('DELETE', /^\/secret-providers\/connections\/([^/]+)$/, (request, match) => {
		failWhen(request);
		const connection = findConnection(match[1]);
		server.connections = server.connections.filter((c) => c !== connection);
		return undefined;
	});
	route('POST', /^\/secret-providers\/connections\/([^/]+)\/test$/, (request, match) => {
		failWhen(request);
		findConnection(match[1]);
		return testResult(match[1]);
	});
	route('POST', /^\/secret-providers\/connections\/([^/]+)\/reload$/, (request, match) => {
		failWhen(request);
		findConnection(match[1]);
		return { success: true };
	});
	route('GET', new RegExp(`^${P}$`), (request, match) => {
		failWhen(request);
		return projectConnections(match[1]).map(listView);
	});
	route('POST', new RegExp(`^${P}$`), (request, match) => {
		failWhen(request);
		const connection = createConnection(request.data, OWNER_ROLE, [match[1]]);
		return { ...detailView(connection), scopes: connectionScopes(connection, match[1]) };
	});
	route('GET', new RegExp(`^${P}/([^/]+)$`), (request, match) => {
		failWhen(request);
		const connection =
			projectConnections(match[1]).find(({ name }) => name === match[2]) ??
			findConnection(match[2], match[1]);
		return { ...detailView(connection), scopes: connectionScopes(connection, match[1]) };
	});
	route('PATCH', new RegExp(`^${P}/([^/]+)$`), (request, match) => {
		failWhen(request);
		const connection = updateConnection(findConnection(match[2], match[1]), request.data, false);
		return { ...detailView(connection), scopes: connectionScopes(connection, match[1]) };
	});
	route('DELETE', new RegExp(`^${P}/([^/]+)$`), (request, match) => {
		failWhen(request);
		const connection = findConnection(match[2], match[1]);
		server.connections = server.connections.filter((c) => c !== connection);
		return undefined;
	});
	route('POST', new RegExp(`^${P}/([^/]+)/test$`), (request, match) => {
		failWhen(request);
		findConnection(match[2], match[1]);
		return testResult(match[2]);
	});
	route('POST', /^\/external-secrets\/settings$/, (request) => {
		failWhen(request);
		const body = isRecord(request.data) ? request.data : {};
		server.systemRolesEnabled = body.systemRolesEnabled === true;
		const settings = server.moduleSettings['external-secrets'];
		if (isRecord(settings)) settings.systemRolesEnabled = server.systemRolesEnabled;
		return { systemRolesEnabled: server.systemRolesEnabled };
	});
	route('GET', /^\/module-settings$/, (request) => {
		failWhen(request);
		return server.moduleSettings;
	});
	route('GET', /^\/credentials$/, (request) => {
		failWhen(request);
		const params = isRecord(request.params) ? request.params : {};
		const store = String(params.externalSecretsStore ?? '');
		return (server.credentials[store] ?? []).map((credential) => ({
			...credential,
			createdAt: '2026-02-01T12:00:00.000Z',
			updatedAt: '2026-02-01T12:00:00.000Z',
			isManaged: false,
		}));
	});
	route('GET', /^\/secret-providers\/completions\/secrets\/global$/, () =>
		Object.fromEntries(
			server.connections
				.filter(({ isEnabled, projects }) => isEnabled && projects.length === 0)
				.map(({ name, secrets }) => [name, secrets]),
		),
	);
	route('GET', /^\/projects$/, (request) => {
		failWhen(request);
		return server.projects.map(projectListItem);
	});
	route('GET', /^\/projects\/my-projects$/, (request) => {
		failWhen(request);
		return server.projects.map(projectListItem);
	});
	route('GET', /^\/projects\/count$/, (request) => {
		failWhen(request);
		return { personal: 1, team: 3, public: 0 };
	});
	route('GET', /^\/projects\/([^/]+)$/, (request, match) => {
		failWhen(request);
		const project = server.projects.find(({ id }) => id === match[1]);
		if (!project) throw new ServerError(404, { message: 'Project not found', code: 404 });
		return { ...projectListItem(project), relations: [], scopes: projectScopes };
	});
}

let currentScopes: Scope[] = [];
let projectScopes: Scope[] = [];

const projectListItem = (project: Project) => ({
	...project,
	createdAt: '2026-01-01T12:00:00.000Z',
	updatedAt: '2026-01-01T12:00:00.000Z',
	role: 'project:admin',
	scopes: projectScopes,
});

// #endregion

// #region Setup

const USERS = {
	owner: { id: 'u-owner', role: 'global:owner' as const, email: 'owner@example.com' },
	admin: { id: 'u-admin', role: 'global:admin' as const, email: 'admin@example.com' },
	member: { id: 'u-member', role: 'global:member' as const, email: 'member@example.com' },
};

type ModuleSettings = Record<string, boolean> | 'none';

type AppOptions = {
	licensed?: boolean;
	user?: keyof typeof USERS;
	/** The global scopes of the user, in place of the scopes of the role. */
	scopes?: Scope[];
	moduleSettings?: ModuleSettings;
	/** Render only the modal roots, as on the settings page of a project. */
	page?: boolean;
	route?: string;
	/** The current project of the projects store, as on the settings page of a project. */
	currentProject?: string;
	/** The scopes of the user in its projects. */
	projectScopes?: Scope[];
};

const DEFAULT_MODULE_SETTINGS = {
	multipleConnections: true,
	forProjects: true,
	roleBasedAccess: true,
	systemRolesEnabled: false,
};

const errorHandler = (error: unknown) => {
	log.push(['vue error', plain(error)]);
};

let pinia: Pinia;
let router: Router;
let confirmAnswers: string[] = [];
let unmountLast: (() => void) | undefined;

const Empty = defineComponent({ render: () => null });

const MODAL_KEYS = [SECRETS_PROVIDER_CONNECTION_MODAL_KEY, DELETE_SECRETS_PROVIDER_MODAL_KEY];

/** The open modal frames, by modal name: how a user closes them, and the props they got. */
const modalApis = new Map<string, { close: () => Promise<void>; props: () => unknown }>();

/** Close a modal as a user does. An error of the close goes to the record, as to the console. */
async function closeModal(name = SECRETS_PROVIDER_CONNECTION_MODAL_KEY) {
	try {
		await modalApis.get(name)?.close();
	} catch (error) {
		log.push(['close error', plain(error)]);
	}
}

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
		overlayClass: String,
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
		lockScroll: { type: Boolean, default: true },
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
		type Listen = (event: string, fn: () => void) => void;
		const bus = props.eventBus as { on?: Listen; off?: Listen } | undefined;
		const onClose = () => {
			closeDialog().catch((error: unknown) => log.push(['close error', plain(error)]));
		};
		const api = { close: closeDialog, props: () => plain({ ...props }) };
		onMounted(() => {
			bus?.on?.('close', onClose);
			modalApis.set(props.name, api);
		});
		// A closed modal is gone: a later close of the test must not reach it.
		onBeforeUnmount(() => {
			bus?.off?.('close', onClose);
			if (modalApis.get(props.name) === api) modalApis.delete(props.name);
		});
		return () =>
			h('div', { role: 'dialog', 'data-test-id': `${props.name}-modal` }, [
				slots.header ? slots.header({ closeDialog }) : props.title ? h('h1', props.title) : null,
				props.loading ? h('div', 'loading') : slots.content?.(),
				!props.loading && slots.footer ? slots.footer({ close: closeDialog }) : null,
			]);
	},
});

/** The slots of the modal roots, as `Modals.vue` fills them. */
const connectionModalSlots = {
	default: ({ modalName, data }: { modalName: string; data: Record<string, unknown> }) =>
		h(SecretsProviderConnectionModal, { modalName, data }),
};
const deleteModalSlots = {
	// As `Modals.vue`, the slot passes the data of the modal as it is.
	default: ({ modalName, data }: { modalName: string; data: Record<string, unknown> }) =>
		h(DeleteSecretsProviderModal, { modalName, data: data as never }),
};

/** The page and the modal roots of its two modals, as the app shows them. */
const SettingsHost = defineComponent({
	name: 'SettingsHost',
	props: { page: { type: Boolean, default: true } },
	setup(props) {
		return () =>
			h('div', { 'data-host': 'root' }, [
				h('div', { 'data-host': 'page' }, props.page ? [h(SettingsSecretsProviders)] : []),
				// `ModalRoot` types its slot props as an object, which `h` does not accept as a slot.
				h('div', { 'data-host': SECRETS_PROVIDER_CONNECTION_MODAL_KEY }, [
					h(
						ModalRoot,
						{ name: SECRETS_PROVIDER_CONNECTION_MODAL_KEY },
						connectionModalSlots as never,
					),
				]),
				h('div', { 'data-host': DELETE_SECRETS_PROVIDER_MODAL_KEY }, [
					h(ModalRoot, { name: DELETE_SECRETS_PROVIDER_MODAL_KEY }, deleteModalSlots as never),
				]),
			]);
	},
});

function unmountPrevious() {
	const unmount = unmountLast;
	unmountLast = undefined;
	try {
		unmount?.();
	} catch {
		// After an error in a render, Vue cannot unmount the tree. The next case makes a new app.
	}
	modalApis.clear();
	// Keep the containers of the test setup for toasts and modals, and the popper container that
	// Element Plus makes once. Remove what the case left.
	for (const element of [...document.body.children]) {
		if (element.id === 'app-grid' || element.id === APP_MODALS_ELEMENT_ID) {
			element.replaceChildren();
		} else if (!element.id.startsWith('el-popper-container')) {
			element.remove();
		}
	}
}

function moduleSettingsFor(settings: ModuleSettings | undefined) {
	if (settings === 'none') return {};
	return { 'external-secrets': settings ?? DEFAULT_MODULE_SETTINGS };
}

/** Let the timers of the last case end (Element Plus closes its poppers with timers), then unmount. */
async function unmountWhenIdle() {
	if (unmountLast) {
		// Close the modals first, as a user who leaves the page.
		for (const key of MODAL_KEYS) useUIStore().closeModal(key);
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
	unmountPrevious();
}

async function setupApp(options: AppOptions = {}) {
	await unmountWhenIdle();
	pinia = createPinia();
	setActivePinia(pinia);
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/', name: VIEWS.HOMEPAGE, component: Empty },
			{
				path: '/settings/external-secrets',
				name: VIEWS.EXTERNAL_SECRETS_SETTINGS,
				component: Empty,
			},
			{ path: '/projects/:projectId/settings', name: VIEWS.PROJECT_SETTINGS, component: Empty },
			{ path: '/home/credentials/:credentialId?', name: VIEWS.CREDENTIALS, component: Empty },
			{
				path: '/projects/:projectId/credentials/:credentialId?',
				name: VIEWS.PROJECTS_CREDENTIALS,
				component: Empty,
			},
			{ path: '/:pathMatch(.*)*', name: 'other', component: Empty },
		],
	});
	await router.push(options.route ?? '/settings/external-secrets');
	// As in the app, the stores start inside an app with the router, so they can read the route.
	createApp(Empty).use(router).use(pinia);
	server.connections = connectionFixtures();
	server.types = PROVIDER_TYPES;
	server.projects = PROJECTS;
	server.systemRolesEnabled = false;
	server.credentials = credentialFixtures();
	server.testResults = {};
	server.failing = new Set();
	server.nextState = { state: 'connected', secrets: ['newSecret'] };
	server.nextId = 100;
	releaseRequest();
	confirmAnswers = [];
	setupRoutes();
	installServer();

	const settingsStore = useSettingsStore();
	settingsStore.setSettings({
		...defaultSettings,
		enterprise: { ...defaultSettings.enterprise, externalSecrets: options.licensed ?? true },
		activeModules: options.moduleSettings === 'none' ? [] : ['external-secrets'],
	});
	settingsStore.moduleSettings = moduleSettingsFor(options.moduleSettings) as never;
	server.moduleSettings = jsonParse(JSON.stringify(moduleSettingsFor(options.moduleSettings)));
	server.systemRolesEnabled =
		isRecord(server.moduleSettings['external-secrets']) &&
		server.moduleSettings['external-secrets'].systemRolesEnabled === true;
	const user = USERS[options.user ?? 'owner'];
	const scopes = options.scopes ?? GLOBAL_SCOPE_MAP[user.role];
	currentScopes = scopes;
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
	projectScopes = options.projectScopes ?? scopes;
	// The projects store follows the route, as in the editor. The test makes it here, so that the
	// log does not depend on when the code under test uses it first.
	const projectsStore = useProjectsStore();
	if (options.currentProject) await projectsStore.getProject(options.currentProject);
	log = [];
}

async function mountPage(options: AppOptions = {}, prepare?: () => void) {
	await setupApp(options);
	prepare?.();
	const rendered = createComponentRenderer(SettingsHost, {
		global: { stubs: { Modal: ModalStub }, plugins: [router], config: { errorHandler } },
	})({ pinia, props: { page: options.page ?? true } });
	unmountLast = rendered.unmount;
	await settle();
	return rendered;
}

function storeState() {
	const store = useExternalSecretsStore();
	return plain({
		secrets: store.state.secrets,
		projectSecrets: store.state.projectSecrets,
		providers: store.state.providers,
	});
}

function checkpoint() {
	const uiStore = useUIStore();
	const host = document.querySelector('[data-host="root"]');
	const part = (name: string) => document.querySelector(`[data-host="${name}"]`);
	const screen: Record<string, unknown> = { page: describeDom(part('page') ?? document.body) };
	for (const key of MODAL_KEYS) {
		const root = part(key);
		if (root?.children.length && root.textContent) screen[key] = describeDom(root);
	}
	// Menus, selects and tooltips that Element Plus moves out of the page.
	screen.popups = describeRoots(
		[...document.body.children].filter((element) => !element.contains(host)),
	);
	return {
		screen,
		modals: Object.fromEntries(
			MODAL_KEYS.filter((key) => uiStore.modalsById[key]?.open).map((key) => [
				key,
				modalApis.get(key)?.props(),
			]),
		),
		modalState: plain(
			Object.fromEntries(
				MODAL_KEYS.map((key) => [
					key,
					{ open: uiStore.modalsById[key]?.open ?? false, data: uiStore.modalsById[key]?.data },
				]),
			),
		),
		route: router.currentRoute.value.fullPath,
		title: document.title,
		store: storeState(),
		calls: takeLog(),
	};
}

/**
 * The clock of the test. Only `Date` is fake, so that the timers of the page still run. The fake
 * clock goes on as the real one does: the inputs of the provider fields wait for a quiet time,
 * which they measure with `Date`.
 */
const NOW = new Date('2026-10-11T12:00:00.000Z');

beforeEach(() => {
	vi.useFakeTimers({ now: NOW, toFake: ['Date'], shouldAdvanceTime: true });
	setNotify((options) => {
		log.push(['toast', plain(options)]);
		return { close() {} };
	});
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
	vi.spyOn(window, 'open').mockImplementation((...args: unknown[]) => {
		log.push(['window.open', plain(args)]);
		return null;
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
});

afterEach(() => {
	// Each test unmounts at its end, before the setup file removes its containers.
	unmountPrevious();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// #endregion

// #region Interactions

const modalRoot = (name = SECRETS_PROVIDER_CONNECTION_MODAL_KEY) =>
	document.querySelector(`[data-test-id="${name}-modal"]`);

/** Click as a user: a disabled control gets no click. */
async function click(element: Element | null | undefined) {
	if (!element) return false;
	const control = element.matches('input, button') ? element : element.querySelector('input');
	if (element.closest('[disabled]') ?? control?.hasAttribute('disabled')) return 'disabled';
	await fireEvent.click(element);
	await settle();
	return true;
}

function buttonByText(root: Element | null | undefined, text: string) {
	return [...(root?.querySelectorAll('button') ?? [])].find(
		(button) => normalize(button.textContent) === text,
	);
}

/** The card of a connection, by its name. */
function card(name: string) {
	const nameElement = [...document.querySelectorAll('[data-test-id="secrets-provider-name"]')].find(
		(element) => normalize(element.textContent) === name,
	);
	return nameElement?.closest('[data-test-id="card-content"]')?.parentElement;
}

async function openCardMenu(name: string) {
	const toggle = card(name)?.querySelector('[data-test-id="secrets-provider-action-toggle"]');
	return await click(toggle?.querySelector('button') ?? toggle);
}

/** Click an item of the open action menu, by its test id. */
async function clickMenuItem(testId: string) {
	const items = [...document.querySelectorAll(`[data-test-id="${testId}"]`)];
	return await click(items[items.length - 1]);
}

/** The input of an element with a test id: the element, or the first input in it. */
function inputOf(testId: string, root: Element | null | undefined) {
	const element = root?.querySelector(`[data-test-id="${testId}"]`);
	return element?.matches('input, textarea') ? element : element?.querySelector('input, textarea');
}

/** Type into an input of the open connection modal, by the test id of the input or its parent. */
async function typeInto(testId: string, value: string, root = modalRoot()) {
	const input = inputOf(testId, root);
	if (!input) return `no input ${testId}`;
	await fireEvent.update(input, value);
	// Inputs may send a typed value after a debounce of 200 ms.
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	return `${testId} = ${value}`;
}

/** Leave an input of the open connection modal, as a user who clicks elsewhere. */
async function blurInput(testId: string, root = modalRoot()) {
	const input = inputOf(testId, root);
	if (!input) return `no input ${testId}`;
	await fireEvent.blur(input);
	await settle();
	return `left ${testId}`;
}

/** Pick an option of a select, by the test id of the select and the text of the option. */
async function pickOption(testId: string, optionText: string, root = modalRoot()) {
	const input = inputOf(testId, root);
	if (!input) return `no select ${testId}`;
	await fireEvent.click(input);
	await settle();
	const option = [...document.querySelectorAll('[role="option"]')]
		.reverse()
		.find((candidate) => normalize(candidate.textContent).startsWith(optionText));
	if (!option) return `no option ${optionText}`;
	await fireEvent.click(option);
	await settle();
	return `${testId} = ${optionText}`;
}

/** Type into the input of a provider field of the open connection modal. */
const setField = async (name: string, value: string) =>
	await typeInto(`parameter-input-${name}`, value);

/** The Save button of the connection modal. Its test id can be on a wrapper of the button. */
function saveButton() {
	const element = modalRoot()?.querySelector(
		'[data-test-id="secrets-provider-connection-save-button"]',
	);
	return element?.matches('button') ? element : (element?.querySelector('button') ?? element);
}

/** Open a tab of the connection modal: `connection` or `sharing`. */
async function openTab(tab: 'connection' | 'sharing') {
	const item = modalRoot()?.querySelector(`[data-test-id="sidebar-item-${tab}"]`);
	return await click(item?.querySelector('[role="menuitem"]') ?? item);
}

/** Wait for the timers and the requests that a click starts. */
async function waitLonger(ms = 1000) {
	await new Promise((resolve) => setTimeout(resolve, ms));
	await settle();
}

/** Open a card action from the menu of the card: edit, share, reload, delete or activate. */
async function cardAction(name: string, action: string) {
	await openCardMenu(name);
	const clicked = await clickMenuItem(`action-${action}`);
	await waitLonger();
	return clicked;
}

async function save() {
	const clicked = await click(saveButton());
	await waitLonger();
	return clicked;
}

/** Close the connection modal as a user does, and let the page load again. */
async function closeAndWait(name = SECRETS_PROVIDER_CONNECTION_MODAL_KEY) {
	await closeModal(name);
	await waitLonger();
}

const deleteRoot = () => modalRoot(DELETE_SECRETS_PROVIDER_MODAL_KEY);

/** Type the confirmation text of the delete modal. */
async function typeDeleteConfirmation(value: string) {
	const input = deleteRoot()?.querySelector('input');
	if (!input) return 'no confirmation input';
	await fireEvent.update(input, value);
	await settle();
	return `typed ${value}`;
}

async function clickInDeleteModal(text: string) {
	const clicked = await click(buttonByText(deleteRoot(), text));
	await waitLonger();
	return clicked;
}

/** Open the connection modal as the project settings do, with the data of a project. */
async function openAsProject(data: Record<string, unknown>) {
	useUIStore().openModalWithData({
		name: SECRETS_PROVIDER_CONNECTION_MODAL_KEY,
		data: {
			activeTab: 'connection',
			providerTypes: PROVIDER_TYPES,
			existingProviderNames: NAMES,
			projectId: 'p-alpha',
			onClose: async () => {
				log.push(['onClose']);
			},
			...data,
		},
	});
	await waitLonger();
	return true;
}

/** Fill the fields of a new 1Password vault. */
async function fillOnePassword(name: string) {
	return [
		await typeInto('provider-name', name),
		await pickOption('provider-type-select', '1Password'),
		await setField('serverUrl', 'http://op:8080'),
		await setField('accessToken', 'token-value'),
	];
}

async function openAddModal() {
	return await click(buttonByText(document.body, 'Add secrets vault'));
}

/** Click the innermost element of a root whose text is `text`, and wait for what follows. */
async function clickText(root: Element | null | undefined, text: string) {
	const element = [...(root?.querySelectorAll('*') ?? [])]
		.reverse()
		.find((candidate) => normalize(candidate.textContent) === text);
	const clicked = await click(element);
	await waitLonger();
	return clicked;
}

/** Click the delete button in the header of the connection modal. */
async function clickModalDelete() {
	const button = modalRoot()?.querySelector('[data-test-id="secrets-provider-delete-button"]');
	const clicked = await click(
		button?.matches('button') ? button : (button?.querySelector('button') ?? button),
	);
	await waitLonger();
	return clicked;
}

// #endregion

// #region Cases

const PAGE_CASES: Record<string, AppOptions & { prepare?: () => void }> = {
	licensed: {},
	unlicensed: { licensed: false },
	'licensed, no connections': {
		prepare: () => {
			server.connections = [];
		},
	},
	'licensed, admin': { user: 'admin' },
	'licensed, member': { user: 'member' },
	'licensed, member who may list the vaults': {
		user: 'member',
		scopes: ['externalSecretsProvider:list'],
	},
	'licensed, member who may list and create vaults': {
		user: 'member',
		scopes: ['externalSecretsProvider:list', 'externalSecretsProvider:create'],
	},
	'licensed, member who may list and update vaults': {
		user: 'member',
		scopes: ['externalSecretsProvider:list', 'externalSecretsProvider:update'],
	},
	'licensed, member who may do all but create': {
		user: 'member',
		scopes: [
			'externalSecretsProvider:list',
			'externalSecretsProvider:read',
			'externalSecretsProvider:update',
			'externalSecretsProvider:delete',
			'externalSecretsProvider:sync',
		],
	},
	'licensed, no project connections': {
		moduleSettings: { ...DEFAULT_MODULE_SETTINGS, forProjects: false },
	},
	'licensed, no role-based access': {
		moduleSettings: { ...DEFAULT_MODULE_SETTINGS, roleBasedAccess: false },
	},
	'licensed, system roles on': {
		moduleSettings: { ...DEFAULT_MODULE_SETTINGS, systemRolesEnabled: true },
	},
	'licensed, no module settings': { moduleSettings: 'none' },
	'licensed, the types request fails': {
		prepare: () => {
			server.failing.add('GET /secret-providers/types');
		},
	},
	'licensed, the connections request fails': {
		prepare: () => {
			server.failing.add('GET /secret-providers/connections');
		},
	},
	'licensed, the projects request fails': {
		prepare: () => {
			server.failing.add('GET /projects');
		},
	},
	'licensed, names in mixed case': { prepare: addMixedCaseNames },
	'licensed, the names of the projects': { prepare: renameProjectsOfConnections },
	'licensed, the names of the projects, the projects request fails': {
		prepare: () => {
			renameProjectsOfConnections();
			server.failing.add('GET /projects');
		},
	},
	'licensed, other states, counts and projects': {
		prepare: () => {
			const [aws, vault, infisical, onePassword, azure] = server.connections;
			Object.assign(aws, { state: 'initialized', secrets: ['one'] });
			Object.assign(vault, {
				state: 'retrying',
				projects: [
					{ id: 'p-beta', name: 'Beta', role: USER_ROLE },
					{ id: 'p-alpha', name: 'Alpha', role: USER_ROLE },
				],
			});
			Object.assign(infisical, { state: 'connecting' });
			Object.assign(onePassword, { isEnabled: true, state: 'connected', secrets: [] });
			Object.assign(azure, { projects: [{ id: 'p-unknown', name: 'Unknown', role: OWNER_ROLE }] });
			server.connections.push({
				...aws,
				id: '6',
				name: 'gcpLongNameOfAVaultThatGoesOnAndOn',
				type: 'gcpSecretsManager',
				state: 'error',
				isEnabled: false,
				projects: [{ id: 'p-gamma', name: 'Gamma', role: USER_ROLE }],
			});
		},
	},
};

type Flow = (outcomes: Outcomes) => Promise<void>;

/**
 * Run a step of a flow: the step records what its action found, then a checkpoint. A number keeps
 * the order of the steps in the snapshot, which sorts the keys.
 */
async function step(outcomes: Outcomes, label: string, action: () => Promise<unknown>) {
	const number = String(Object.keys(outcomes).filter(isStepKey).length).padStart(2, '0');
	outcomes[`${number} ${label}: action`] = plain(await action());
	outcomes[`${number} ${label}`] = checkpoint();
}

const isStepKey = (key: string) => !key.endsWith(': action');

const NAMES = connectionFixtures().map(({ name }) => name);

const LIST_AND_UPDATE: Scope[] = ['externalSecretsProvider:list', 'externalSecretsProvider:update'];

/** The scopes of a project admin with the external secrets scopes of the project roles. */
const PROJECT_ADMIN_SCOPES: Scope[] = [
	'externalSecretsProvider:list',
	'externalSecretsProvider:read',
	'externalSecretsProvider:create',
	'externalSecretsProvider:update',
	'externalSecretsProvider:delete',
	'externalSecretsProvider:sync',
	'externalSecret:list',
];

const FLOWS: Record<string, { options?: AppOptions; prepare?: () => void; run: Flow }> = {
	'the menu of each card': {
		run: async (outcomes) => {
			for (const name of NAMES) {
				await mountPage();
				await step(outcomes, `menu of ${name}`, async () => await openCardMenu(name));
			}
		},
	},
	'the menu of each card, member who may list the vaults': {
		options: { user: 'member', scopes: ['externalSecretsProvider:list'] },
		run: async (outcomes) => {
			for (const name of NAMES) {
				await mountPage({ user: 'member', scopes: ['externalSecretsProvider:list'] });
				await step(outcomes, `menu of ${name}`, async () => await openCardMenu(name));
			}
		},
	},
	'the menu of each card, member who may list and update vaults': {
		options: { user: 'member', scopes: LIST_AND_UPDATE },
		run: async (outcomes) => {
			for (const name of NAMES) {
				await mountPage({ user: 'member', scopes: LIST_AND_UPDATE });
				await step(outcomes, `menu of ${name}`, async () => await openCardMenu(name));
			}
		},
	},
	'edit awsProduction and save': {
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('awsProduction', 'edit'));
			await step(outcomes, 'region', async () => await setField('region', 'eu-central-1'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'edit awsProduction, member who may list and update vaults': {
		options: { user: 'member', scopes: LIST_AND_UPDATE },
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('awsProduction', 'edit'));
			await step(outcomes, 'region', async () => await setField('region', 'eu-central-1'));
			await step(outcomes, 'save', async () => await save());
		},
	},
	'edit awsProduction, member who may list the vaults': {
		options: { user: 'member', scopes: ['externalSecretsProvider:list'] },
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('awsProduction', 'edit'));
		},
	},
	'edit infisicalBroken, the test fails': {
		prepare: () => {
			server.testResults.infisicalBroken = {
				success: false,
				testState: 'error',
				error: 'Invalid client secret',
			};
		},
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('infisicalBroken', 'edit'));
			await step(outcomes, 'project id', async () => await setField('projectId', 'other'));
			await step(outcomes, 'save', async () => await save());
		},
	},
	'edit onePasswordOff, the inactive vault': {
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('onePasswordOff', 'edit'));
		},
	},
	'edit awsProduction, the save fails': {
		prepare: () => {
			server.failing.add('PATCH /secret-providers/connections/awsProduction');
		},
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('awsProduction', 'edit'));
			await step(outcomes, 'region', async () => await setField('region', 'eu-central-1'));
			await step(outcomes, 'save', async () => await save());
		},
	},
	'edit awsProduction, the read fails': {
		prepare: () => {
			server.failing.add('GET /secret-providers/connections/awsProduction');
		},
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('awsProduction', 'edit'));
		},
	},
	'edit awsProduction, close with changes and keep editing': {
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('awsProduction', 'edit'));
			await step(outcomes, 'region', async () => await setField('region', 'eu-central-1'));
			confirmAnswers = ['confirm'];
			await step(outcomes, 'close, keep editing', async () => await closeAndWait());
			confirmAnswers = ['close'];
			await step(outcomes, 'close, press Escape', async () => await closeAndWait());
			confirmAnswers = ['cancel'];
			await step(outcomes, 'close, close', async () => await closeAndWait());
		},
	},
	'edit awsProduction, change a field back': {
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('awsProduction', 'edit'));
			await step(outcomes, 'region', async () => await setField('region', 'eu-central-1'));
			await step(outcomes, 'region back', async () => await setField('region', 'eu-west-1'));
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'edit awsProduction, open the delete modal from the connection modal': {
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('awsProduction', 'edit'));
			await step(outcomes, 'delete button', async () => {
				const button = modalRoot()?.querySelector(
					'[data-test-id="secrets-provider-delete-button"]',
				);
				const clicked = await click(
					button?.matches('button') ? button : (button?.querySelector('button') ?? button),
				);
				await waitLonger();
				return clicked;
			});
			await step(
				outcomes,
				'confirmation',
				async () => await typeDeleteConfirmation('awsProduction'),
			);
			await step(outcomes, 'delete', async () => await clickInDeleteModal('Delete'));
		},
	},
	'share vaultShared with Beta and save': {
		run: async (outcomes) => {
			await step(outcomes, 'share', async () => await cardAction('vaultShared', 'share'));
			await step(
				outcomes,
				'Beta',
				async () => await pickOption('secrets-provider-scope-select', 'Beta'),
			);
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'share vaultShared globally and save': {
		run: async (outcomes) => {
			await step(outcomes, 'share', async () => await cardAction('vaultShared', 'share'));
			await step(
				outcomes,
				'Global',
				async () => await pickOption('secrets-provider-scope-select', 'Global'),
			);
			await step(outcomes, 'save', async () => await save());
		},
	},
	'share awsProduction with Alpha and save': {
		run: async (outcomes) => {
			await step(outcomes, 'share', async () => await cardAction('awsProduction', 'share'));
			await step(
				outcomes,
				'Alpha',
				async () => await pickOption('secrets-provider-scope-select', 'Alpha'),
			);
			await step(outcomes, 'connection tab', async () => await openTab('connection'));
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
			await step(outcomes, 'save', async () => await save());
		},
	},
	'share azureAlpha, owned by a project': {
		run: async (outcomes) => {
			await step(outcomes, 'share', async () => await cardAction('azureAlpha', 'share'));
			await step(
				outcomes,
				'Gamma',
				async () => await pickOption('secrets-provider-scope-select', 'Gamma'),
			);
			await step(outcomes, 'save', async () => await save());
		},
	},
	'share, no project connections': {
		options: { moduleSettings: { ...DEFAULT_MODULE_SETTINGS, forProjects: false } },
		run: async (outcomes) => {
			await step(outcomes, 'share', async () => await cardAction('awsProduction', 'share'));
		},
	},
	'reload awsProduction': {
		run: async (outcomes) => {
			await step(outcomes, 'reload', async () => await cardAction('awsProduction', 'reload'));
		},
	},
	'reload awsProduction, the reload fails': {
		prepare: () => {
			server.failing.add('POST /secret-providers/connections/awsProduction/reload');
		},
		run: async (outcomes) => {
			await step(outcomes, 'reload', async () => await cardAction('awsProduction', 'reload'));
		},
	},
	'delete awsProduction': {
		run: async (outcomes) => {
			await step(outcomes, 'delete', async () => await cardAction('awsProduction', 'delete'));
			await step(
				outcomes,
				'wrong confirmation',
				async () => await typeDeleteConfirmation('awsproduction'),
			);
			await step(outcomes, 'delete, not confirmed', async () => await clickInDeleteModal('Delete'));
			await step(
				outcomes,
				'confirmation',
				async () => await typeDeleteConfirmation('awsProduction'),
			);
			await step(outcomes, 'delete', async () => await clickInDeleteModal('Delete'));
		},
	},
	'delete infisicalBroken, no secrets and no credentials': {
		run: async (outcomes) => {
			await step(outcomes, 'delete', async () => await cardAction('infisicalBroken', 'delete'));
			await step(
				outcomes,
				'confirmation',
				async () => await typeDeleteConfirmation('infisicalBroken'),
			);
			await step(outcomes, 'delete', async () => await clickInDeleteModal('Delete'));
		},
	},
	'delete vaultShared, cancel': {
		run: async (outcomes) => {
			await step(outcomes, 'delete', async () => await cardAction('vaultShared', 'delete'));
			await step(outcomes, 'cancel', async () => await clickInDeleteModal('Cancel'));
		},
	},
	'delete awsProduction, the delete fails': {
		prepare: () => {
			server.failing.add('DELETE /secret-providers/connections/awsProduction');
		},
		run: async (outcomes) => {
			await step(outcomes, 'delete', async () => await cardAction('awsProduction', 'delete'));
			await step(
				outcomes,
				'confirmation',
				async () => await typeDeleteConfirmation('awsProduction'),
			);
			await step(outcomes, 'delete', async () => await clickInDeleteModal('Delete'));
		},
	},
	'delete awsProduction, the credentials request fails': {
		prepare: () => {
			server.failing.add('GET /credentials');
		},
		run: async (outcomes) => {
			await step(outcomes, 'delete', async () => await cardAction('awsProduction', 'delete'));
		},
	},
	'activate onePasswordOff': {
		run: async (outcomes) => {
			await step(outcomes, 'activate', async () => await cardAction('onePasswordOff', 'activate'));
		},
	},
	'activate onePasswordOff, the activation fails': {
		prepare: () => {
			server.failing.add('PATCH /secret-providers/connections/onePasswordOff');
		},
		run: async (outcomes) => {
			await step(outcomes, 'activate', async () => await cardAction('onePasswordOff', 'activate'));
		},
	},
	'turn on the project roles': {
		run: async (outcomes) => {
			await step(outcomes, 'switch', async () => {
				const clicked = await click(
					document.querySelector('[data-test-id="external-secrets-system-roles-switch"]'),
				);
				await waitLonger();
				return clicked;
			});
		},
	},
	'turn off the project roles': {
		options: { moduleSettings: { ...DEFAULT_MODULE_SETTINGS, systemRolesEnabled: true } },
		run: async (outcomes) => {
			await step(outcomes, 'switch', async () => {
				const clicked = await click(
					document.querySelector('[data-test-id="external-secrets-system-roles-switch"]'),
				);
				await waitLonger();
				return clicked;
			});
		},
	},
	'turn off the project roles, cancel': {
		options: { moduleSettings: { ...DEFAULT_MODULE_SETTINGS, systemRolesEnabled: true } },
		run: async (outcomes) => {
			confirmAnswers = ['cancel'];
			await step(outcomes, 'switch', async () => {
				const clicked = await click(
					document.querySelector('[data-test-id="external-secrets-system-roles-switch"]'),
				);
				await waitLonger();
				return clicked;
			});
		},
	},
	'turn on the project roles, the request fails': {
		prepare: () => {
			server.failing.add('POST /external-secrets/settings');
		},
		run: async (outcomes) => {
			await step(outcomes, 'switch', async () => {
				const clicked = await click(
					document.querySelector('[data-test-id="external-secrets-system-roles-switch"]'),
				);
				await waitLonger();
				return clicked;
			});
		},
	},
	'turn on the project roles, member who may list the vaults': {
		options: { user: 'member', scopes: ['externalSecretsProvider:list'] },
		run: async (outcomes) => {
			await step(outcomes, 'switch', async () => {
				const clicked = await click(
					document.querySelector('[data-test-id="external-secrets-system-roles-switch"]'),
				);
				await waitLonger();
				return clicked;
			});
		},
	},
	'add an AWS vault': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'name', async () => await typeInto('provider-name', 'awsStaging'));
			await step(outcomes, 'leave the name', async () => await blurInput('provider-name'));
			await step(
				outcomes,
				'type',
				async () => await pickOption('provider-type-select', 'AWS Secrets Manager'),
			);
			await step(outcomes, 'region', async () => await setField('region', 'eu-west-1'));
			await step(outcomes, 'keys', async () => [
				await setField('accessKeyId', 'AKIAEXAMPLE'),
				await setField('secretAccessKey', 'secret-value'),
			]);
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
			await step(outcomes, 'connection tab', async () => await openTab('connection'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'add an AWS vault with auto detection': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'name', async () => await typeInto('provider-name', 'awsAuto'));
			await step(
				outcomes,
				'type',
				async () => await pickOption('provider-type-select', 'AWS Secrets Manager'),
			);
			await step(outcomes, 'region', async () => await setField('region', 'eu-west-1'));
			await step(
				outcomes,
				'auto detect',
				async () => await pickOption('parameter-input-authMethod', 'Auto Detect'),
			);
			await step(outcomes, 'save', async () => await save());
		},
	},
	'add a 1Password vault': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'fields', async () => await fillOnePassword('opStaging'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'token again', async () => await setField('accessToken', 'other-token'));
			await step(outcomes, 'save again', async () => await save());
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'add a vault: the rules of the name': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'leave the empty name', async () => await blurInput('provider-name'));
			for (const name of [
				'1vault',
				'my-vault',
				'my vault',
				'awsProduction',
				'AWSPRODUCTION',
				'vaultShared',
				'a',
				'x'.repeat(130),
				'validName2',
			]) {
				await step(outcomes, `name ${name.slice(0, 20)}`, async () => [
					await typeInto('provider-name', name),
					await blurInput('provider-name'),
				]);
			}
			await step(
				outcomes,
				'type',
				async () => await pickOption('provider-type-select', 'GCP Secrets Manager'),
			);
		},
	},
	'add a vault: switch the type': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'name', async () => await typeInto('provider-name', 'switching'));
			await step(
				outcomes,
				'AWS',
				async () => await pickOption('provider-type-select', 'AWS Secrets Manager'),
			);
			await step(outcomes, 'region', async () => await setField('region', 'eu-west-1'));
			await step(
				outcomes,
				'HashiCorp Vault',
				async () => await pickOption('provider-type-select', 'HashiCorp Vault'),
			);
			await step(
				outcomes,
				'AWS again',
				async () => await pickOption('provider-type-select', 'AWS Secrets Manager'),
			);
			await step(
				outcomes,
				'Infisical',
				async () => await pickOption('provider-type-select', 'Infisical'),
			);
			await step(
				outcomes,
				'Azure Key Vault',
				async () => await pickOption('provider-type-select', 'Azure Key Vault'),
			);
		},
	},
	'add a vault shared with Alpha': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'fields', async () => await fillOnePassword('opAlpha'));
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
			await step(
				outcomes,
				'Alpha',
				async () => await pickOption('secrets-provider-scope-select', 'Alpha'),
			);
			await step(outcomes, 'save', async () => await save());
		},
	},
	'add a vault, the test fails': {
		prepare: () => {
			server.testResults.opBroken = { success: false, testState: 'error', error: 'Unauthorized' };
			server.nextState = { state: 'error', secrets: [] };
		},
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'fields', async () => await fillOnePassword('opBroken'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'add a vault, the save fails': {
		prepare: () => {
			server.failing.add('POST /secret-providers/connections');
		},
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'fields', async () => await fillOnePassword('opFails'));
			await step(outcomes, 'save', async () => await save());
		},
	},
	'add a vault, the server has the name': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'fields', async () => await fillOnePassword('opTaken'));
			await step(outcomes, 'another user adds the name', async () => {
				server.connections.push({
					...connectionFixtures()[0],
					id: '9',
					name: 'opTaken',
					isEnabled: false,
				});
				return true;
			});
			await step(outcomes, 'save', async () => await save());
		},
	},
	'add a vault, close with changes': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'name', async () => await typeInto('provider-name', 'unsaved'));
			confirmAnswers = ['confirm'];
			await step(outcomes, 'close, keep editing', async () => await closeAndWait());
			confirmAnswers = ['close'];
			await step(outcomes, 'close, press Escape', async () => await closeAndWait());
			confirmAnswers = ['cancel'];
			await step(outcomes, 'close, close', async () => await closeAndWait());
		},
	},
	'add a vault, close without changes': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'add a vault from the empty state': {
		prepare: () => {
			server.connections = [];
		},
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'fields', async () => await fillOnePassword('opFirst'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'add a vault, member who may list and create vaults': {
		options: {
			user: 'member',
			scopes: ['externalSecretsProvider:list', 'externalSecretsProvider:create'],
		},
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'fields', async () => await fillOnePassword('opMember'));
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
			await step(outcomes, 'save', async () => await save());
		},
	},
	'the connection modal of a project: add a vault': {
		options: {
			page: false,
			route: '/projects/p-alpha/settings',
			currentProject: 'p-alpha',
			user: 'member',
			scopes: [],
			projectScopes: PROJECT_ADMIN_SCOPES,
		},
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openAsProject({}));
			await step(outcomes, 'fields', async () => await fillOnePassword('opProject'));
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
			await step(outcomes, 'connection tab', async () => await openTab('connection'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'the connection modal of a project: a vault of the project': {
		options: {
			page: false,
			route: '/projects/p-alpha/settings',
			currentProject: 'p-alpha',
			user: 'member',
			scopes: [],
			projectScopes: PROJECT_ADMIN_SCOPES,
		},
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openAsProject({ providerKey: 'azureAlpha' }));
			await step(outcomes, 'tenant', async () => await setField('tenantId', 'other-tenant'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
		},
	},
	'the connection modal of a project: a global vault, member': {
		options: {
			page: false,
			route: '/projects/p-alpha/settings',
			currentProject: 'p-alpha',
			user: 'member',
			scopes: [],
			projectScopes: PROJECT_ADMIN_SCOPES,
		},
		run: async (outcomes) => {
			await step(
				outcomes,
				'open',
				async () => await openAsProject({ providerKey: 'awsProduction' }),
			);
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
		},
	},
	'the connection modal of a project: a global vault, owner': {
		options: { page: false, route: '/projects/p-alpha/settings', currentProject: 'p-alpha' },
		run: async (outcomes) => {
			await step(
				outcomes,
				'open',
				async () => await openAsProject({ providerKey: 'awsProduction' }),
			);
		},
	},
	'the connection modal of a project: the share tab first': {
		options: {
			page: false,
			route: '/projects/p-alpha/settings',
			currentProject: 'p-alpha',
			user: 'member',
			scopes: [],
			projectScopes: PROJECT_ADMIN_SCOPES,
		},
		run: async (outcomes) => {
			await step(
				outcomes,
				'open',
				async () => await openAsProject({ providerKey: 'azureAlpha', activeTab: 'sharing' }),
			);
		},
	},
	'add a vault: a wrong name that the user did not leave': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'name', async () => await typeInto('provider-name', 'my-vault'));
			await step(outcomes, 'other fields', async () => [
				await pickOption('provider-type-select', '1Password'),
				await setField('serverUrl', 'http://op:8080'),
				await setField('accessToken', 'token-value'),
			]);
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'good name', async () => await typeInto('provider-name', 'myVault'));
		},
	},
	'add a 1Password vault, change it after the save': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'fields', async () => await fillOnePassword('opChanged'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'server URL', async () => await setField('serverUrl', 'http://op:9090'));
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
			await step(
				outcomes,
				'Beta',
				async () => await pickOption('secrets-provider-scope-select', 'Beta'),
			);
			await step(outcomes, 'connection tab', async () => await openTab('connection'));
			await step(outcomes, 'save again', async () => await save());
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'edit awsProduction, save twice': {
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('awsProduction', 'edit'));
			await step(outcomes, 'region', async () => await setField('region', 'eu-central-1'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'access key', async () => await setField('accessKeyId', 'AKIANEW'));
			await step(outcomes, 'save again', async () => await save());
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
			await step(
				outcomes,
				'Beta',
				async () => await pickOption('secrets-provider-scope-select', 'Beta'),
			);
			await step(outcomes, 'save the scope', async () => await save());
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'edit infisicalBroken, the details of the error': {
		prepare: () => {
			server.testResults.infisicalBroken = {
				success: false,
				testState: 'error',
				error: 'Invalid client secret',
			};
		},
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('infisicalBroken', 'edit'));
			await step(
				outcomes,
				'more details',
				async () => await clickText(modalRoot(), 'More details'),
			);
		},
	},
	'delete awsProduction, open the credentials': {
		run: async (outcomes) => {
			await step(outcomes, 'delete', async () => await cardAction('awsProduction', 'delete'));
			await step(outcomes, 'point at the credentials', async () => {
				const link = deleteRoot()?.querySelector('[data-test-id="credentials-link"]');
				if (!link) return false;
				await fireEvent.mouseEnter(link);
				await waitLonger();
				return true;
			});
			await step(outcomes, 'credentials', async () => {
				const link = deleteRoot()?.querySelector('[data-test-id="credentials-link"]');
				const clicked = await click(link?.querySelector('a, button') ?? link);
				await waitLonger();
				return clicked;
			});
		},
	},
	'delete vaultShared, a vault of a project': {
		run: async (outcomes) => {
			await step(outcomes, 'delete', async () => await cardAction('vaultShared', 'delete'));
			await step(outcomes, 'credentials', async () => {
				const link = deleteRoot()?.querySelector('[data-test-id="credentials-link"]');
				const clicked = await click(link?.querySelector('a, button') ?? link);
				await waitLonger();
				return clicked;
			});
			await step(outcomes, 'confirmation', async () => await typeDeleteConfirmation('vaultShared'));
			await step(outcomes, 'delete', async () => await clickInDeleteModal('Delete'));
		},
	},
	'the connection modal of a project: a vault of the project, save and delete': {
		options: {
			page: false,
			route: '/projects/p-alpha/settings',
			currentProject: 'p-alpha',
			user: 'member',
			scopes: [],
			projectScopes: PROJECT_ADMIN_SCOPES,
		},
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openAsProject({ providerKey: 'azureAlpha' }));
			await step(outcomes, 'tenant', async () => await setField('tenantId', 'other-tenant'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'delete button', async () => await clickModalDelete());
			await step(outcomes, 'confirmation', async () => await typeDeleteConfirmation('azureAlpha'));
			await step(outcomes, 'delete', async () => await clickInDeleteModal('Delete'));
		},
	},
	'the connection modal of a project: a vault shared with the project': {
		options: {
			page: false,
			route: '/projects/p-alpha/settings',
			currentProject: 'p-alpha',
			user: 'member',
			scopes: [],
			projectScopes: PROJECT_ADMIN_SCOPES,
		},
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openAsProject({ providerKey: 'vaultShared' }));
			await step(outcomes, 'token', async () => await setField('token', 'other-token'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'the connection modal of a project: add a vault, owner': {
		options: { page: false, route: '/projects/p-alpha/settings', currentProject: 'p-alpha' },
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openAsProject({}));
			await step(outcomes, 'fields', async () => await fillOnePassword('opOwner'));
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
			await step(outcomes, 'connection tab', async () => await openTab('connection'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'the connection modal of a project: add a vault, member who may create vaults': {
		options: {
			page: false,
			route: '/projects/p-alpha/settings',
			currentProject: 'p-alpha',
			user: 'member',
			scopes: ['externalSecretsProvider:create'],
			projectScopes: PROJECT_ADMIN_SCOPES,
		},
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openAsProject({}));
			await step(outcomes, 'fields', async () => await fillOnePassword('opCreator'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'the connection modal of a project: add a vault, the project scopes in the RBAC store': {
		options: {
			page: false,
			route: '/projects/p-alpha/settings',
			currentProject: 'p-alpha',
			user: 'member',
			scopes: [],
			projectScopes: PROJECT_ADMIN_SCOPES,
		},
		prepare: () => {
			const rbacStore = useRBACStore();
			for (const scope of PROJECT_ADMIN_SCOPES)
				rbacStore.addProjectScope(scope, { projectId: 'p-alpha' });
		},
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openAsProject({}));
			await step(outcomes, 'fields', async () => await fillOnePassword('opRbac'));
			await step(outcomes, 'save', async () => await save());
		},
	},
	'add a 1Password vault, close after a change after the save': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'fields', async () => await fillOnePassword('opClose'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'server URL', async () => await setField('serverUrl', 'http://op:9090'));
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'add a 1Password vault, the share tab after the save': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'fields', async () => await fillOnePassword('opTabs'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
			await step(outcomes, 'connection tab', async () => await openTab('connection'));
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'add a vault, while the requests wait': {
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'fields', async () => await fillOnePassword('opSlow'));
			holdRequest('POST /secret-providers/connections');
			holdRequest('POST /secret-providers/connections/opSlow/test');
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'the create ends', async () => {
				releaseRequest('POST /secret-providers/connections');
				await waitLonger();
				return true;
			});
			await step(outcomes, 'the test ends', async () => {
				releaseRequest('POST /secret-providers/connections/opSlow/test');
				await waitLonger();
				return true;
			});
		},
	},
	'edit awsProduction, switch the tabs': {
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('awsProduction', 'edit'));
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
			await step(outcomes, 'connection tab', async () => await openTab('connection'));
			await step(outcomes, 'close', async () => await closeAndWait());
		},
	},
	'edit awsProduction, while the requests wait': {
		run: async (outcomes) => {
			holdRequest('GET /secret-providers/connections/awsProduction');
			holdRequest('POST /secret-providers/connections/awsProduction/test');
			await step(outcomes, 'edit', async () => await cardAction('awsProduction', 'edit'));
			await step(outcomes, 'the read ends', async () => {
				releaseRequest('GET /secret-providers/connections/awsProduction');
				await waitLonger();
				return true;
			});
			await step(outcomes, 'the test ends', async () => {
				releaseRequest('POST /secret-providers/connections/awsProduction/test');
				await waitLonger();
				return true;
			});
			await step(outcomes, 'region', async () => await setField('region', 'eu-central-1'));
			holdRequest('PATCH /secret-providers/connections/awsProduction');
			holdRequest('POST /secret-providers/connections/awsProduction/test');
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'the update ends', async () => {
				releaseRequest('PATCH /secret-providers/connections/awsProduction');
				await waitLonger();
				return true;
			});
			await step(outcomes, 'the test ends again', async () => {
				releaseRequest('POST /secret-providers/connections/awsProduction/test');
				await waitLonger();
				return true;
			});
		},
	},
	'edit infisicalBroken, a test error without details': {
		prepare: () => {
			server.testResults.infisicalBroken = { success: false, testState: 'error' };
		},
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('infisicalBroken', 'edit'));
			await step(
				outcomes,
				'more details',
				async () => await clickText(modalRoot(), 'More details'),
			);
		},
	},
	'delete onePasswordOff, credentials without secrets': {
		prepare: () => {
			server.credentials.onePasswordOff = [{ id: 'c9', name: 'Op token', type: 'httpHeaderAuth' }];
		},
		run: async (outcomes) => {
			await step(outcomes, 'delete', async () => await cardAction('onePasswordOff', 'delete'));
		},
	},
	'the page while the requests wait': {
		prepare: () => {
			holdRequest('GET /secret-providers/types');
			holdRequest('GET /secret-providers/connections');
			holdRequest('GET /projects');
		},
		run: async (outcomes) => {
			await step(outcomes, 'the types arrive', async () => {
				releaseRequest('GET /secret-providers/types');
				await waitLonger();
				return true;
			});
			await step(outcomes, 'the connections arrive', async () => {
				releaseRequest('GET /secret-providers/connections');
				await waitLonger();
				return true;
			});
			await step(outcomes, 'the projects arrive', async () => {
				releaseRequest('GET /projects');
				await waitLonger();
				return true;
			});
		},
	},
	'unlicensed, see the plans': {
		options: { licensed: false },
		run: async (outcomes) => {
			await step(outcomes, 'see plans', async () => {
				const clicked = await click(buttonByText(document.body, 'See plans'));
				await waitLonger();
				return clicked;
			});
		},
	},
	'click a card': {
		run: async (outcomes) => {
			await step(outcomes, 'click', async () => {
				const clicked = await click(
					card('awsProduction')?.querySelector('[data-test-id="card-content"]'),
				);
				await waitLonger();
				return clicked;
			});
		},
	},
	'the connection modal of a project: a vault shared with two projects': {
		options: {
			page: false,
			route: '/projects/p-alpha/settings',
			currentProject: 'p-alpha',
			user: 'member',
			scopes: [],
			projectScopes: PROJECT_ADMIN_SCOPES,
		},
		prepare: () => {
			const vault = server.connections.find(({ name }) => name === 'vaultShared');
			if (vault) {
				vault.projects = [
					{ id: 'p-beta', name: 'Beta', role: USER_ROLE },
					{ id: 'p-alpha', name: 'Alpha', role: USER_ROLE },
				];
			}
		},
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openAsProject({ providerKey: 'vaultShared' }));
		},
	},
	'the menu of each card, other states': {
		run: async (outcomes) => {
			const otherStates = () => {
				const [aws, vault, infisical] = server.connections;
				Object.assign(aws, { state: 'initialized' });
				Object.assign(vault, { state: 'retrying' });
				Object.assign(infisical, { state: 'connecting' });
			};
			for (const name of ['awsProduction', 'vaultShared', 'infisicalBroken']) {
				await mountPage({}, otherStates);
				await step(outcomes, `menu of ${name}`, async () => await openCardMenu(name));
			}
		},
	},
	'edit awsProduction, no project connections': {
		options: { moduleSettings: { ...DEFAULT_MODULE_SETTINGS, forProjects: false } },
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('awsProduction', 'edit'));
		},
	},
	'add a vault, member who may list, create and update vaults': {
		options: {
			user: 'member',
			scopes: [
				'externalSecretsProvider:list',
				'externalSecretsProvider:create',
				'externalSecretsProvider:update',
			],
		},
		run: async (outcomes) => {
			await step(outcomes, 'add', async () => await openAddModal());
			await step(outcomes, 'fields', async () => await fillOnePassword('opUpdater'));
			await step(outcomes, 'save', async () => await save());
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
		},
	},
	'click a card, member who may list the vaults': {
		options: { user: 'member', scopes: ['externalSecretsProvider:list'] },
		run: async (outcomes) => {
			await step(outcomes, 'click', async () => {
				const clicked = await click(
					card('awsProduction')?.querySelector('[data-test-id="card-content"]'),
				);
				await waitLonger();
				return clicked;
			});
		},
	},
	'click the parts of a card': {
		run: async (outcomes) => {
			const parts: Array<[string, string]> = [
				['awsProduction', 'secrets-provider-image'],
				['awsProduction', 'secrets-provider-global-badge'],
				['azureAlpha', 'secrets-provider-project-badge'],
				['onePasswordOff', 'card-append'],
			];
			for (const [name, testId] of parts) {
				await mountPage();
				await step(outcomes, `click ${testId} of ${name}`, async () => {
					const clicked = await click(card(name)?.querySelector(`[data-test-id="${testId}"]`));
					await waitLonger();
					return clicked;
				});
			}
		},
	},
	'share vaultShared, filter the projects': {
		run: async (outcomes) => {
			await step(outcomes, 'share', async () => await cardAction('vaultShared', 'share'));
			await step(outcomes, 'open the select', async () => {
				const clicked = await click(
					modalRoot()?.querySelector('[data-test-id="secrets-provider-scope-select"] input'),
				);
				await waitLonger(500);
				return clicked;
			});
			await step(
				outcomes,
				'type Al',
				async () => await typeInto('secrets-provider-scope-select', 'Al'),
			);
			await step(
				outcomes,
				'type zzz',
				async () => await typeInto('secrets-provider-scope-select', 'zzz'),
			);
		},
	},
	'the page while the connections load again': {
		run: async (outcomes) => {
			await step(outcomes, 'edit', async () => await cardAction('awsProduction', 'edit'));
			holdRequest('GET /secret-providers/connections');
			await step(outcomes, 'close', async () => await closeAndWait());
			await step(outcomes, 'the connections arrive', async () => {
				releaseRequest('GET /secret-providers/connections');
				await waitLonger();
				return true;
			});
		},
	},
	'the connection modal of a project: a vault of the project, owner': {
		options: { page: false, route: '/projects/p-alpha/settings', currentProject: 'p-alpha' },
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openAsProject({ providerKey: 'azureAlpha' }));
			await step(outcomes, 'share tab', async () => await openTab('sharing'));
		},
	},
	'the connection modal of a project: the project request fails': {
		options: {
			page: false,
			route: '/projects/p-alpha/settings',
			currentProject: 'p-alpha',
			user: 'member',
			scopes: [],
			projectScopes: PROJECT_ADMIN_SCOPES,
		},
		run: async (outcomes) => {
			server.failing.add('GET /projects/p-alpha');
			await step(outcomes, 'open', async () => await openAsProject({ providerKey: 'azureAlpha' }));
		},
	},
	'the connection modal: a vault that the server does not know': {
		options: { page: false },
		run: async (outcomes) => {
			await step(
				outcomes,
				'open',
				async () => await openAsProject({ providerKey: 'missing', projectId: undefined }),
			);
		},
	},
};

/** Run a composable in the setup of a component, as the pages do, and give its result. */
async function runComposable(composable: () => object) {
	let result: object | undefined;
	const Probe = defineComponent({
		name: 'ComposableProbe',
		setup() {
			result = composable();
			return () => null;
		},
	});
	const rendered = createComponentRenderer(Probe, {
		global: { plugins: [router], config: { errorHandler } },
	})({ pinia });
	unmountLast = rendered.unmount;
	await settle();
	if (!result) throw new Error('The composable did not run');
	return result;
}

/** The values that a composable gives: its refs and computed values, without its functions. */
function composableState(result: object) {
	return plain(
		Object.fromEntries(
			Object.entries(result)
				.filter(([, value]) => typeof value !== 'function')
				.map(([key, value]) => [key, isRef(value) ? value.value : value]),
		),
	);
}

type ComposableCall = (result: Record<string, unknown>) => unknown;

/** Call a function of a composable result by its name, with arguments. */
const fn =
	(name: string, ...args: unknown[]): ComposableCall =>
	(result) => {
		const member = result[name];
		if (typeof member !== 'function') return `no function ${name}`;
		return member(...args);
	};

/**
 * Run the steps of a composable case. A step calls a function of the result and records what it
 * gives or throws, the values of the composable after it, the store state and the calls.
 */
async function runComposableSteps(result: object, steps: Array<[string, ComposableCall]>) {
	const outcomes: Outcomes = { '00 start': { state: composableState(result), calls: takeLog() } };
	for (const [index, [label, call]] of steps.entries()) {
		let outcome: Record<string, unknown>;
		try {
			outcome = { returned: plain(await call(result as Record<string, unknown>)) };
		} catch (error) {
			outcome = { threw: plain(error) };
		}
		await settle();
		outcomes[`${String(index + 1).padStart(2, '0')} ${label}`] = {
			...outcome,
			state: composableState(result),
			store: storeState(),
			calls: takeLog(),
		};
	}
	return outcomes;
}

/** A step that starts a call that waits for a held request, records the values, then releases it. */
const whileHeld =
	(request: string, call: ComposableCall): ComposableCall =>
	async (result) => {
		holdRequest(request);
		const pending = Promise.resolve(call(result)).then(
			(value) => ({ returned: plain(value) }),
			(error: unknown) => ({ threw: plain(error) }),
		);
		await settle();
		const during = composableState(result);
		releaseRequest();
		return { during, ...(await pending) };
	};

/** Projects of connections whose names differ from the names in the list of projects. */
function renameProjectsOfConnections() {
	const vault = server.connections.find(({ name }) => name === 'vaultShared');
	const azure = server.connections.find(({ name }) => name === 'azureAlpha');
	if (vault) vault.projects = [{ id: 'p-alpha', name: 'Alpha Old', role: USER_ROLE }];
	if (azure) azure.projects = [{ id: 'p-gamma', name: 'Gamma Old', role: OWNER_ROLE }];
}

/** Connections whose names sort in a different order by code units and by the locale. */
function addMixedCaseNames() {
	for (const [index, name] of ['Zeta', 'alpha', 'Beta', 'beta2', 'ALPHA3'].entries()) {
		server.connections.push({
			...connectionFixtures()[0],
			id: String(20 + index),
			name,
			createdAt: `2026-02-0${index + 1}T12:00:00.000Z`,
		});
	}
}

const NEW_CONNECTION = {
	providerKey: 'opNew',
	type: 'onePassword',
	isGlobal: true,
	projectIds: [],
	settings: { serverUrl: 'http://op:8080', accessToken: 'token-value' },
};

const LIST_CASES: Record<
	string,
	{ options?: AppOptions; prepare?: () => void; steps: Array<[string, ComposableCall]> }
> = {
	'list, owner': {
		steps: [
			['fetch the types', fn('fetchProviderTypes')],
			['fetch the connections', fn('fetchActiveConnections')],
			['fetch awsProduction', fn('fetchConnection', 'awsProduction')],
			['fetch a missing connection', fn('fetchConnection', 'missing')],
			['fetch the connections again', fn('fetchActiveConnections')],
		],
	},
	'list, member who may list the vaults': {
		options: { user: 'member', scopes: ['externalSecretsProvider:list'] },
		steps: [
			['fetch the types', fn('fetchProviderTypes')],
			['fetch the connections', fn('fetchActiveConnections')],
		],
	},
	'list, member who may create and update vaults': {
		options: {
			user: 'member',
			scopes: ['externalSecretsProvider:create', 'externalSecretsProvider:update'],
		},
		steps: [['fetch the connections', fn('fetchActiveConnections')]],
	},
	'list, member': {
		options: { user: 'member' },
		steps: [
			['fetch the types', fn('fetchProviderTypes')],
			['fetch the connections', fn('fetchActiveConnections')],
		],
	},
	'list, unlicensed': {
		options: { licensed: false },
		steps: [
			['fetch the types', fn('fetchProviderTypes')],
			['fetch the connections', fn('fetchActiveConnections')],
		],
	},
	'list, the requests fail': {
		prepare: () => {
			server.failing.add('GET /secret-providers/types');
			server.failing.add('GET /secret-providers/connections');
			server.failing.add('GET /secret-providers/connections/awsProduction');
		},
		steps: [
			['fetch the types', fn('fetchProviderTypes')],
			['fetch the connections', fn('fetchActiveConnections')],
			['fetch awsProduction', fn('fetchConnection', 'awsProduction')],
		],
	},
	'list, the secrets of the store': {
		steps: [
			[
				'the store gets secrets',
				() => {
					useExternalSecretsStore().state.secrets = { awsProduction: ['database', 'api.key'] };
				},
			],
			[
				'the store gets project secrets',
				() => {
					useExternalSecretsStore().state.projectSecrets = { azureAlpha: ['one'] };
				},
			],
			['fetch the connections', fn('fetchActiveConnections')],
			['fetch awsProduction', fn('fetchConnection', 'awsProduction')],
		],
	},
	'list, fetch a connection before the list': {
		steps: [
			['fetch awsProduction', fn('fetchConnection', 'awsProduction')],
			['fetch the connections', fn('fetchActiveConnections')],
			['fetch vaultShared', fn('fetchConnection', 'vaultShared')],
		],
	},
	'list, names in mixed case': {
		prepare: addMixedCaseNames,
		steps: [['fetch the connections', fn('fetchActiveConnections')]],
	},
	'list, while the requests wait': {
		steps: [
			['fetch the types', whileHeld('GET /secret-providers/types', fn('fetchProviderTypes'))],
			[
				'fetch the connections',
				whileHeld('GET /secret-providers/connections', fn('fetchActiveConnections')),
			],
			[
				'fetch awsProduction',
				whileHeld(
					'GET /secret-providers/connections/awsProduction',
					fn('fetchConnection', 'awsProduction'),
				),
			],
		],
	},
};

const CONNECTION_CASES: Record<
	string,
	{
		options?: AppOptions;
		prepare?: () => void;
		projectId?: string;
		steps: Array<[string, ComposableCall]>;
	}
> = {
	'connection, instance': {
		prepare: () => {
			server.testResults.infisicalBroken = {
				success: false,
				testState: 'error',
				error: 'Invalid client secret',
			};
		},
		steps: [
			['get awsProduction', fn('getConnection', 'awsProduction')],
			['test awsProduction', fn('testConnection', 'awsProduction')],
			['test infisicalBroken', fn('testConnection', 'infisicalBroken')],
			['create opNew', fn('createConnection', NEW_CONNECTION)],
			[
				'update opNew',
				fn('updateConnection', 'opNew', { settings: { serverUrl: 'http://op:9090' } }),
			],
			['reload awsProduction', fn('reloadConnection', 'awsProduction')],
			['activate onePasswordOff', fn('activateConnection', 'onePasswordOff')],
			['set the state', fn('setConnectionState', 'error')],
			['set another state', fn('setConnectionState', 'connected')],
			['get a missing connection', fn('getConnection', 'missing')],
			['test a missing connection', fn('testConnection', 'missing')],
		],
	},
	'connection, the requests fail': {
		prepare: () => {
			for (const request of [
				'GET /secret-providers/connections/awsProduction',
				'POST /secret-providers/connections/awsProduction/test',
				'POST /secret-providers/connections',
				'PATCH /secret-providers/connections/awsProduction',
				'POST /secret-providers/connections/awsProduction/reload',
				'PATCH /secret-providers/connections/onePasswordOff',
			]) {
				server.failing.add(request);
			}
		},
		steps: [
			['get awsProduction', fn('getConnection', 'awsProduction')],
			['test awsProduction', fn('testConnection', 'awsProduction')],
			['create opNew', fn('createConnection', NEW_CONNECTION)],
			['update awsProduction', fn('updateConnection', 'awsProduction', { isEnabled: true })],
			['reload awsProduction', fn('reloadConnection', 'awsProduction')],
			['activate onePasswordOff', fn('activateConnection', 'onePasswordOff')],
		],
	},
	'connection, the server sends a test error without details': {
		prepare: () => {
			server.testResults.awsProduction = { success: false, testState: 'error' };
		},
		steps: [['test awsProduction', fn('testConnection', 'awsProduction')]],
	},
	'connection, the results of a test': {
		prepare: () => {
			server.testResults = {
				awsProduction: { success: true, testState: 'connected' },
				vaultShared: { success: false, testState: 'tested' },
				onePasswordOff: { success: true, testState: 'error', error: 'Odd' },
				infisicalBroken: { success: false, testState: 'error', error: 'Invalid client secret' },
			};
		},
		steps: [
			['test infisicalBroken', fn('testConnection', 'infisicalBroken')],
			['test awsProduction', fn('testConnection', 'awsProduction')],
			['test vaultShared', fn('testConnection', 'vaultShared')],
			['test onePasswordOff', fn('testConnection', 'onePasswordOff')],
			['test azureAlpha', fn('testConnection', 'azureAlpha')],
		],
	},
	'connection, create with other fields': {
		steps: [
			[
				'create opOther',
				fn('createConnection', {
					...NEW_CONNECTION,
					providerKey: 'opOther',
					isGlobal: false,
					projectIds: ['p-beta'],
					extra: 'x',
				}),
			],
		],
	},
	'connection, project, create with other fields': {
		projectId: 'p-alpha',
		options: {
			route: '/projects/p-alpha/settings',
			currentProject: 'p-alpha',
			user: 'member',
			scopes: [],
			projectScopes: PROJECT_ADMIN_SCOPES,
		},
		steps: [
			[
				'create opOther',
				fn('createConnection', {
					...NEW_CONNECTION,
					providerKey: 'opOther',
					isGlobal: false,
					projectIds: ['p-beta'],
					extra: 'x',
				}),
			],
		],
	},
	'connection, while the requests wait': {
		steps: [
			[
				'update awsProduction',
				whileHeld(
					'PATCH /secret-providers/connections/awsProduction',
					fn('updateConnection', 'awsProduction', { settings: { region: 'eu-north-1' } }),
				),
			],
			[
				'reload awsProduction',
				whileHeld(
					'POST /secret-providers/connections/awsProduction/reload',
					fn('reloadConnection', 'awsProduction'),
				),
			],
			[
				'activate onePasswordOff',
				whileHeld(
					'PATCH /secret-providers/connections/onePasswordOff',
					fn('activateConnection', 'onePasswordOff'),
				),
			],
			[
				'get awsProduction',
				whileHeld(
					'GET /secret-providers/connections/awsProduction',
					fn('getConnection', 'awsProduction'),
				),
			],
			[
				'test awsProduction',
				whileHeld(
					'POST /secret-providers/connections/awsProduction/test',
					fn('testConnection', 'awsProduction'),
				),
			],
			[
				'create opNew',
				whileHeld('POST /secret-providers/connections', fn('createConnection', NEW_CONNECTION)),
			],
		],
	},
	'connection, project': {
		projectId: 'p-alpha',
		options: {
			route: '/projects/p-alpha/settings',
			currentProject: 'p-alpha',
			user: 'member',
			scopes: [],
			projectScopes: PROJECT_ADMIN_SCOPES,
		},
		steps: [
			['get azureAlpha', fn('getConnection', 'azureAlpha')],
			['get awsProduction', fn('getConnection', 'awsProduction')],
			['test azureAlpha', fn('testConnection', 'azureAlpha')],
			['create opNew', fn('createConnection', NEW_CONNECTION)],
			['update azureAlpha', fn('updateConnection', 'azureAlpha', { settings: { tenantId: 't2' } })],
			['reload azureAlpha', fn('reloadConnection', 'azureAlpha')],
			['activate azureAlpha', fn('activateConnection', 'azureAlpha')],
			['get vaultShared', fn('getConnection', 'vaultShared')],
			['get a missing connection', fn('getConnection', 'missing')],
		],
	},
};

describe('The composables of the external secrets connections', () => {
	test.each(Object.entries(LIST_CASES))('%s', async (_, { options, prepare, steps }) => {
		await setupApp(options);
		prepare?.();
		const result = await runComposable(() => useSecretsProvidersList());
		expect(await runComposableSteps(result, steps)).toMatchSnapshot();
		await unmountWhenIdle();
	});

	test.each(Object.entries(CONNECTION_CASES))(
		'%s',
		async (_, { options, prepare, projectId, steps }) => {
			await setupApp(options);
			prepare?.();
			const result = await runComposable(() => useSecretsProviderConnection(projectId));
			expect(await runComposableSteps(result, steps)).toMatchSnapshot();
			await unmountWhenIdle();
		},
	);
});

describe('The settings page of the external secrets connections', () => {
	test.each(Object.entries(PAGE_CASES))('%s', async (_, { prepare, ...options }) => {
		await mountPage(options, prepare);
		const outcomes: Outcomes = { opened: checkpoint() };
		expect(onlyChanges(outcomes)).toMatchSnapshot();
		await unmountWhenIdle();
	});

	test.each(Object.entries(FLOWS))(
		'flow: %s',
		async (_, { options, prepare, run }) => {
			await mountPage(options, prepare);
			const outcomes: Outcomes = { '00 opened': checkpoint() };
			await run(outcomes);
			expect(onlyChanges(outcomes)).toMatchSnapshot();
			await unmountWhenIdle();
		},
		120_000,
	);
});

// #endregion
