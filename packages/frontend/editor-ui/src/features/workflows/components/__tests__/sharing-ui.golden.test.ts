// The behaviour of the editor sharing UI: the workflow share modal, the sharing tab of the
// credential modal, the sharing API helpers and the `workflowsEE` store. For a fixed set of users,
// projects, workflows and credentials, the test records what a user sees (texts, test ids,
// controls), what the UI sends to the server, and the toasts, dialogs, telemetry, events and store
// state that follow. It records no markup and no styles. packages/frontend/editor-ui/FORK.md
// tells how the fork made the snapshot.
import { setNotify } from '@n8n/composables/useToast';
import { setTelemetry, type Telemetry } from '@n8n/composables/registries/telemetryRegistry';
import { VIEWS } from '@n8n/frontend-constants/views';
import { defaultSettings } from '@n8n/frontend-test-utils';
import {
	ALL_ROLES,
	CREDENTIALS_SHARING_SCOPE_MAP,
	GLOBAL_SCOPE_MAP,
	getResourcePermissions,
	WORKFLOW_SHARING_SCOPE_MAP,
	type Scope,
} from '@n8n/permissions';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useRolesStore } from '@n8n/stores/roles.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';
import { createEventBus } from '@n8n/utils/event-bus';
import { fireEvent } from '@testing-library/vue';
import axios from 'axios';
import { ElMessageBox } from 'element-plus';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import {
	camelize,
	computed,
	createApp,
	defineComponent,
	h,
	isVNode,
	onMounted,
	onUnmounted,
	render as renderVNode,
	type PropType,
} from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

import { createComponentRenderer } from '@/__tests__/render';
import { getWorkflow } from '@/app/api/workflows';
import { WORKFLOW_SHARE_MODAL_KEY } from '@/app/constants';
import { WorkflowIdKey } from '@/app/constants/injectionKeys';
import { useUIStore } from '@/app/stores/ui.store';
import {
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { useWorkflowsListStore } from '@/app/stores/workflowsList.store';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import type {
	ProjectListItem,
	ProjectSharingData,
} from '@/features/collaboration/projects/projects.types';

// The modules under test.
import WorkflowShareModal from '@/features/workflows/components/WorkflowShareModal.vue';
import CredentialSharing from '@/features/credentials/components/CredentialEdit/CredentialSharing.vue';
import * as workflowSharingApi from '@/app/api/workflowSharing';
import * as credentialSharingApi from '@/features/credentials/credentialSharing.api';
import { useWorkflowsEEStore } from '@/app/stores/workflowSharing.store';

// #region Recording

type Outcomes = Record<string, unknown>;
let log: unknown[] = [];

const UNCHANGED = '<unchanged>';

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;
const isCheckpoint = (value: unknown): value is Record<string, unknown> =>
	isRecord(value) && 'dom' in value;

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

const PROJECT_KEYS = ['id', 'name', 'type', 'icon', 'createdAt', 'updatedAt'];

/** A project as one line: its id, type and name, and the keys that a fixture project has not. */
function projectLine(value: Record<string, unknown>, depth: number) {
	const rest = Object.fromEntries(
		Object.entries(value).filter(([key]) => !PROJECT_KEYS.includes(key)),
	);
	const line = `project ${String(value.id)} ${String(value.type)} ${String(value.name)}`;
	if (!Object.keys(rest).length) return line;
	// Single quotes, so that the snapshot stays valid JavaScript.
	return `${line} ${JSON.stringify(plain(rest, depth + 1)).replaceAll('"', "'")}`;
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

function plain(value: unknown, depth = 0): unknown {
	if (typeof value === 'function') return '<function>';
	if (value === undefined) return '<undefined>';
	if (value === null || typeof value !== 'object') return value;
	if (isVNode(value)) return vnodeText(value);
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (depth > 8) return '<deep>';
	if (Array.isArray(value)) return value.map((entry) => plain(entry, depth + 1));
	if ('on' in value && 'emit' in value && 'off' in value) return '<eventBus>';
	const record = value as Record<string, unknown>;
	if ('id' in record && 'type' in record && 'name' in record && 'createdAt' in record) {
		return projectLine(record, depth);
	}
	if ('slug' in record && 'roleType' in record && 'scopes' in record) {
		const { slug, scopes, ...rest } = record;
		const count = Array.isArray(scopes) ? scopes.length : scopes;
		return `role ${String(slug)} ${JSON.stringify(plain({ ...rest, scopes: count }, depth + 1)).replaceAll('"', "'")}`;
	}
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => [key, plain(entry, depth + 1)]),
	);
}

/** The props that the UI passes to each mounted `ProjectSharing`, an ordinary component. */
const sharingInstances: Array<Record<string, unknown>> = [];

vi.mock(
	'@/features/collaboration/projects/components/ProjectSharing.vue',
	async (importOriginal) => {
		const { default: Original } = await importOriginal<{ default: object }>();
		return {
			default: defineComponent({
				name: 'ProjectSharing',
				inheritAttrs: false,
				setup(_, { attrs, slots }) {
					onMounted(() => sharingInstances.push(attrs));
					onUnmounted(() => sharingInstances.splice(sharingInstances.indexOf(attrs), 1));
					return () => h(Original, attrs, slots);
				},
			}),
		};
	},
);

function sharingAttrs(index = 0): Record<string, unknown> {
	const attrs = sharingInstances[index];
	if (!attrs) throw new Error('No ProjectSharing is mounted');
	return Object.fromEntries(Object.entries(attrs).map(([key, value]) => [camelize(key), value]));
}

function call(attrs: Record<string, unknown>, name: string, ...args: unknown[]) {
	const handler = attrs[name];
	if (typeof handler === 'function') return handler(...args);
	if (Array.isArray(handler)) {
		for (const entry of handler) if (typeof entry === 'function') entry(...args);
	}
	return undefined;
}

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

function describeElement(element: Element) {
	const disabled =
		element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';
	const busy = element.getAttribute('aria-busy') === 'true';
	const label =
		element.getAttribute('aria-label') ??
		element.getAttribute('placeholder') ??
		normalize(element.textContent);
	return `${element.tagName.toLowerCase()}${disabled ? ' [disabled]' : ''}${busy ? ' [busy]' : ''}: ${label}`;
}

function isHidden(element: Element | null): boolean {
	for (let current = element; current; current = current.parentElement) {
		if (current.hasAttribute('hidden')) return true;
		if (current instanceof HTMLElement && current.style.display === 'none') return true;
	}
	return false;
}

/** What a user sees: the text, the elements with a test id, and the controls. */
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
		controls: [...root.querySelectorAll('button, input, textarea, a[href]')].map(describeElement),
	};
}

const candidates = () => Object.values(PROJECTS);

/** The props of the mounted `ProjectSharing`, with the result of its function props. */
function describeSharing() {
	return sharingInstances.map((_, index) => {
		const attrs = sharingAttrs(index);
		// A prop with `undefined` is the same as a prop that is not there: Vue uses its default.
		const given = Object.fromEntries(
			Object.entries(attrs).filter(([, value]) => value !== undefined),
		);
		const entry: Record<string, unknown> = { props: plain(given) };
		if (typeof attrs.filterFn === 'function') {
			const filter = attrs.filterFn as (project: unknown) => unknown;
			entry.filterFn = Object.fromEntries(
				candidates().map((project) => [project.id, plain(filter(project))]),
			);
		}
		if (typeof attrs.confirmRemoval === 'function') {
			const confirmRemoval = attrs.confirmRemoval as (project: unknown) => unknown;
			entry.confirmRemoval = Object.fromEntries(
				candidates().map((project) => [project.id, oneLine(confirmRemoval(project))]),
			);
		}
		return entry;
	});
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
type Handler = (request: Request) => unknown;
const routes: Array<[string, RegExp, Handler]> = [];
const route = (method: string, pattern: RegExp, handler: Handler) =>
	routes.push([method, pattern, handler]);

/** Errors for the requests to a route: `METHOD path` to a status and a message. */
const failures = new Map<string, { status: number; message: string }>();
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
		const request = { method, url, path, params: config.params, data: config.data };
		log.push(['request', requestLine(method, url, config.params, config.data)]);
		await holds.get(`${method} ${path}`);
		const failure = failures.get(`${method} ${path}`);
		if (failure) {
			throw Object.assign(new Error('Request failed'), {
				response: {
					status: failure.status,
					data: { message: failure.message, code: failure.status },
				},
			});
		}
		const match = routes.find(([m, pattern]) => m === method && pattern.test(path));
		if (!match) {
			log.push(['unrouted', `${method} ${url}`]);
			throw Object.assign(new Error('Not found'), {
				response: { status: 404, data: { message: `Not found: ${method} ${path}` } },
			});
		}
		return { data: match[2](request) };
	});
}

// #endregion

// #region Fixture

