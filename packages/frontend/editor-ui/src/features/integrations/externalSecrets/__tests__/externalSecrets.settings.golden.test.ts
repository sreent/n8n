// Fork test (not in upstream n8n): the behaviour of the settings page of external secrets with one
// connection for each provider type (`SettingsExternalSecrets`), and of its provider modal
// (`ExternalSecretsProviderModal`). For a fixed set of providers, the test records what a user sees
// (texts, test ids, controls, icons and images), what the page sends to the server, and the
// toasts, dialogs, telemetry and store state that follow. It records no markup and no styles.
// `../FORK.md` tells how the fork made the snapshot.
import { setNotify } from '@n8n/composables/useToast';
import { setTelemetry, type Telemetry } from '@n8n/composables/registries/telemetryRegistry';
import { VIEWS } from '@n8n/frontend-constants/views';
import type { IUserResponse } from '@n8n/rest-api-client/api/users';
import { defaultSettings } from '@n8n/frontend-test-utils';
import { GLOBAL_SCOPE_MAP, type Scope } from '@n8n/permissions';
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
	isVNode,
	onMounted,
	render as renderVNode,
	type PropType,
} from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

import { createComponentRenderer } from '@/__tests__/render';
import ModalRoot from '@/app/components/ModalRoot.vue';
import { EXTERNAL_SECRETS_PROVIDER_MODAL_KEY } from '@/app/constants';
import { APP_MODALS_ELEMENT_ID } from '@/app/constants/selectors';
import { useUIStore } from '@/app/stores/ui.store';

// The code under test. To record the snapshot against the original files in a checkout of upstream
// n8n, point these imports at the files in `@/features/integrations/externalSecrets.ee/`.
import SettingsExternalSecrets from '@/features/integrations/externalSecrets/views/SettingsExternalSecrets.vue';
import ExternalSecretsProviderModal from '@/features/integrations/externalSecrets/components/ExternalSecretsProviderModal.vue';
import { useExternalSecretsStore } from '@/features/integrations/externalSecrets/externalSecrets.store';

// #region Recording

type Outcomes = Record<string, unknown>;
let log: unknown[] = [];

const UNCHANGED = '<unchanged>';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;
const isCheckpoint = (value: unknown): value is Record<string, unknown> =>
	isRecord(value) && 'dom' in value;

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
			const recorded = previous ? changes(previous, seen, 3) : seen;
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
		const url = config.url ?? '';
		const path = url.split('?')[0];
		log.push(['request', requestLine(method, url, config.params, config.data)]);
		await holds.get(`${method} ${path}`);
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

type Provider = {
	icon: string;
	name: string;
	displayName: string;
	connected: boolean;
	connectedAt: string | false;
	state: 'connected' | 'tested' | 'initializing' | 'error';
	data: Record<string, unknown>;
};

/** The provider types of the server at the start of each case. */
const providerFixtures = (): Provider[] => [
	{
		icon: 'onePassword',
		name: 'onePassword',
		displayName: '1Password',
		connected: true,
		connectedAt: '2026-01-02T12:00:00.000Z',
		state: 'connected',
		data: { serverUrl: 'http://localhost:8080', accessToken: '__n8n_BLANK_VALUE_e5362baf' },
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
		icon: 'azureKeyVault',
		name: 'azureKeyVault',
		displayName: 'Azure Key Vault',
		connected: false,
		connectedAt: false,
		state: 'initializing',
		data: { vaultName: 'my-vault', tenantId: 'tenant' },
	},
	{
		icon: 'gcpSecretsManager',
		name: 'gcpSecretsManager',
		displayName: 'GCP Secrets Manager',
		connected: false,
		connectedAt: false,
		state: 'initializing',
		data: {},
	},
	{
		icon: 'vault',
		name: 'vault',
		displayName: 'HashiCorp Vault',
		connected: true,
		connectedAt: '2026-01-03T12:00:00.000Z',
		state: 'error',
		data: {
			url: 'https://vault.example.com/v1/',
			authMethod: 'token',
			token: '__n8n_BLANK_VALUE_e5362baf',
		},
	},
	{
		icon: 'infisical',
		name: 'infisical',
		displayName: 'Infisical',
		connected: false,
		connectedAt: '2026-01-04T12:00:00.000Z',
		state: 'tested',
		data: {
			siteURL: 'https://app.infisical.com',
			projectId: 'project',
			clientSecret: '__n8n_BLANK_VALUE_e5362baf',
		},
	},
];