const now = '2026-01-01T00:00:00.000Z';
const project = (id: string, name: string, type: 'personal' | 'team'): ProjectSharingData => ({
	id,
	name,
	type,
	icon: type === 'team' ? { type: 'icon', value: 'layers' } : null,
	createdAt: now,
	updatedAt: now,
});

const USERS = {
	owner: {
		id: 'u-owner',
		email: 'owner@n8n.test',
		firstName: 'Olive',
		lastName: 'Owner',
		role: 'global:owner',
	},
	admin: {
		id: 'u-admin',
		email: 'admin@n8n.test',
		firstName: 'Ada',
		lastName: 'Admin',
		role: 'global:admin',
	},
	memberA: {
		id: 'u-a',
		email: 'a@n8n.test',
		firstName: 'Ann',
		lastName: 'Alpha',
		role: 'global:member',
	},
	memberB: {
		id: 'u-b',
		email: 'b@n8n.test',
		firstName: 'Ben',
		lastName: 'Beta',
		role: 'global:member',
	},
	memberC: {
		id: 'u-c',
		email: 'c@n8n.test',
		firstName: 'Cleo',
		lastName: 'Gamma',
		role: 'global:member',
	},
} as const;
type UserKey = keyof typeof USERS;

const PROJECTS = {
	personalOwner: project('p-owner', 'Olive Owner <owner@n8n.test>', 'personal'),
	personalAdmin: project('p-admin', 'Ada Admin <admin@n8n.test>', 'personal'),
	personalA: project('p-a', 'Ann Alpha <a@n8n.test>', 'personal'),
	personalB: project('p-b', 'Ben Beta <b@n8n.test>', 'personal'),
	personalC: project('p-c', 'Cleo Gamma <c@n8n.test>', 'personal'),
	team: project('p-team', 'Team Alpha', 'team'),
	team2: project('p-team2', 'Team Beta', 'team'),
};

const PERSONAL: Record<UserKey, ProjectSharingData> = {
	owner: PROJECTS.personalOwner,
	admin: PROJECTS.personalAdmin,
	memberA: PROJECTS.personalA,
	memberB: PROJECTS.personalB,
	memberC: PROJECTS.personalC,
};

/** The team projects and the role of each member. */
const TEAM_MEMBERS: Record<string, Partial<Record<UserKey, string>>> = {
	'p-team': { memberA: 'project:admin', memberB: 'project:editor', memberC: 'project:viewer' },
	'p-team2': { memberB: 'project:admin', admin: 'project:editor' },
};

const OWNER_SCOPES = [...WORKFLOW_SHARING_SCOPE_MAP['workflow:owner']].sort();
const SCOPES = {
	all: OWNER_SCOPES,
	noShare: OWNER_SCOPES.filter((scope) => scope !== 'workflow:share'),
	noUnshare: OWNER_SCOPES.filter((scope) => scope !== 'workflow:unshare'),
	editor: [...WORKFLOW_SHARING_SCOPE_MAP['workflow:editor']].sort(),
	read: ['workflow:read'] as Scope[],
	none: [] as Scope[],
};
type ScopeKey = keyof typeof SCOPES;

const CREDENTIAL_OWNER_SCOPES = [...CREDENTIALS_SHARING_SCOPE_MAP['credential:owner']].sort();
const CREDENTIAL_SCOPES = {
	all: CREDENTIAL_OWNER_SCOPES,
	noShare: CREDENTIAL_OWNER_SCOPES.filter((scope) => scope !== 'credential:share'),
	user: [...CREDENTIALS_SHARING_SCOPE_MAP['credential:user']].sort(),
	read: ['credential:read'] as Scope[],
};
type CredentialScopeKey = keyof typeof CREDENTIAL_SCOPES;

type WorkflowFixture = {
	id: string;
	name: string;
	homeProject?: ProjectSharingData;
	sharedWithProjects?: ProjectSharingData[];
};

const WORKFLOWS = {
	personalA: {
		id: 'wf-a',
		name: 'Ann workflow',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [PROJECTS.personalB],
	},
	personalAUnshared: {
		id: 'wf-a2',
		name: 'Ann private workflow',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
	},
	personalOwner: {
		id: 'wf-owner',
		name: 'Olive workflow',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [PROJECTS.personalA, PROJECTS.personalC],
	},
	team: {
		id: 'wf-team',
		name: 'Team workflow',
		homeProject: PROJECTS.team,
		sharedWithProjects: [PROJECTS.personalB],
	},
	teamUnshared: {
		id: 'wf-team2',
		name: 'Team private workflow',
		homeProject: PROJECTS.team,
		sharedWithProjects: [],
	},
	noHome: {
		id: 'wf-nohome',
		name: 'Workflow without a home project',
	},
	newWorkflow: {
		id: 'wf-new',
		name: 'My workflow',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
	},
} satisfies Record<string, WorkflowFixture>;
type WorkflowKey = keyof typeof WORKFLOWS;

/** The state of the fake server for one case. */
const server = {
	user: 'memberA' as UserKey,
	workflowScopes: new Map<string, Scope[]>(),
	/** Give a result from the share and transfer routes, to see what the helpers return. */
	resultMarker: false,
	customRoles: false,
	/** The workflows that use each credential: id, name and owning project. */
	credentialUsage: new Map<string, Array<[string, string, string]>>(),
	/** The number of workflows that use a credential and that the user cannot see. */
	inaccessibleUsage: 0,
};

/** The scopes of a resource for the current user: their global scopes and their role scopes. */
function resourceScopes(namespace: 'workflow' | 'credential', scopes: Scope[]) {
	const global = GLOBAL_SCOPE_MAP[USERS[server.user].role].filter((scope) =>
		scope.startsWith(`${namespace}:`),
	);
	return [...new Set([...global, ...scopes])].sort();
}

function projectFor(id: string) {
	const found = candidates().find((entry) => entry.id === id);
	if (!found) return undefined;
	const members = TEAM_MEMBERS[id] ?? {};
	const owner = (Object.keys(PERSONAL) as UserKey[]).find((key) => PERSONAL[key].id === id);
	const relations =
		found.type === 'personal' && owner
			? [{ ...USERS[owner], role: 'project:personalOwner' }]
			: (Object.entries(members) as Array<[UserKey, string]>).map(([key, role]) => ({
					...USERS[key],
					role,
				}));
	// The backend sends the owner and the admins of the instance as implicit members of a team.
	const implicitMembers =
		found.type === 'team'
			? (['owner', 'admin'] as const).map((key) => ({
					id: USERS[key].id,
					email: USERS[key].email,
					firstName: USERS[key].firstName,
					lastName: USERS[key].lastName,
					globalRole: { slug: USERS[key].role, displayName: key === 'owner' ? 'Owner' : 'Admin' },
				}))
			: [];
	return { ...found, relations, implicitMembers, scopes: [], rolesManaged: false };
}

function workflowResponse(fixture: WorkflowFixture) {
	return {
		...fixture,
		description: null,
		active: false,
		isArchived: false,
		createdAt: now,
		updatedAt: now,
		nodes: [],
		connections: {},
		settings: {},
		tags: [],
		versionId: `${fixture.id}-v1`,
		activeVersionId: null,
		scopes: resourceScopes('workflow', server.workflowScopes.get(fixture.id) ?? []),
	};
}

function listProjects(params: unknown) {
	const { search, type } = (params ?? {}) as { search?: string; type?: string };
	const data = candidates()
		.filter((entry) => !type || entry.type === type)
		.filter((entry) => !search || (entry.name ?? '').toLowerCase().includes(search.toLowerCase()))
		.map((entry) => ({ ...entry, role: 'project:personalOwner' }));
	return { count: data.length, data };
}

function setupRoutes() {
	routes.length = 0;
	route('GET', /^\/projects\/my-projects$/, () => ({
		data: [
			{ ...PERSONAL[server.user], role: 'project:personalOwner' },
			...Object.entries(TEAM_MEMBERS)
				.filter(([, members]) => members[server.user])
				.map(([id, members]) => ({
					...candidates().find((entry) => entry.id === id),
					role: members[server.user],
				})),
		],
	}));
	route('GET', /^\/projects\/personal$/, () => ({ data: projectFor(PERSONAL[server.user].id) }));
	route('GET', /^\/projects\/count$/, () => ({ data: { personal: 5, team: 2, public: 0 } }));
	route('GET', /^\/projects\/sharing-candidates$/, ({ params }) => listProjects(params));
	route('GET', /^\/projects$/, ({ params }) => listProjects(params));
	route('GET', /^\/projects\/[^/]+$/, ({ path }) => {
		const found = projectFor(path.split('/')[2]);
		if (!found) throw new Error(`No project ${path}`);
		return { data: found };
	});
	route('GET', /^\/roles$/, () => ({ data: server.customRoles ? CUSTOM_ROLES : ALL_ROLES }));
	route('GET', /^\/workflows\/[^/]+$/, ({ path }) => {
		const fixture = Object.values(WORKFLOWS).find(({ id }) => path === `/workflows/${id}`);
		if (!fixture) throw new Error(`No workflow ${path}`);
		return { data: workflowResponse(fixture) };
	});
	const result = () => (server.resultMarker ? { data: '<server result>' } : {});
	route('POST', /^\/workflows$/, ({ data }) => {
		const body = (data ?? {}) as { id?: string };
		const fixture = Object.values(WORKFLOWS).find(({ id }) => id === body.id);
		return { data: { ...(fixture ? workflowResponse(fixture) : {}), ...body } };
	});
	route('PUT', /^\/workflows\/[^/]+\/share$/, result);
	route('PUT', /^\/workflows\/[^/]+\/transfer$/, ({ data }) =>
		(data as { destinationProjectId?: string } | undefined)?.destinationProjectId ===
		'p-activation-error'
			? { data: { error: { message: 'Activation failed', name: 'WorkflowActivationError' } } }
			: result(),
	);
	route('PUT', /^\/credentials\/[^/]+\/share$/, result);
	route('PUT', /^\/credentials\/[^/]+\/transfer$/, result);
	route('PUT', /^\/projects\/[^/]+\/folders\/[^/]+\/transfer$/, result);
	route('POST', /^\/workflow-dependencies\/details$/, ({ data }) => {
		const { resourceIds = [], resourceType } = (data ?? {}) as {
			resourceIds?: string[];
			resourceType?: string;
		};
		if (resourceType !== 'credential') return { data: {} };
		return {
			data: Object.fromEntries(
				resourceIds.map((id) => [
					id,
					{
						dependencies: (server.credentialUsage.get(id) ?? []).map(
							([workflowId, name, projectId]) => ({
								type: 'workflowParent',
								id: workflowId,
								name,
								projectId,
							}),
						),
						inaccessibleCount: server.inaccessibleUsage,
					},
				]),
			),
		};
	});
}

// #endregion

// #region Setup

let pinia: Pinia;
let router: Router;
let confirmAnswers: string[] = [];
/** Unmount of the last render: each mount first unmounts the one before it. */
let unmountLast: (() => void) | undefined;

function unmountPrevious() {
	unmountLast?.();
	unmountLast = undefined;
	sharingInstances.length = 0;
	modalApi.close = undefined;
	modalApi.props = undefined;
}

const Empty = defineComponent({ render: () => null });

type AppOptions = {
	sharing?: boolean;
	granularCredentialSharing?: boolean;
	/** Turn on every boolean licence feature, not only sharing. */
	allFeatures?: boolean;
	/** An n8n cloud instance. */
	cloud?: boolean;
	/** Give the projects store the personal project of another user. */
	personalProjectOf?: UserKey;
	/** Leave the global scopes out of the RBAC store, but keep them on the user. */
	noRbacScopes?: boolean;
	/** Add a custom workflow role and a custom credential role to `GET /roles`. */
	customRoles?: boolean;
	/** The env feature flag `N8N_ENV_FEAT_CRED_SHARING`. */
	credSharingFlag?: boolean;
	/** The licence limit of team projects, else the default of the test settings. */
	teamProjectLimit?: number;
};

const CUSTOM_ROLES = {
	...ALL_ROLES,
	workflow: [
		...ALL_ROLES.workflow,
		{
			slug: 'workflow:custom',
			displayName: 'Custom workflow role',
			description: 'Custom',
			scopes: ['workflow:read'],
			licensed: true,
			systemRole: false,
			roleType: 'workflow',
		},
	],
	credential: [
		...ALL_ROLES.credential,
		{
			slug: 'credential:custom',
			displayName: 'Custom credential role',
			description: 'Custom',
			scopes: ['credential:read'],
			licensed: true,
			systemRole: false,
			roleType: 'credential',
		},
	],
};

function enterpriseSettings(options: AppOptions) {
	const enterprise = { ...defaultSettings.enterprise };
	if (options.allFeatures) {
		for (const [key, value] of Object.entries(enterprise)) {
			if (typeof value === 'boolean') Object.assign(enterprise, { [key]: true });
		}
	}
	enterprise.sharing = options.sharing ?? true;
	if (options.teamProjectLimit !== undefined) {
		enterprise.projects = {
			...enterprise.projects,
			team: { ...enterprise.projects.team, limit: options.teamProjectLimit },
		};
	}
	return enterprise;
}

async function setupApp(user: UserKey, options: AppOptions = {}) {
	unmountPrevious();
	pinia = createPinia();
	setActivePinia(pinia);
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/', name: VIEWS.HOMEPAGE, component: Empty },
			{ path: '/home/workflows', name: VIEWS.WORKFLOWS, component: Empty },
			{ path: '/workflow/:workflowId/:nodeId?', name: VIEWS.WORKFLOW, component: Empty },
		],
	});
	await router.push('/');
	// As in the app, the stores start inside an app with the router, so they can read the route.
	createApp(Empty).use(router).use(pinia);
	server.user = user;
	server.workflowScopes = new Map();
	server.resultMarker = false;
	server.credentialUsage = new Map();
	server.inaccessibleUsage = 0;
	failures.clear();
	holds.clear();
	releases.length = 0;
	confirmAnswers = [];
	setupRoutes();
	installServer();

	useSettingsStore().setSettings({
		...defaultSettings,
		enterprise: enterpriseSettings(options),
		granularCredentialSharing: options.granularCredentialSharing ?? false,
		deployment: { ...defaultSettings.deployment, type: options.cloud ? 'cloud' : 'default' },
		envFeatureFlags: options.credSharingFlag ? { N8N_ENV_FEAT_CRED_SHARING: 'true' } : {},
	});
	const usersStore = useUsersStore();
	// As the login response: each user with the scopes of their global role.
	usersStore.addUsers(
		Object.values(USERS).map((entry) => ({
			...entry,
			isPending: false,
			globalScopes: GLOBAL_SCOPE_MAP[entry.role],
		})),
	);
	usersStore.currentUserId = USERS[user].id;
	if (!options.noRbacScopes) useRBACStore().setGlobalScopes(GLOBAL_SCOPE_MAP[USERS[user].role]);
	server.customRoles = options.customRoles ?? false;
	const projectsStore = useProjectsStore();
	await Promise.all([projectsStore.getMyProjects(), projectsStore.getPersonalProject()]);
	if (options.personalProjectOf) {
		const other = projectFor(PERSONAL[options.personalProjectOf].id);
		if (other) projectsStore.personalProject = other as typeof projectsStore.personalProject;
	}
	await useRolesStore().fetchRoles();
	log = [];
}

/** Open the workflow in the editor, as the editor does: the current id and its document store. */
async function openInEditor(id: string) {
	const data = await useWorkflowsListStore().fetchWorkflow(id);
	await router.push({ name: VIEWS.WORKFLOW, params: { workflowId: id } });
	useWorkflowsStore().setWorkflowId(id);
	useWorkflowDocumentStore(createWorkflowDocumentId(id)).hydrate(data);
}

/**
 * A new workflow in the editor, not saved yet: the route has `new=true`, and only the editor
 * document has the workflow, not the workflow list.
 */
async function openNewInEditor(id: string) {
	const data = await getWorkflow(useRootStore().restApiContext, id);
	await router.push({ name: VIEWS.WORKFLOW, params: { workflowId: id }, query: { new: 'true' } });
	useWorkflowsStore().setWorkflowId(id);
	useWorkflowDocumentStore(createWorkflowDocumentId(id)).hydrate(data);
}

/** Show the workflow in the workflow list, as the list page does. */
async function showInList(id: string) {
	await router.push({ name: VIEWS.WORKFLOWS });
	await useWorkflowsListStore().fetchWorkflow(id);
}

/** Put a new workflow in the editor stores, but not in the route. */
async function keepNewInEditorStores(id: string) {
	const data = await getWorkflow(useRootStore().restApiContext, id);
	useWorkflowsStore().setWorkflowId(id);
	useWorkflowDocumentStore(createWorkflowDocumentId(id)).hydrate(data);
}

/** Empty the roles store, as before the app loads the roles. */
function clearRoles() {
	useRolesStore().roles = {
		global: [],
		project: [],
		credential: [],
		workflow: [],
		secretsProviderConnection: [],
	};
}

/** Empty the projects of the user in the projects store, as before the app loads them. */
function clearMyProjects() {
	const projectsStore = useProjectsStore();
	projectsStore.myProjects = [];
	projectsStore.personalProject = null;
}

/** All projects, as the projects store lists them for a user who may list all projects. */
const allProjectItems = () =>
	candidates().map((entry) => ({
		...entry,
		role: entry.type === 'team' ? 'project:editor' : 'project:personalOwner',
	})) as unknown as ProjectListItem[];

beforeEach(() => {
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
	unmountPrevious();
	vi.restoreAllMocks();
});

// #endregion

// #region Workflow share modal