/** The state of the fake server for one case. */
const server = {
	providers: providerFixtures(),
	secrets: {} as Record<string, string[]>,
	/** The provider types whose connection test fails. */
	failingTests: new Set<string>(),
	/** The provider types whose reload fails. */
	failingReloads: new Set<string>(),
	/** The provider types whose settings the server does not store. */
	failingSaves: new Set<string>(),
	/** Whether `GET /external-secrets/providers` fails. */
	failProviders: false,
	/** Form fields that replace the fields of a provider type. */
	properties: {} as Record<string, unknown[]>,
};

function setupRoutes() {
	routes.length = 0;
	route('GET', /^\/external-secrets\/providers$/, () => {
		if (server.failProviders) {
			throw new ServerError(500, { message: 'Something went wrong', code: 500 });
		}
		return server.providers;
	});
	route('GET', /^\/external-secrets\/providers\/([^/]+)$/, (_, match) => {
		const provider = server.providers.find(({ name }) => name === match[1]);
		if (!provider) {
			throw new ServerError(404, { message: `Could not find provider "${match[1]}"`, code: 404 });
		}
		return {
			...provider,
			properties: server.properties[provider.name] ?? PROPERTIES[provider.name] ?? [NOTICE],
		};
	});
	route('POST', /^\/external-secrets\/providers\/([^/]+)\/test$/, (_, match) => {
		if (server.failingTests.has(match[1])) {
			throw new ServerError(400, { data: { success: false, testState: 'error' } });
		}
		return { success: true, testState: 'connected' };
	});
	route('POST', /^\/external-secrets\/providers\/([^/]+)\/connect$/, ({ data }, match) => {
		const provider = server.providers.find(({ name }) => name === match[1]);
		const { connected } = (data ?? {}) as { connected?: boolean };
		if (provider) provider.connected = connected === true;
		return {};
	});
	route('POST', /^\/external-secrets\/providers\/([^/]+)\/update$/, (_, match) => {
		if (server.failingReloads.has(match[1])) {
			throw new ServerError(400, { data: { updated: false } });
		}
		return { updated: true };
	});
	route('POST', /^\/external-secrets\/providers\/([^/]+)$/, ({ data }, match) => {
		if (server.failingSaves.has(match[1])) {
			throw new ServerError(400, { message: 'The settings are not valid', code: 400 });
		}
		const provider = server.providers.find(({ name }) => name === match[1]);
		if (provider && isRecord(data)) provider.data = { ...data };
		return {};
	});
	// As the server: the secret names of each connected provider, an empty list when it has none.
	route('GET', /^\/external-secrets\/secrets$/, () =>
		Object.fromEntries(
			server.providers
				.filter(({ connected }) => connected)
				.map(({ name }) => [name, server.secrets[name] ?? []]),
		),
	);
	route('GET', /^\/secret-providers\/completions\/secrets\/global$/, () => server.secrets);
}

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
};

const errorHandler = (error: unknown) => {
	log.push(['vue error', plain(error)]);
};

let pinia: Pinia;
let router: Router;
let confirmAnswers: string[] = [];
let unmountLast: (() => void) | undefined;

const Empty = defineComponent({ render: () => null });

const modalApi: { close?: () => Promise<void>; props?: () => unknown } = {};