type ModalCase = AppOptions & {
	user: UserKey;
	workflow: WorkflowKey;
	scopes: ScopeKey;
	context: 'editor' | 'new' | 'list' | 'none';
	/** Change the stores or the server after the context is set up, before the modal opens. */
	prepare?: (id: string) => void | Promise<void>;
	/** Record only the opening, and the opening after the held requests are released. */
	onlyOpen?: boolean;
	/** Add a project and close while the held requests wait, then release them. */
	changeWhileHeld?: boolean;
	/** Add a project, then save or close while the held requests wait, then release them. */
	saveWhileHeld?: boolean;
};

const MODAL_CASES: Record<string, ModalCase> = {
	'memberA own personal workflow with share': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
	},
	'memberA own personal workflow without share': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'noShare',
		context: 'editor',
	},
	'memberA own personal workflow without unshare': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'noUnshare',
		context: 'editor',
	},
	'memberA own unshared workflow': {
		user: 'memberA',
		workflow: 'personalAUnshared',
		scopes: 'all',
		context: 'editor',
	},
	'memberA shared workflow of the owner as editor': {
		user: 'memberA',
		workflow: 'personalOwner',
		scopes: 'editor',
		context: 'editor',
	},
	'memberA team workflow as project admin': {
		user: 'memberA',
		workflow: 'team',
		scopes: 'all',
		context: 'editor',
	},
	'memberC team workflow as project viewer': {
		user: 'memberC',
		workflow: 'team',
		scopes: 'read',
		context: 'editor',
	},
	'memberB team workflow as editor without share': {
		user: 'memberB',
		workflow: 'teamUnshared',
		scopes: 'editor',
		context: 'editor',
	},
	'owner personal workflow of memberA': {
		user: 'owner',
		workflow: 'personalA',
		scopes: 'none',
		context: 'editor',
	},
	'owner own personal workflow': {
		user: 'owner',
		workflow: 'personalOwner',
		scopes: 'all',
		context: 'editor',
	},
	'admin team workflow': { user: 'admin', workflow: 'team', scopes: 'none', context: 'editor' },
	'memberA new workflow': {
		user: 'memberA',
		workflow: 'newWorkflow',
		scopes: 'all',
		context: 'new',
	},
	'memberA own workflow in the list': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'list',
	},
	'memberA team workflow in the list': {
		user: 'memberA',
		workflow: 'team',
		scopes: 'all',
		context: 'list',
	},
	'memberA shared workflow in the list': {
		user: 'memberA',
		workflow: 'personalOwner',
		scopes: 'editor',
		context: 'list',
	},
	'memberA own workflow, not loaded': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'none',
	},
	'memberA own workflow without the sharing licence': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		sharing: false,
	},
	'owner team workflow without the sharing licence': {
		user: 'owner',
		workflow: 'team',
		scopes: 'none',
		context: 'list',
		sharing: false,
	},
	'memberA own workflow without the sharing licence on cloud': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		sharing: false,
		cloud: true,
	},
	'owner team workflow without the sharing licence on cloud': {
		user: 'owner',
		workflow: 'team',
		scopes: 'none',
		context: 'list',
		sharing: false,
		cloud: true,
	},
	'memberA own workflow on cloud': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		cloud: true,
	},
	'memberA workflow without a home project': {
		user: 'memberA',
		workflow: 'noHome',
		scopes: 'all',
		context: 'editor',
	},
	'memberA own workflow, all licence features': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		allFeatures: true,
	},
	'memberA team workflow as project admin, all licence features': {
		user: 'memberA',
		workflow: 'team',
		scopes: 'all',
		context: 'editor',
		allFeatures: true,
	},
	'memberA own workflow, editor and list differ, the workflow request waits': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		onlyOpen: true,
		prepare: (id) => {
			useWorkflowDocumentStore(createWorkflowDocumentId(id)).setSharedWithProjects([
				PROJECTS.personalC,
			]);
			holdRequest(`GET /workflows/${id}`);
		},
	},
	'memberA own workflow in the list, the list differs, the workflow request waits': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'list',
		onlyOpen: true,
		prepare: (id) => {
			useWorkflowsListStore().updateWorkflowInCache(id, {
				sharedWithProjects: [PROJECTS.personalC],
			});
			holdRequest(`GET /workflows/${id}`);
		},
	},
	'memberA own workflow, changed while the workflow request waits': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		changeWhileHeld: true,
		prepare: (id) => holdRequest(`GET /workflows/${id}`),
	},
	'memberA own workflow in the list, changed while the workflow request waits': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'list',
		changeWhileHeld: true,
		prepare: (id) => holdRequest(`GET /workflows/${id}`),
	},
	'memberA own workflow, the workflow request fails': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		prepare: (id) => {
			failures.set(`GET /workflows/${id}`, { status: 500, message: 'Load failed' });
		},
	},
	'memberA own workflow in the list, the workflow request fails': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'list',
		prepare: (id) => {
			failures.set(`GET /workflows/${id}`, { status: 500, message: 'Load failed' });
		},
	},
	'memberA team workflow, the project request fails': {
		user: 'memberA',
		workflow: 'team',
		scopes: 'all',
		context: 'editor',
		prepare: () => {
			failures.set('GET /projects/p-team', { status: 404, message: 'Not found' });
		},
	},
	'memberA team workflow, the workflow request fails': {
		user: 'memberA',
		workflow: 'team',
		scopes: 'all',
		context: 'editor',
		prepare: (id) => {
			failures.set(`GET /workflows/${id}`, { status: 500, message: 'Load failed' });
		},
	},
	'memberA team workflow, the workflow request waits': {
		user: 'memberA',
		workflow: 'team',
		scopes: 'all',
		context: 'editor',
		onlyOpen: true,
		prepare: (id) => holdRequest(`GET /workflows/${id}`),
	},
	'memberA own workflow, the share request waits': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		saveWhileHeld: true,
		prepare: (id) => holdRequest(`PUT /workflows/${id}/share`),
	},
	'memberA new workflow, the first save waits': {
		user: 'memberA',
		workflow: 'newWorkflow',
		scopes: 'all',
		context: 'new',
		saveWhileHeld: true,
		prepare: () => holdRequest('POST /workflows'),
	},
	'memberA own workflow in the list, a new workflow in the editor stores': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'list',
		prepare: async () => await keepNewInEditorStores(WORKFLOWS.newWorkflow.id),
	},
	'memberA new workflow, without its id in the workflows store': {
		user: 'memberA',
		workflow: 'newWorkflow',
		scopes: 'all',
		context: 'new',
		prepare: () => useWorkflowsStore().setWorkflowId(''),
	},
	'memberA new workflow, on the workflow list page': {
		user: 'memberA',
		workflow: 'newWorkflow',
		scopes: 'all',
		context: 'new',
		prepare: async () => {
			await router.push({ name: VIEWS.WORKFLOWS });
		},
	},
	'memberA own workflow, without its id in the workflows store, editor and list differ': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		prepare: (id) => {
			useWorkflowDocumentStore(createWorkflowDocumentId(id)).setSharedWithProjects([
				PROJECTS.personalC,
			]);
			useWorkflowsStore().setWorkflowId('');
		},
	},
	'memberA own workflow, on the workflow list page, editor and list differ': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		prepare: async (id) => {
			useWorkflowDocumentStore(createWorkflowDocumentId(id)).setSharedWithProjects([
				PROJECTS.personalC,
			]);
			await router.push({ name: VIEWS.WORKFLOWS });
		},
	},
	'memberA own workflow on the workflow list page, without its id in the workflows store, editor and list differ':
		{
			user: 'memberA',
			workflow: 'personalA',
			scopes: 'all',
			context: 'editor',
			prepare: async (id) => {
				useWorkflowDocumentStore(createWorkflowDocumentId(id)).setSharedWithProjects([
					PROJECTS.personalC,
				]);
				useWorkflowsStore().setWorkflowId('');
				await router.push({ name: VIEWS.WORKFLOWS });
			},
		},
	'memberA own workflow, no home project in the editor document': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		prepare: (id) => useWorkflowDocumentStore(createWorkflowDocumentId(id)).setHomeProject(null),
	},
	'memberA own workflow, team projects in the list of all projects': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		prepare: () => {
			useProjectsStore().projects = allProjectItems();
		},
	},
	'memberA own workflow, a team project owns it in the editor document': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		prepare: (id) =>
			useWorkflowDocumentStore(createWorkflowDocumentId(id)).setHomeProject(PROJECTS.team),
	},
	'memberA new workflow in its editor document, another saved workflow open in the editor': {
		user: 'memberA',
		workflow: 'newWorkflow',
		scopes: 'all',
		context: 'none',
		prepare: async (id) => {
			await openInEditor(WORKFLOWS.personalA.id);
			const data = await getWorkflow(useRootStore().restApiContext, id);
			useWorkflowDocumentStore(createWorkflowDocumentId(id)).hydrate(data);
		},
	},
	'memberA own workflow, the server gives no scopes': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		prepare: (id) => {
			server.workflowScopes.set(id, SCOPES.none);
		},
	},
	'memberA own workflow, the server no longer gives the share scope': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		prepare: (id) => {
			server.workflowScopes.set(id, SCOPES.noShare);
		},
	},
	'memberA own workflow, the editor document has no scopes': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		prepare: (id) => useWorkflowDocumentStore(createWorkflowDocumentId(id)).setScopes([]),
	},
	'memberA own workflow, the editor document lacks the share scope': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		prepare: (id) =>
			useWorkflowDocumentStore(createWorkflowDocumentId(id)).setScopes(
				resourceScopes('workflow', SCOPES.noShare),
			),
	},
	'memberA own workflow, no roles in the store': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		prepare: clearRoles,
	},
	'memberA own workflow, no projects of the user in the store': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		prepare: clearMyProjects,
	},
	'memberA own workflow in the editor, not in the list': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		prepare: (id) => useWorkflowsListStore().removeWorkflow(id),
	},
	'memberA new workflow, the first save fails': {
		user: 'memberA',
		workflow: 'newWorkflow',
		scopes: 'all',
		context: 'new',
		prepare: () => {
			failures.set('POST /workflows', { status: 500, message: 'Save failed' });
		},
	},
	'memberA team workflow, the project request waits': {
		user: 'memberA',
		workflow: 'team',
		scopes: 'all',
		context: 'editor',
		onlyOpen: true,
		prepare: () => holdRequest('GET /projects/p-team'),
	},
	'memberA own workflow without share, personal project of memberB in the store': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'noShare',
		context: 'editor',
		personalProjectOf: 'memberB',
	},
	'memberA shared workflow of the owner, personal project of the owner in the store': {
		user: 'memberA',
		workflow: 'personalOwner',
		scopes: 'editor',
		context: 'editor',
		personalProjectOf: 'owner',
	},
	'memberA own workflow, custom roles': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		customRoles: true,
	},
	'owner own workflow, no RBAC scopes': {
		user: 'owner',
		workflow: 'personalOwner',
		scopes: 'all',
		context: 'editor',
		noRbacScopes: true,
	},
	'memberA own workflow with granular credential sharing': {
		user: 'memberA',
		workflow: 'personalA',
		scopes: 'all',
		context: 'editor',
		granularCredentialSharing: true,
	},
};

/** Errors that reach Vue, for example from an async hook: the record keeps their message. */
const errorHandler = (error: unknown) => {
	log.push(['vue error', plain(error)]);
};

/** What `App.vue` provides: the id of the workflow in the route. */
const appProvides = () => ({
	[WorkflowIdKey as symbol]: computed(() => {
		const id = router.currentRoute.value.params.workflowId;
		return (Array.isArray(id) ? id[0] : id) ?? '';
	}),
});

const renderModal = (props: Record<string, unknown>) =>
	createComponentRenderer(WorkflowShareModal, {
		global: {
			stubs: { Modal: ModalStub },
			plugins: [router],
			provide: appProvides(),
			config: { errorHandler },
		},
	})({ pinia, props });

async function mountModal(testCase: ModalCase) {
	await setupApp(testCase.user, testCase);
	const workflow: WorkflowFixture = WORKFLOWS[testCase.workflow];
	server.workflowScopes.set(workflow.id, SCOPES[testCase.scopes]);
	if (testCase.context === 'editor') await openInEditor(workflow.id);
	if (testCase.context === 'new') await openNewInEditor(workflow.id);
	if (testCase.context === 'list') await showInList(workflow.id);
	await testCase.prepare?.(workflow.id);
	takeLog();
	useUIStore().openModalWithData({ name: WORKFLOW_SHARE_MODAL_KEY, data: { id: workflow.id } });
	const rendered = renderModal({
		data: { id: workflow.id },
		isActive: true,
		modalName: WORKFLOW_SHARE_MODAL_KEY,
	});
	unmountLast = rendered.unmount;
	await settle();
	return { ...rendered, workflow };
}

function workflowState(id: string) {
	const document = useWorkflowDocumentStore(createWorkflowDocumentId(id));
	const listed = useWorkflowsListStore().workflowsById[id];
	return plain({
		modalOpen: useUIStore().modalsById[WORKFLOW_SHARE_MODAL_KEY]?.open ?? false,
		route: router.currentRoute.value.fullPath,
		document: {
			homeProject: document.homeProject,
			sharedWithProjects: document.sharedWithProjects,
		},
		list: { homeProject: listed?.homeProject, sharedWithProjects: listed?.sharedWithProjects },
	});
}

function checkpoint(container: Element, id: string) {
	return {
		dom: describeDom(container),
		modal: modalApi.props?.(),
		sharing: describeSharing(),
		state: workflowState(id),
		calls: takeLog(),
	};
}

function buttonByText(container: Element, text: string) {
	return [...container.querySelectorAll('button')].find(
		(button) => normalize(button.textContent) === text,
	);
}

async function click(element: Element | null | undefined) {
	if (!element) return false;
	await fireEvent.click(element);
	await settle();
	return true;
}

const saveButton = (container: Element) =>
	container.querySelector('[data-test-id="workflow-sharing-modal-save-button"]');

/** Whether a user can change the projects in the mounted `ProjectSharing`. */
function isEditable() {
	if (!sharingInstances.length) return false;
	const attrs = sharingAttrs();
	return !attrs.readonly && !attrs.static && !attrs.disabledTooltip;
}

/** A project that the user can pick: the select shows it, and it is not in the list yet. */
function pickableProject() {
	const attrs = sharingAttrs();
	const selected = (Array.isArray(attrs.modelValue) ? attrs.modelValue : []) as Array<{
		id: string;
	}>;
	const home = attrs.homeProject as { id?: string } | undefined;
	const filter = attrs.filterFn as ((project: unknown) => boolean) | undefined;
	const preferred = [
		PROJECTS.personalC,
		PROJECTS.personalB,
		PROJECTS.personalAdmin,
		PROJECTS.personalOwner,
		PROJECTS.team2,
		PROJECTS.team,
	];
	return preferred.find(
		(entry) =>
			entry.id !== home?.id &&
			!selected.some(({ id }) => id === entry.id) &&
			(!filter || filter(entry)),
	);
}

/** Add a project as `ProjectSharing` does when the user picks it. */
async function addProject(added = pickableProject()) {
	if (!added) return 'nothing to add';
	const attrs = sharingAttrs();
	const current = Array.isArray(attrs.modelValue) ? attrs.modelValue : [];
	call(attrs, 'onUpdate:modelValue', [...current, added]);
	call(attrs, 'onProjectAdded', added);
	await settle();
	return added.id;
}

/** Remove a project as `ProjectSharing` does after its own confirmation. */
async function removeProject(index = 0) {
	const attrs = sharingAttrs();
	const current = (Array.isArray(attrs.modelValue) ? attrs.modelValue : []) as Array<{
		id: string;
	}>;
	const removed = current[index];
	if (!removed) return 'nothing to remove';
	if (typeof attrs.confirmRemoval === 'function') {
		const texts = (attrs.confirmRemoval as (project: unknown) => Record<string, string>)(removed);
		const answer = confirmAnswers.shift() ?? 'confirm';
		log.push(['ProjectSharing confirm', plain({ texts, answer })]);
		if (answer !== 'confirm') return `${removed.id} kept`;
	}
	call(
		attrs,
		'onUpdate:modelValue',
		current.filter(({ id }) => id !== removed.id),
	);
	call(attrs, 'onProjectRemoved', removed);
	await settle();
	return removed.id;
}