/** Close the modal as a user does. An error of the close goes to the record, as to the console. */
async function closeModal() {
	try {
		await modalApi.close?.();
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

/** The slot of the modal root, as `Modals.vue` fills it. */
const modalSlots = {
	default: ({ modalName, data }: { modalName: string; data: Record<string, unknown> }) =>
		h(ExternalSecretsProviderModal, { modalName, data: data as { name: string } }),
};

/** The page and the modal root of the provider modal, as the app shows them. */
const Host = defineComponent({
	name: 'SettingsHost',
	setup() {
		return () =>
			h('div', [
				h(SettingsExternalSecrets),
				// `ModalRoot` types its slot props as an object, which `h` does not accept as a slot.
				h(ModalRoot, { name: EXTERNAL_SECRETS_PROVIDER_MODAL_KEY }, modalSlots as never),
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
	modalApi.close = undefined;
	modalApi.props = undefined;
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
	return {
		'external-secrets': settings ?? {
			multipleConnections: false,
			forProjects: false,
			roleBasedAccess: false,
			systemRolesEnabled: false,
		},
	};
}

/** Let the timers of the last case end (Element Plus closes its poppers with timers), then unmount. */
async function unmountWhenIdle() {
	if (unmountLast) {
		// Close the modal first, as a user who leaves the page.
		useUIStore().closeModal(EXTERNAL_SECRETS_PROVIDER_MODAL_KEY);
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
		],
	});
	await router.push('/settings/external-secrets');
	// As in the app, the stores start inside an app with the router, so they can read the route.
	createApp(Empty).use(router).use(pinia);
	server.providers = providerFixtures();
	server.secrets = {
		onePassword: ['database', 'api.key', 'api.secret'],
		vault: ['token'],
	};
	server.failingTests = new Set();
	server.failingReloads = new Set();
	server.failingSaves = new Set();
	server.failProviders = false;
	server.properties = {};
	holds.clear();
	releases.length = 0;
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
	const user = USERS[options.user ?? 'owner'];
	const scopes = options.scopes ?? GLOBAL_SCOPE_MAP[user.role];
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
	log = [];
}

async function mountPage(options: AppOptions = {}, prepare?: () => void) {
	await setupApp(options);
	prepare?.();
	const rendered = createComponentRenderer(Host, {
		global: { stubs: { Modal: ModalStub }, plugins: [router], config: { errorHandler } },
	})({ pinia });
	unmountLast = rendered.unmount;
	await settle();
	return rendered;
}

function storeState() {
	const store = useExternalSecretsStore();
	return plain({
		providers: store.state.providers,
		secrets: store.state.secrets,
		connectionState: store.state.connectionState,
	});
}

function checkpoint() {
	const modalState = useUIStore().modalsById[EXTERNAL_SECRETS_PROVIDER_MODAL_KEY];
	return {
		dom: describeDom(document.body),
		modal: modalApi.props?.(),
		modalState: plain({ open: modalState?.open ?? false, data: modalState?.data }),
		route: router.currentRoute.value.fullPath,
		title: document.title,
		store: storeState(),
		calls: takeLog(),
	};
}

/** The clock of the test. Only `Date` is fake, so that the timers of the page still run. */
const NOW = new Date('2026-10-11T12:00:00.000Z');

beforeEach(() => {
	vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
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

const modalRoot = () => document.querySelector('[data-test-id="externalSecretsProvider-modal"]');

/** Click as a user: a disabled control gets no click. */
async function click(element: Element | null | undefined) {
	if (!element) return false;
	const control = element.matches('input, button') ? element : element.querySelector('input');
	if (element.closest('[disabled]') ?? control?.hasAttribute('disabled')) return 'disabled';
	await fireEvent.click(element);
	await settle();
	return true;
}

/** The card of a provider, by its display name. */
function card(displayName: string) {
	return [...document.querySelectorAll('[data-test-id="card-content"]')].find((element) =>
		normalize(element.textContent).startsWith(displayName),
	);
}

function buttonByText(root: Element | null | undefined, text: string) {
	return [...(root?.querySelectorAll('button') ?? [])].find(
		(button) => normalize(button.textContent) === text,
	);
}

async function openCardMenu(displayName: string) {
	const toggle = card(displayName)?.querySelector('[data-test-id="action-toggle"]');
	return await click(toggle?.querySelector('button') ?? toggle);
}

/** Click an item of the open action menu, by its test id. */
async function clickMenuItem(testId: string) {
	const items = [...document.querySelectorAll(`[data-test-id="${testId}"]`)];
	return await click(items[items.length - 1]);
}

const switchIn = (root: Element | null | undefined) =>
	root?.querySelector('[data-test-id="settings-external-secrets-connected-switch"]');

/** Type into the input of a property of the modal. */
async function setField(name: string, value: string) {
	const input = modalRoot()?.querySelector(`[data-test-id="parameter-input-${name}"] input`);
	if (!input) return `no input ${name}`;
	await fireEvent.update(input, value);
	// The parameter input sends a typed value after a debounce of 200 ms.
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
	return `${name} = ${value}`;
}

/** Pick an option of a select property of the modal, by the text of the option. */
async function selectOption(name: string, optionText: string) {
	const input = modalRoot()?.querySelector(`[data-test-id="parameter-input-${name}"] input`);
	if (!input) return `no select ${name}`;
	await fireEvent.click(input);
	await settle();
	const option = [...document.querySelectorAll('[data-test-id="parameter-input-item"]')].find(
		(element) => normalize(element.textContent).startsWith(optionText),
	);
	if (!option) return `no option ${optionText}`;
	await fireEvent.click(option);
	await settle();
	return `${name} = ${optionText}`;
}

const saveButton = () => buttonByText(modalRoot(), 'Save') ?? buttonByText(modalRoot(), 'Saving');

/** Open the modal of a provider from its card: with Set Up, else with Edit connection. */
async function openProviderModal(displayName: string) {
	const setUp = buttonByText(card(displayName), 'Set Up');
	if (setUp) return await click(setUp);
	await openCardMenu(displayName);
	return await clickMenuItem('action-setup');
}

// #endregion

// #region Cases

const PAGE_CASES: Record<string, AppOptions & { prepare?: () => void }> = {
	licensed: {},
	unlicensed: { licensed: false },
	'licensed, admin': { user: 'admin' },
	'licensed, member': { user: 'member' },
	'licensed, no providers': {
		prepare: () => {
			server.providers = [];
		},
	},
	'licensed, the providers request fails': {
		prepare: () => {
			server.failProviders = true;
		},
	},
	'licensed, no module settings': { moduleSettings: 'none' },
	'licensed, other states and times': {
		prepare: () => {
			const [onePassword, aws, azure, gcp, vault, infisical] = server.providers;
			Object.assign(aws, { connected: true, connectedAt: '2026-02-01T12:00:00.000Z' });
			Object.assign(aws, { state: 'connected', data: { region: 'eu-west-1' } });
			Object.assign(vault, { connected: false, connectedAt: false, state: 'initializing' });
			Object.assign(vault, { data: {} });
			Object.assign(gcp, { connected: true, connectedAt: '2025-12-01T12:00:00.000Z' });
			Object.assign(gcp, { state: 'error', data: { serviceAccountKey: '__n8n_BLANK_VALUE' } });
			Object.assign(onePassword, { connectedAt: false });
			Object.assign(infisical, { connected: true, state: 'tested' });
			Object.assign(azure, { state: 'error', data: { url: '' } });
		},
	},
	'licensed, data without values': {
		prepare: () => {
			const [onePassword, aws, azure, gcp, vault, infisical] = server.providers;
			Object.assign(onePassword, { connected: false, connectedAt: false, data: undefined });
			Object.assign(aws, { data: { region: '' } });
			Object.assign(azure, { connectedAt: '2026-01-01T12:00:00.000Z', data: {} });
			Object.assign(gcp, { data: { serviceAccountKey: '__n8n_BLANK_VALUE' } });
			Object.assign(vault, { connected: false, state: 'error', data: { url: null } });
			Object.assign(infisical, { data: { token: false } });
		},
	},
	'licensed, member with the scopes of the route': {
		user: 'member',
		scopes: ['externalSecretsProvider:list', 'externalSecretsProvider:update'],
	},
	'licensed, member who may list the secrets': {
		user: 'member',
		scopes: ['externalSecret:list'],
	},
	'licensed, owner without the scope to list the secrets': {
		scopes: GLOBAL_SCOPE_MAP['global:owner'].filter((scope) => scope !== 'externalSecret:list'),
	},
	'licensed, provider types without a logo': {
		prepare: () => {
			const unknown = {
				connected: false,
				connectedAt: false,
				state: 'initializing',
				data: {},
			} as const;
			server.providers = [
				{ ...unknown, icon: 'foo', name: 'foo', displayName: 'Foo Store' },
				// The logo follows the name of the provider type, not its icon.
				{ ...unknown, icon: 'vault', name: 'bar', displayName: 'Bar Store' },
			];
		},
	},
	'licensed, role-based access and the system roles': {
		moduleSettings: {
			multipleConnections: false,
			forProjects: false,
			roleBasedAccess: true,
			systemRolesEnabled: true,
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

const DISPLAY_NAMES = providerFixtures().map(({ displayName }) => displayName);

const STATES = ['connected', 'tested', 'initializing', 'error'] as const;

/** Open and close the modal of 1Password for each connected flag, state and settings. */
const MODAL_STATE_CASES = [true, false].flatMap((connected) =>
	STATES.flatMap((state) =>
		[true, false].map((hasData) => ({
			label: `${connected ? 'connected' : 'not connected'}, ${state}, ${hasData ? 'with' : 'without'} settings`,
			connected,
			state,
			hasData,
		})),
	),
);

const FLOWS: Record<string, { options?: AppOptions; prepare?: () => void; run: Flow }> = {
	'the modal of 1Password in each state': {
		run: async (outcomes) => {
			for (const { label, connected, state, hasData } of MODAL_STATE_CASES) {
				await mountPage({}, () => {
					Object.assign(server.providers[0], {
						connected,
						state,
						data: hasData ? { serverUrl: 'http://localhost:8080' } : {},
					});
				});
				await step(outcomes, `open, ${label}`, async () => await openProviderModal('1Password'));
				confirmAnswers = ['cancel'];
				await step(outcomes, `close, ${label}`, async () => {
					await closeModal();
					await settle();
				});
			}
		},
	},
	'unlicensed: see the plans': {
		options: { licensed: false },
		run: async (outcomes) => {
			await step(
				outcomes,
				'see plans',
				async () => await click(buttonByText(document.body, 'See plans')),
			);
		},
	},
	'the menu of each card': {
		run: async (outcomes) => {
			for (const displayName of DISPLAY_NAMES) {
				await mountPage();
				await step(outcomes, `menu of ${displayName}`, async () => await openCardMenu(displayName));
			}
		},
	},
	'reload the secrets of 1Password': {
		run: async (outcomes) => {
			await step(outcomes, 'menu', async () => await openCardMenu('1Password'));
			await step(outcomes, 'reload', async () => await clickMenuItem('action-reload'));
		},
	},
	'reload the secrets of HashiCorp Vault, the reload fails': {
		prepare: () => {
			server.failingReloads.add('vault');
		},
		run: async (outcomes) => {
			await step(outcomes, 'menu', async () => await openCardMenu('HashiCorp Vault'));
			await step(outcomes, 'reload', async () => await clickMenuItem('action-reload'));
		},
	},
	'disable 1Password on its card': {
		run: async (outcomes) => {
			await step(outcomes, 'switch', async () => await click(switchIn(card('1Password'))));
		},
	},
	'enable Infisical on its card': {
		run: async (outcomes) => {
			await step(outcomes, 'switch', async () => await click(switchIn(card('Infisical'))));
		},
	},
	'enable Infisical on its card, the test fails': {
		prepare: () => {
			server.failingTests.add('infisical');
		},
		run: async (outcomes) => {
			await step(outcomes, 'switch', async () => await click(switchIn(card('Infisical'))));
		},
	},
	'edit the connection of each configured provider': {
		run: async (outcomes) => {
			for (const displayName of ['HashiCorp Vault', '1Password', 'Infisical', 'Azure Key Vault']) {
				await mountPage();
				await step(
					outcomes,
					`open ${displayName}`,
					async () => await openProviderModal(displayName),
				);
				await step(outcomes, `close ${displayName}`, async () => {
					await closeModal();
					await settle();
				});
			}
		},
	},
	'set up AWS Secrets Manager': {
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openProviderModal('AWS Secrets Manager'));
			await step(outcomes, 'region', async () => await setField('region', 'eu-west-1'));
			await step(
				outcomes,
				'auto detect',
				async () => await selectOption('authMethod', 'Auto Detect'),
			);
			await step(outcomes, 'iam user', async () => await selectOption('authMethod', 'IAM User'));
			await step(outcomes, 'keys', async () => [
				await setField('accessKeyId', 'AKIAEXAMPLE'),
				await setField('secretAccessKey', 'secret-value'),
			]);
			await step(outcomes, 'save', async () => await click(saveButton()));
			await step(outcomes, 'enable in the modal', async () => await click(switchIn(modalRoot())));
			await step(outcomes, 'close', async () => {
				await closeModal();
				await settle();
			});
		},
	},
	'set up AWS Secrets Manager, the test fails': {
		prepare: () => {
			server.failingTests.add('awsSecretsManager');
		},
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openProviderModal('AWS Secrets Manager'));
			await step(outcomes, 'region', async () => await setField('region', 'eu-west-1'));
			await step(outcomes, 'save', async () => await click(saveButton()));
		},
	},
	'set up AWS Secrets Manager, close with changes and close': {
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openProviderModal('AWS Secrets Manager'));
			await step(outcomes, 'region', async () => await setField('region', 'eu-west-1'));
			confirmAnswers = ['cancel'];
			await step(outcomes, 'close', async () => {
				await closeModal();
				await settle();
			});
		},
	},
	'edit 1Password and save': {
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openProviderModal('1Password'));
			await step(outcomes, 'server url', async () => await setField('serverUrl', 'http://op:8080'));
			await step(outcomes, 'save', async () => await click(saveButton()));
			await step(outcomes, 'disable in the modal', async () => await click(switchIn(modalRoot())));
		},
	},
	'when Save is on and when a close asks': {
		run: async (outcomes) => {
			const fullData = { serverUrl: 'http://localhost:8080', accessToken: 'token' };
			const cases: Array<
				[string, Partial<Provider>, () => void, (() => Promise<unknown>) | undefined]
			> = [
				[
					'not connected, connected state, full settings',
					{ connected: false, state: 'connected', data: fullData },
					() => {},
					undefined,
				],
				[
					'not connected, tested, full settings',
					{ connected: false, state: 'tested', data: fullData },
					() => {},
					undefined,
				],
				[
					'not connected, tested, full settings, the test fails',
					{ connected: false, state: 'tested', data: fullData },
					() => server.failingTests.add('onePassword'),
					undefined,
				],
				[
					'connected, tested, full settings',
					{ connected: true, state: 'tested', data: fullData },
					() => {},
					undefined,
				],
				[
					'connected, an edit and its undo',
					{ connected: true, state: 'connected', data: fullData },
					() => {},
					async () => [
						await setField('serverUrl', 'http://other:8080'),
						await setField('serverUrl', 'http://localhost:8080'),
					],
				],
				[
					'connected, a new value in an empty field and its removal',
					{ connected: true, state: 'connected', data: { serverUrl: 'http://localhost:8080' } },
					() => {},
					async () => [
						await setField('accessToken', 'token'),
						await setField('accessToken', ''),
						await click(saveButton()),
					],
				],
				[
					'connected, a cleared required field',
					{ connected: true, state: 'connected', data: fullData },
					() => {},
					async () => [await setField('serverUrl', ''), await click(saveButton())],
				],
			];
			for (const [label, provider, prepare, edit] of cases) {
				await mountPage({}, () => {
					Object.assign(server.providers[0], provider);
					prepare();
				});
				await step(outcomes, `open, ${label}`, async () => await openProviderModal('1Password'));
				if (edit) await step(outcomes, `edit, ${label}`, edit);
				confirmAnswers = ['cancel'];
				await step(outcomes, `close, ${label}`, async () => {
					await closeModal();
					await settle();
				});
			}
		},
	},
	'the settings that count as changed when the modal opens': {
		run: async (outcomes) => {
			const azure = PROPERTIES.azureKeyVault;
			const infisical = PROPERTIES.infisical;
			const secret = {
				displayName: 'Client Secret',
				name: 'clientSecret',
				type: 'string',
				required: true,
				noDataExpression: true,
				default: '',
				typeOptions: { password: true },
			};
			const cases: Array<[string, number, Partial<Provider>, unknown[] | undefined]> = [
				['azure fixture', 2, {}, undefined],
				['azure, one value', 2, { data: { vaultName: 'my-vault' } }, undefined],
				[
					'azure, tested, a connection time',
					2,
					{ state: 'tested', connectedAt: '2026-01-04T12:00:00.000Z' },
					undefined,
				],
				['azure, a password field without a value', 2, {}, [...azure, secret]],
				[
					'azure, a password field with a blank value',
					2,
					{
						data: {
							vaultName: 'my-vault',
							tenantId: 'tenant',
							clientSecret: '__n8n_BLANK_VALUE_e5362baf',
						},
					},
					[...azure, secret],
				],
				[
					'azure, a password field with a value',
					2,
					{ data: { vaultName: 'my-vault', tenantId: 'tenant', clientSecret: 'x' } },
					[...azure, secret],
				],
				[
					'infisical, no password field',
					5,
					{ data: { siteURL: 'https://app.infisical.com', projectId: 'project' } },
					infisical.slice(0, 3),
				],
				[
					'infisical, no secret value',
					5,
					{ data: { siteURL: 'https://app.infisical.com', projectId: 'project' } },
					undefined,
				],
				[
					'azure, the fields of infisical',
					2,
					{ data: { siteURL: 'https://app.infisical.com', projectId: 'project' } },
					infisical.slice(0, 3),
				],
				[
					'infisical, the fields of azure',
					5,
					{ data: { vaultName: 'my-vault', tenantId: 'tenant' } },
					azure,
				],
				['azure, only the vault name', 2, { data: { vaultName: 'my-vault' } }, azure.slice(0, 2)],
				['azure, only the tenant', 2, { data: { tenantId: 'tenant' } }, [azure[0], azure[2]]],
				['infisical, only a vault name', 5, { data: { vaultName: 'my-vault' } }, azure.slice(0, 2)],
				[
					'aws, real settings',
					1,
					{
						data: {
							region: 'eu-west-1',
							authMethod: 'iamUser',
							accessKeyId: 'AKIA',
							secretAccessKey: '__n8n_BLANK_VALUE_e5362baf',
						},
					},
					undefined,
				],
				[
					'gcp, real settings',
					3,
					{ data: { serviceAccountKey: '__n8n_BLANK_VALUE_e5362baf' } },
					undefined,
				],
			];
			for (const [label, index, provider, properties] of cases) {
				await mountPage({}, () => {
					Object.assign(server.providers[index], provider);
					if (properties) server.properties[server.providers[index].name] = properties;
				});
				await step(
					outcomes,
					`open, ${label}`,
					async () => await openProviderModal(server.providers[index].displayName),
				);
				confirmAnswers = ['cancel'];
				await step(outcomes, `close, ${label}`, async () => {
					await closeModal();
					await settle();
				});
			}
		},
	},
	'the modal of HashiCorp Vault in each state': {
		run: async (outcomes) => {
			for (const connected of [true, false]) {
				for (const state of STATES) {
					const label = `${connected ? 'connected' : 'not connected'}, ${state}`;
					await mountPage({}, () => {
						Object.assign(server.providers[4], { connected, state });
					});
					await step(
						outcomes,
						`open, ${label}`,
						async () => await openProviderModal('HashiCorp Vault'),
					);
					confirmAnswers = ['cancel'];
					await step(outcomes, `close, ${label}`, async () => {
						await closeModal();
						await settle();
					});
				}
			}
		},
	},
	'edit 1Password, the save fails': {
		prepare: () => {
			server.failingSaves.add('onePassword');
		},
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openProviderModal('1Password'));
			await step(outcomes, 'server url', async () => await setField('serverUrl', 'http://op:8080'));
			await step(outcomes, 'save', async () => await click(saveButton()));
			confirmAnswers = ['cancel'];
			await step(outcomes, 'close', async () => {
				await closeModal();
				await settle();
			});
		},
	},
	'open 1Password, the reload fails': {
		prepare: () => {
			server.failingReloads.add('onePassword');
		},
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openProviderModal('1Password'));
		},
	},
	'edit 1Password, save while the server waits': {
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openProviderModal('1Password'));
			await step(outcomes, 'server url', async () => await setField('serverUrl', 'http://op:8080'));
			holdRequest('POST /external-secrets/providers/onePassword');
			await step(outcomes, 'save', async () => await click(saveButton()));
			await step(outcomes, 'the server answers', async () => {
				for (const release of releases) release();
				await settle();
			});
		},
	},
	'point at the warning icon of HashiCorp Vault': {
		run: async (outcomes) => {
			await step(outcomes, 'hover', async () => {
				const icon = card('HashiCorp Vault')?.querySelector('[data-icon="triangle-alert"]');
				if (!icon) return false;
				await fireEvent.mouseEnter(icon);
				await fireEvent.mouseOver(icon);
				await new Promise((resolve) => setTimeout(resolve, 300));
				await settle();
				return true;
			});
		},
	},
	'enable Infisical and Azure Key Vault on their cards with old settings': {
		prepare: () => {
			server.providers[5].data = {
				siteURL: 'https://app.infisical.com',
				token: 'old-token',
				cacheTTL: 300,
			};
			server.providers[2].data = { vaultName: 'my-vault', tenantId: 'tenant' };
		},
		run: async (outcomes) => {
			await step(outcomes, 'infisical', async () => await click(switchIn(card('Infisical'))));
			await step(outcomes, 'azure', async () => await click(switchIn(card('Azure Key Vault'))));
		},
	},
	'set up AWS Secrets Manager, close with changes and press Escape in the dialog': {
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openProviderModal('AWS Secrets Manager'));
			await step(outcomes, 'region', async () => await setField('region', 'eu-west-1'));
			confirmAnswers = ['close'];
			await step(outcomes, 'close', async () => {
				await closeModal();
				await settle();
			});
		},
	},
	'edit Infisical, enable it in the modal with unsaved changes': {
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openProviderModal('Infisical'));
			await step(
				outcomes,
				'site url',
				async () => await setField('siteURL', 'https://new.example.com'),
			);
			await step(outcomes, 'enable in the modal', async () => await click(switchIn(modalRoot())));
		},
	},
	'set up AWS Secrets Manager, close with changes and keep editing': {
		run: async (outcomes) => {
			await step(outcomes, 'open', async () => await openProviderModal('AWS Secrets Manager'));
			await step(outcomes, 'region', async () => await setField('region', 'eu-west-1'));
			confirmAnswers = ['confirm'];
			await step(outcomes, 'close', async () => {
				await closeModal();
				await settle();
			});
		},
	},
};

describe('The settings page of external secrets', () => {
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
		60_000,
	);
});

// #endregion