async function runModalCase(testCase: ModalCase) {
	const result: Outcomes = {};

	if (testCase.changeWhileHeld) {
		for (const answer of ['confirm', 'cancel']) {
			const { container, workflow } = await mountModal(testCase);
			result[`opened ${answer}`] = checkpoint(container, workflow.id);
			result[`addedProject ${answer}`] = await addProject();
			confirmAnswers = [answer];
			// Do not wait for the close: it may wait for the held request.
			const closing = closeModal();
			await settle();
			result[`closed while waiting ${answer}`] = checkpoint(container, workflow.id);
			for (const release of releases) release();
			await closing;
			await settle();
			result[`released ${answer}`] = checkpoint(container, workflow.id);
		}
		{
			const { container, workflow } = await mountModal(testCase);
			await addProject();
			const button = saveButton(container);
			if (button) void fireEvent.click(button);
			await settle();
			result['saved while waiting'] = checkpoint(container, workflow.id);
			for (const release of releases) release();
			await settle();
			result['saved while waiting, released'] = checkpoint(container, workflow.id);
		}
		{
			const { container, workflow } = await mountModal(testCase);
			const closing = closeModal();
			await settle();
			result['closed without changes while waiting'] = checkpoint(container, workflow.id);
			for (const release of releases) release();
			await closing;
			await settle();
			result['closed without changes while waiting, released'] = checkpoint(container, workflow.id);
		}
		return result;
	}

	if (testCase.saveWhileHeld) {
		{
			const { container, workflow } = await mountModal(testCase);
			result.addedProject = await addProject();
			await click(saveButton(container));
			result['saved while waiting'] = checkpoint(container, workflow.id);
			await click(saveButton(container));
			result['saved again while waiting'] = checkpoint(container, workflow.id);
			for (const release of releases) release();
			await settle();
			result['saved while waiting, released'] = checkpoint(container, workflow.id);
		}
		{
			const { container, workflow } = await mountModal(testCase);
			await addProject();
			confirmAnswers = ['confirm'];
			const closing = closeModal();
			await settle();
			result['closed while waiting'] = checkpoint(container, workflow.id);
			for (const release of releases) release();
			await closing;
			await settle();
			result['closed while waiting, released'] = checkpoint(container, workflow.id);
		}
		return result;
	}

	if (testCase.onlyOpen) {
		const { container, workflow } = await mountModal(testCase);
		result.opened = checkpoint(container, workflow.id);
		for (const release of releases) release();
		await settle();
		result.released = checkpoint(container, workflow.id);
		return result;
	}

	{
		const { container, workflow } = await mountModal(testCase);
		result.opened = checkpoint(container, workflow.id);
		const search = sharingInstances.length ? sharingAttrs().searchFn : undefined;
		if (typeof search === 'function') {
			result.searchAll = plain(await search(''));
			result.searchBen = plain(await search('ben'));
			result.searchCalls = takeLog();
		}
	}

	/** Mount again for one interaction, when the user can change the projects. */
	const mountForChange = async () => {
		const mounted = await mountModal(testCase);
		return isEditable() ? mounted : undefined;
	};

	{
		const mounted = await mountForChange();
		if (mounted) {
			const { container, workflow } = mounted;
			await click(saveButton(container));
			result.savedWithoutChanges = checkpoint(container, workflow.id);
		}
	}
	{
		const mounted = await mountForChange();
		if (mounted) {
			const { container, workflow } = mounted;
			result.addedProject = await addProject();
			result.added = checkpoint(container, workflow.id);
			await click(saveButton(container));
			result.savedAfterAdd = checkpoint(container, workflow.id);
		}
	}
	{
		const mounted = await mountForChange();
		if (mounted) {
			const { container, workflow } = mounted;
			result.removedProject = await removeProject();
			result.removed = checkpoint(container, workflow.id);
			await click(saveButton(container));
			result.savedAfterRemove = checkpoint(container, workflow.id);
		}
	}
	{
		const mounted = await mountForChange();
		if (mounted) {
			const { container, workflow } = mounted;
			const attrs = sharingAttrs();
			const original = (
				Array.isArray(attrs.modelValue) ? attrs.modelValue : []
			) as ProjectSharingData[];
			if (original.length) {
				await removeProject();
				await addProject(original[0]);
				result.removedAndAddedBack = checkpoint(container, workflow.id);
			}
		}
	}
	{
		const mounted = await mountForChange();
		if (mounted) {
			const { container, workflow } = mounted;
			failures.set(`PUT /workflows/${workflow.id}/share`, { status: 403, message: 'Forbidden' });
			await addProject();
			await click(saveButton(container));
			result.saveFailed = checkpoint(container, workflow.id);
		}
	}
	{
		const { container, workflow } = await mountModal(testCase);
		await closeModal();
		await settle();
		result.closedWithoutChanges = checkpoint(container, workflow.id);
	}
	{
		const { container, workflow } = await mountModal(testCase);
		for (const text of ['Close', 'View plans']) {
			if (await click(buttonByText(container, text))) {
				result[`clicked ${text}`] = checkpoint(container, workflow.id);
			}
		}
	}
	for (const answer of ['confirm', 'cancel', 'close']) {
		const mounted = await mountForChange();
		if (mounted) {
			const { container, workflow } = mounted;
			await addProject();
			confirmAnswers = [answer];
			await closeModal();
			await settle();
			result[`closedWithChanges ${answer}`] = checkpoint(container, workflow.id);
		}
	}
	{
		const mounted = await mountForChange();
		if (mounted) {
			const { container, workflow } = mounted;
			failures.set(`PUT /workflows/${workflow.id}/share`, { status: 403, message: 'Forbidden' });
			await addProject();
			confirmAnswers = ['confirm'];
			await closeModal();
			await settle();
			result['closedWithChanges confirm, save fails'] = checkpoint(container, workflow.id);
		}
	}
	return result;
}

// #endregion

// #region Credential sharing tab

type CredentialCase = AppOptions & {
	user: UserKey;
	homeProject?: ProjectSharingData;
	sharedWithProjects: ProjectSharingData[];
	scopes: CredentialScopeKey;
	isGlobal?: boolean;
	isSharedGlobally?: boolean;
	isNew?: boolean;
	isManaged?: boolean;
	isResolvable?: boolean;
	usageScope?: 'project' | 'instance';
	ownedBy?: UserKey;
	type?: string;
	/** The credential's scopes without the global scopes of the user. */
	rawScopes?: Scope[];
	/** The projects in the form data, when they differ from the stored credential. */
	formSharedWithProjects?: ProjectSharingData[];
	/** The workflows that use the credential, else `DEFAULT_USAGE`. */
	usedIn?: Array<[string, string, string]>;
	inaccessibleUsage?: number;
	usageRequest?: 'fails' | 'waits';
	/** The id of the credential, else `cred-1`. */
	id?: string;
	/** The `credentialId` prop, when it differs from the id of the credential. */
	credentialIdProp?: string;
	/** Change the stores or the server after the setup, before the tab opens. */
	prepare?: () => void;
};

/** The credential is used in a shared project, a team project and twice in another one. */
const DEFAULT_USAGE: Array<[string, string, string]> = [
	['wf-u1', 'Team flow', 'p-team'],
	['wf-u2', 'Beta flow one', 'p-team2'],
	['wf-u3', 'Beta flow two', 'p-team2'],
	['wf-u4', 'Ben flow', 'p-b'],
	['wf-u5', 'Ann flow', 'p-a'],
];

const BASE_CREDENTIAL_CASES: Record<string, CredentialCase> = {
	'memberA own personal credential with share': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [PROJECTS.personalB],
		scopes: 'all',
		ownedBy: 'memberA',
	},
	'memberA own personal credential without share': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [PROJECTS.personalB],
		scopes: 'noShare',
		ownedBy: 'memberA',
	},
	'memberA own unshared credential': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
	},
	'memberA credential shared by the owner': {
		user: 'memberA',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [PROJECTS.personalA, PROJECTS.team],
		scopes: 'user',
		ownedBy: 'owner',
	},
	'memberA team credential as project admin': {
		user: 'memberA',
		homeProject: PROJECTS.team,
		sharedWithProjects: [PROJECTS.personalB, PROJECTS.team2],
		scopes: 'all',
	},
	'memberC team credential as viewer': {
		user: 'memberC',
		homeProject: PROJECTS.team,
		sharedWithProjects: [],
		scopes: 'read',
	},
	'owner credential of memberA': {
		user: 'owner',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [PROJECTS.personalB],
		scopes: 'read',
		ownedBy: 'memberA',
	},
	'owner global credential': {
		user: 'owner',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [PROJECTS.personalA],
		scopes: 'all',
		isGlobal: true,
		isSharedGlobally: true,
		ownedBy: 'owner',
	},
	'owner credential, shared globally in the form only': {
		user: 'owner',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [],
		scopes: 'all',
		isSharedGlobally: true,
		ownedBy: 'owner',
	},
	'admin credential of memberA': {
		user: 'admin',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'read',
		ownedBy: 'memberA',
	},
	'memberA global credential of the owner': {
		user: 'memberA',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [],
		scopes: 'read',
		isGlobal: true,
		isSharedGlobally: true,
		ownedBy: 'owner',
	},
	'memberA new credential': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		isNew: true,
	},
	'memberA credential without the sharing licence': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [PROJECTS.personalB],
		scopes: 'all',
		sharing: false,
		ownedBy: 'memberA',
	},
	'memberA managed credential': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		isManaged: true,
		ownedBy: 'memberA',
	},
	'memberA end-user credential': {
		user: 'memberA',
		homeProject: PROJECTS.team,
		sharedWithProjects: [],
		scopes: 'all',
		isResolvable: true,
	},
	'owner instance credential': {
		user: 'owner',
		sharedWithProjects: [],
		scopes: 'all',
		usageScope: 'instance',
	},
	'owner global credential, all licence features': {
		user: 'owner',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [PROJECTS.personalA],
		scopes: 'all',
		isGlobal: true,
		isSharedGlobally: true,
		ownedBy: 'owner',
		allFeatures: true,
	},
	'owner OpenAI credential': {
		user: 'owner',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'owner',
		type: 'openAiApi',
	},
	'owner OpenAI credential, all licence features': {
		user: 'owner',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'owner',
		type: 'openAiApi',
		allFeatures: true,
	},
	'memberA credential without the sharing licence on cloud': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [PROJECTS.personalB],
		scopes: 'all',
		sharing: false,
		cloud: true,
		ownedBy: 'memberA',
	},
	'memberA credential of the owner, no owner data': {
		user: 'memberA',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [PROJECTS.personalA],
		scopes: 'user',
	},
	'memberA credential of the owner, another owner name': {
		user: 'memberA',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [PROJECTS.personalA],
		scopes: 'user',
		ownedBy: 'memberC',
	},
	'memberA own credential without share, no owner data': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'noShare',
	},
	'memberB credential of memberA without share': {
		user: 'memberB',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [PROJECTS.personalB],
		scopes: 'noShare',
		ownedBy: 'memberA',
	},
	'memberA credential whose form has other projects': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [PROJECTS.personalB],
		formSharedWithProjects: [PROJECTS.personalC, PROJECTS.team],
		scopes: 'all',
		ownedBy: 'memberA',
	},
	'memberA own credential without share, personal project of memberB in the store': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'noShare',
		ownedBy: 'memberA',
		personalProjectOf: 'memberB',
	},
	'memberA credential of memberB without share, personal project of memberB in the store': {
		user: 'memberA',
		homeProject: PROJECTS.personalB,
		sharedWithProjects: [PROJECTS.personalA],
		scopes: 'noShare',
		ownedBy: 'memberB',
		personalProjectOf: 'memberB',
	},
	'memberA own credential, custom roles': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [PROJECTS.personalB],
		scopes: 'all',
		ownedBy: 'memberA',
		customRoles: true,
	},
	'owner credential, no RBAC scopes': {
		user: 'owner',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'owner',
		noRbacScopes: true,
	},
	'memberA own credential, used twice in a team project': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		usedIn: [
			['wf-u1', 'Team flow one', 'p-team'],
			['wf-u2', 'Team flow two', 'p-team'],
		],
	},
	'admin credential of memberA, used in the projects of the admin': {
		user: 'admin',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'read',
		ownedBy: 'memberA',
		usedIn: [
			['wf-u1', 'Admin flow', 'p-admin'],
			['wf-u2', 'Beta flow', 'p-team2'],
		],
	},
	'admin credential of memberA owned by another name, used in the projects of the admin': {
		user: 'admin',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'read',
		ownedBy: 'memberC',
		usedIn: [['wf-u1', 'Admin flow', 'p-admin']],
	},
	'admin credential of memberA without owner data, used in the projects of the admin': {
		user: 'admin',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'read',
		usedIn: [['wf-u1', 'Admin flow', 'p-admin']],
	},
	'admin team credential, used in the projects of the admin': {
		user: 'admin',
		homeProject: PROJECTS.team,
		sharedWithProjects: [],
		scopes: 'read',
		usedIn: [['wf-u1', 'Admin flow', 'p-admin']],
	},
	'memberA credential of a one-word team, used in a team project': {
		user: 'memberA',
		homeProject: project('p-solo', 'Solo', 'team'),
		sharedWithProjects: [],
		scopes: 'all',
		usedIn: [['wf-u1', 'Team flow', 'p-team']],
	},
	'memberA credential of an email-only personal project, used in a team project': {
		user: 'memberA',
		homeProject: project('p-mail', '<mail@n8n.test>', 'personal'),
		sharedWithProjects: [],
		scopes: 'all',
		usedIn: [['wf-u1', 'Team flow', 'p-team']],
	},
	'memberA own credential, not used': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [PROJECTS.personalB],
		scopes: 'all',
		ownedBy: 'memberA',
		usedIn: [],
	},
	'memberA own credential, used where it is shared, and hidden workflows': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [PROJECTS.team],
		scopes: 'all',
		ownedBy: 'memberA',
		usedIn: [['wf-u1', 'Team flow', 'p-team']],
		inaccessibleUsage: 2,
	},
	'owner credential, used in a workflow without a project': {
		user: 'owner',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'owner',
		usedIn: [['wf-u9', 'Lost flow', '']],
	},
	'owner credential whose scopes lack shareGlobally': {
		user: 'owner',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'owner',
		rawScopes: CREDENTIAL_SCOPES.all,
	},
	'memberA credential whose scopes have shareGlobally': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		rawScopes: [...CREDENTIAL_SCOPES.all, 'credential:shareGlobally'],
	},
	'memberA own credential, the usage request fails': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		usageRequest: 'fails',
	},
	'memberA own credential, shared while the usage request waits': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		usageRequest: 'waits',
	},
	'memberA own credential cred-2, used in another workflow': {
		user: 'memberA',
		id: 'cred-2',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		usedIn: [['wf-u7', 'Second flow', 'p-team']],
	},
	'memberA own credential, the usage request fails after cred-2 loaded': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		usageRequest: 'fails',
	},
	'memberA own credential cred-2, the usage request fails': {
		user: 'memberA',
		id: 'cred-2',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		usageRequest: 'fails',
	},
	'memberA new credential, the usage request fails': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		isNew: true,
		usageRequest: 'fails',
	},
	'memberA own credential, another credential id in the props': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		credentialIdProp: 'cred-3',
		prepare: () => server.credentialUsage.set('cred-3', [['wf-u8', 'Third flow', 'p-team']]),
	},
	'memberA own credential, no credential id in the props': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		credentialIdProp: '',
		prepare: () => server.credentialUsage.set('', [['wf-u8', 'Third flow', 'p-team']]),
	},
	'memberA own credential, the team project only in the list of all projects': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		prepare: () => {
			const projectsStore = useProjectsStore();
			projectsStore.myProjects = projectsStore.myProjects.filter(({ id }) => id !== 'p-team');
			projectsStore.projects = allProjectItems();
		},
	},
	'owner own credential, the team projects only in the list of all projects': {
		user: 'owner',
		homeProject: PROJECTS.personalOwner,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'owner',
		prepare: () => {
			const projectsStore = useProjectsStore();
			projectsStore.myProjects = projectsStore.myProjects.filter(({ type }) => type !== 'team');
			projectsStore.projects = allProjectItems();
		},
	},
	'memberA own credential, only personal projects in the list of all projects': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		prepare: () => {
			useProjectsStore().projects = allProjectItems().filter(({ type }) => type === 'personal');
		},
	},
	'memberA own credential, team projects in the list of all projects, no team projects': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		teamProjectLimit: 0,
		prepare: () => {
			useProjectsStore().projects = allProjectItems();
		},
	},
	'memberA own credential, no roles in the store': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		prepare: clearRoles,
	},
	'memberA own credential, no projects of the user in the store': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		prepare: clearMyProjects,
	},
	'memberA own credential, no personal project in the store': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [],
		scopes: 'all',
		ownedBy: 'memberA',
		prepare: () => {
			useProjectsStore().personalProject = null;
		},
	},
	'memberA own personal credential, all licence features': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [PROJECTS.personalB],
		scopes: 'all',
		ownedBy: 'memberA',
		allFeatures: true,
	},
};

/** Each case, and each case again with the credential sharing flag. */
const CREDENTIAL_CASES: Record<string, CredentialCase> = Object.fromEntries(
	Object.entries(BASE_CREDENTIAL_CASES).flatMap(([name, testCase]) => [
		[name, testCase],
		[`${name}, credential sharing flag`, { ...testCase, credSharingFlag: true }],
	]),
);

function credentialProps(testCase: CredentialCase) {
	const scopes =
		testCase.rawScopes ?? resourceScopes('credential', CREDENTIAL_SCOPES[testCase.scopes]);
	const owner = testCase.ownedBy ? USERS[testCase.ownedBy] : undefined;
	const credential = testCase.isNew
		? null
		: {
				id: testCase.id ?? 'cred-1',
				name: 'Shared API key',
				type: testCase.type ?? 'httpHeaderAuth',
				createdAt: now,
				updatedAt: now,
				isManaged: testCase.isManaged ?? false,
				isGlobal: testCase.isGlobal ?? false,
				isResolvable: testCase.isResolvable ?? false,
				usageScope: testCase.usageScope ?? 'project',
				homeProject: testCase.homeProject,
				sharedWithProjects: testCase.sharedWithProjects,
				scopes,
				...(owner
					? {
							ownedBy: {
								id: owner.id,
								firstName: owner.firstName,
								lastName: owner.lastName,
								email: owner.email,
							},
						}
					: {}),
			};
	return {
		credential,
		credentialData: {
			name: 'Shared API key',
			value: 'secret',
			sharedWithProjects: testCase.formSharedWithProjects ?? testCase.sharedWithProjects,
		},
		credentialId: testCase.credentialIdProp ?? (testCase.isNew ? '' : (testCase.id ?? 'cred-1')),
		credentialPermissions: getResourcePermissions(scopes).credential,
		isSharedGlobally: testCase.isSharedGlobally ?? false,
		modalBus: createEventBus(),
	};
}

async function mountCredentialSharing(testCase: CredentialCase) {
	await setupApp(testCase.user, testCase);
	server.credentialUsage.set(testCase.id ?? 'cred-1', testCase.usedIn ?? DEFAULT_USAGE);
	server.inaccessibleUsage = testCase.inaccessibleUsage ?? 0;
	if (testCase.usageRequest === 'fails') {
		failures.set('POST /workflow-dependencies/details', { status: 500, message: 'Usage failed' });
	}
	if (testCase.usageRequest === 'waits') holdRequest('POST /workflow-dependencies/details');
	testCase.prepare?.();
	const props = credentialProps(testCase);
	const rendered = createComponentRenderer(CredentialSharing, {
		global: { plugins: [router], provide: appProvides(), config: { errorHandler } },
	})({ pinia, props });
	unmountLast = rendered.unmount;
	await settle();
	return { ...rendered, props };
}

function credentialCheckpoint(container: Element, emitted: () => Record<string, unknown[]>) {
	return {
		dom: describeDom(container),
		sharing: describeSharing(),
		emitted: plain(
			Object.fromEntries(
				Object.entries(emitted()).filter(
					([name]) => !['click', 'focus', 'blur', 'input', 'change'].includes(name),
				),
			),
		),
		route: router.currentRoute.value.fullPath,
		calls: takeLog(),
	};
}

async function runCredentialCase(testCase: CredentialCase) {
	const result: Outcomes = {};
	if (testCase.usageRequest === 'waits') {
		const { container, emitted } = await mountCredentialSharing(testCase);
		result.opened = credentialCheckpoint(container, emitted);
		if (isEditable()) {
			result.addedProject = await addProject(PROJECTS.team);
			result['added while waiting'] = credentialCheckpoint(container, emitted);
		}
		for (const release of releases) release();
		await settle();
		result.released = credentialCheckpoint(container, emitted);
		return result;
	}
	{
		const { container, emitted } = await mountCredentialSharing(testCase);
		result.opened = credentialCheckpoint(container, emitted);
		const search = sharingInstances.length ? sharingAttrs().searchFn : undefined;
		if (typeof search === 'function') {
			result.searchAll = plain(await search(''));
			result.searchBen = plain(await search('ben'));
			result.searchCalls = takeLog();
		}
	}
	const mountForChange = async () => {
		const mounted = await mountCredentialSharing(testCase);
		return isEditable() ? mounted : undefined;
	};
	{
		const mounted = await mountForChange();
		if (mounted) {
			result.addedProject = await addProject();
			result.added = credentialCheckpoint(mounted.container, mounted.emitted);
		}
	}
	for (const answer of ['confirm', 'cancel']) {
		const mounted = await mountForChange();
		if (mounted) {
			confirmAnswers = [answer];
			result[`removedProject ${answer}`] = await removeProject();
			result[`removed ${answer}`] = credentialCheckpoint(mounted.container, mounted.emitted);
		}
	}
	for (const value of [true, false]) {
		const mounted = await mountForChange();
		if (mounted && sharingAttrs().canShareGlobally) {
			call(sharingAttrs(), 'onUpdate:shareWithAllUsers', value);
			await settle();
			result[`shareWithAllUsers ${value}`] = credentialCheckpoint(
				mounted.container,
				mounted.emitted,
			);
		}
	}
	{
		const { container, emitted } = await mountCredentialSharing(testCase);
		const shareButtons = [...container.querySelectorAll('button')].filter(
			(button) => normalize(button.textContent) === 'Share',
		);
		for (const [index, button] of shareButtons.entries()) {
			if (index > 1) break;
			await click(button);
			result[`clicked Share ${index}`] = credentialCheckpoint(container, emitted);
		}
	}
	for (const event of ['opened', 'closed']) {
		const { container, emitted, props } = await mountCredentialSharing(testCase);
		props.modalBus.emit(event);
		await settle();
		result[`modalBus ${event}`] = credentialCheckpoint(container, emitted);
	}
	{
		const { container, emitted } = await mountCredentialSharing(testCase);
		if (await click(buttonByText(container, 'View plans'))) {
			result['clicked View plans'] = credentialCheckpoint(container, emitted);
		}
	}
	return result;
}

// #endregion

describe('sharing UI', () => {
	test('API helpers', async () => {
		await setupApp('memberA');
		server.resultMarker = true;
		const context = { baseUrl: '/rest', pushRef: 'push-ref' };
		const outcomes: Outcomes = {};
		const probe = async (name: string, run: () => Promise<unknown>) => {
			try {
				outcomes[name] = { result: plain(await run()), calls: takeLog() };
			} catch (error) {
				outcomes[name] = { error: plain(error), calls: takeLog() };
			}
		};
		await probe(
			'setWorkflowSharedWith',
			async () =>
				await workflowSharingApi.setWorkflowSharedWith(context, 'wf-a', {
					shareWithIds: ['p-b', 'p-c'],
				}),
		);
		await probe(
			'setWorkflowSharedWith with no projects',
			async () =>
				await workflowSharingApi.setWorkflowSharedWith(context, 'wf-a', { shareWithIds: [] }),
		);
		await probe(
			'moveWorkflowToProject',
			async () =>
				await workflowSharingApi.moveWorkflowToProject(context, 'wf-a', {
					destinationProjectId: 'p-team',
					destinationParentFolderId: 'folder-1',
					shareCredentials: ['cred-1'],
				}),
		);
		await probe(
			'moveWorkflowToProject with the project only',
			async () =>
				await workflowSharingApi.moveWorkflowToProject(context, 'wf-a', {
					destinationProjectId: 'p-team',
				}),
		);
		await probe(
			'moveWorkflowToProject with an activation error',
			async () =>
				await workflowSharingApi.moveWorkflowToProject(context, 'wf-a', {
					destinationProjectId: 'p-activation-error',
				}),
		);
		failures.set('PUT /workflows/wf-a/transfer', { status: 400, message: 'Transfer failed' });
		await probe(
			'moveWorkflowToProject that fails',
			async () =>
				await workflowSharingApi.moveWorkflowToProject(context, 'wf-a', {
					destinationProjectId: 'p-team',
				}),
		);
		failures.clear();
		await probe(
			'moveFolderToProject',
			async () =>
				await workflowSharingApi.moveFolderToProject(
					context,
					'p-a',
					'folder-1',
					'p-team',
					'folder-2',
					['cred-1', 'cred-2'],
				),
		);
		await probe(
			'moveFolderToProject to the root',
			async () =>
				await workflowSharingApi.moveFolderToProject(context, 'p-a', 'folder-1', 'p-team'),
		);
		await probe(
			'setCredentialSharedWith',
			async () =>
				await credentialSharingApi.setCredentialSharedWith(context, 'cred-1', {
					shareWithIds: ['p-b'],
				}),
		);
		await probe(
			'moveCredentialToProject',
			async () => await credentialSharingApi.moveCredentialToProject(context, 'cred-1', 'p-team'),
		);
		failures.set('PUT /credentials/cred-1/transfer', { status: 404, message: 'Not found' });
		await probe(
			'moveCredentialToProject that fails',
			async () => await credentialSharingApi.moveCredentialToProject(context, 'cred-1', 'p-team'),
		);
		outcomes.exports = {
			workflows: Object.keys(workflowSharingApi).sort(),
			credentials: Object.keys(credentialSharingApi).sort(),
		};
		expect(outcomes).toMatchSnapshot();
	});

	test('workflowsEE store', async () => {
		const outcomes: Outcomes = {};
		for (const user of ['memberA', 'owner'] as const) {
			for (const context of ['none', 'list', 'editor', 'new'] as const) {
				for (const workflow of Object.values(WORKFLOWS)) {
					await setupApp(user);
					server.workflowScopes.set(workflow.id, SCOPES.all);
					if (context === 'list') await showInList(workflow.id);
					if (context === 'editor') await openInEditor(workflow.id);
					if (context === 'new') await openNewInEditor(workflow.id);
					takeLog();
					const store = useWorkflowsEEStore();
					outcomes[`${user} ${context} ${workflow.id}`] = plain({
						storeId: store.$id,
						ownerName: store.getWorkflowOwnerName(workflow.id),
						ownerNameWithFallback: store.getWorkflowOwnerName(workflow.id, 'fallback'),
						calls: takeLog(),
					});
				}
			}
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('workflow share modal', async () => {
		const outcomes: Outcomes = {};
		for (const [name, testCase] of Object.entries(MODAL_CASES)) {
			outcomes[name] = onlyChanges(await runModalCase(testCase));
		}
		expect(outcomes).toMatchSnapshot();
	}, 600_000);

	test('credential sharing tab', async () => {
		const outcomes: Outcomes = {};
		for (const [name, testCase] of Object.entries(CREDENTIAL_CASES)) {
			outcomes[name] = onlyChanges(await runCredentialCase(testCase));
		}
		expect(outcomes).toMatchSnapshot();
	}, 600_000);
});
