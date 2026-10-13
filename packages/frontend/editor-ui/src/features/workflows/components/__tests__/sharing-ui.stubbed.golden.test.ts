// The editor sharing UI as component tests run it: `createTestingPinia` stubs each store action,
// the tests set the store state and the getters directly, and `useWorkflowSaving` and
// `useDependencies` are mocks. For each case, the test records what a user sees, and each call to
// a stubbed store action or to a mocked composable. It complements `sharing-ui.golden.test.ts`,
// which runs the UI with real stores. packages/frontend/editor-ui/FORK.md tells how the fork made
// the snapshot.
import { setNotify } from '@n8n/composables/useToast';
import { defaultSettings, mockedStore } from '@n8n/frontend-test-utils';
import {
	ALL_ROLES,
	CREDENTIALS_SHARING_SCOPE_MAP,
	GLOBAL_SCOPE_MAP,
	getResourcePermissions,
	WORKFLOW_SHARING_SCOPE_MAP,
	type Scope,
} from '@n8n/permissions';
import { STORES } from '@n8n/stores';
import { useRolesStore } from '@n8n/stores/roles.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';
import { createEventBus } from '@n8n/utils/event-bus';
import { createTestingPinia } from '@pinia/testing';
import { fireEvent } from '@testing-library/vue';
import { ElMessageBox } from 'element-plus';
import { setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { camelize, defineComponent, h, onMounted, onUnmounted, toRaw, type PropType } from 'vue';

import { createComponentRenderer } from '@/__tests__/render';
import { APP_MODALS_ELEMENT_ID, VIEWS, WORKFLOW_SHARE_MODAL_KEY } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { useWorkflowsListStore } from '@/app/stores/workflowsList.store';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import type {
	ProjectListItem,
	ProjectSharingData,
} from '@/features/collaboration/projects/projects.types';

// The modules under test. To record the snapshot against the original files in a checkout of
// upstream n8n, point these imports at `WorkflowShareModal.ee.vue` and `CredentialSharing.ee.vue`.
import WorkflowShareModal from '@/features/workflows/components/WorkflowShareModal.vue';
import CredentialSharing from '@/features/credentials/components/CredentialEdit/CredentialSharing.vue';

// #region Mocked composables

const mocks = vi.hoisted(() => {
	const calls: Array<[string, unknown]> = [];
	const results: Record<string, (...args: unknown[]) => unknown> = {};
	const copy = (value: unknown): unknown => {
		try {
			return JSON.parse(
				JSON.stringify(value ?? null, (_key, entry: unknown) =>
					typeof entry === 'function' ? '<function>' : entry === undefined ? '<undefined>' : entry,
				),
			) as unknown;
		} catch {
			return '<unprintable>';
		}
	};
	/** A composable whose functions record their calls and give the scripted results. */
	const recorder = (owner: string) =>
		new Proxy({} as Record<string, unknown>, {
			get: (_target, prop) => {
				if (typeof prop !== 'string' || prop.startsWith('__') || prop === 'then') return undefined;
				return (...args: unknown[]) => {
					calls.push([`${owner}.${prop}`, copy(args)]);
					return results[`${owner}.${prop}`]?.(...args);
				};
			},
		});
	return { calls, results, recorder };
});

vi.mock('@/app/composables/useWorkflowSaving', () => ({
	useWorkflowSaving: () => mocks.recorder('useWorkflowSaving'),
}));

vi.mock('@/app/composables/useDependencies', () => ({
	useDependencies: () => mocks.recorder('useDependencies'),
}));

// The editor's import path of `useMessage`. Component tests mock it to answer the dialogs.
vi.mock('@/app/composables/useMessage', () => ({
	useMessage: () => mocks.recorder('useMessage'),
}));

// #endregion

// #region Recording

type Outcomes = Record<string, unknown>;
let log: unknown[] = [];
let pinia: Pinia;
let router: Router;

const normalize = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** A value as one line of JSON, with single quotes, so that the snapshot stays readable. */
const oneLine = (value: unknown) => JSON.stringify(value).replaceAll('"', "'");

/** A project as one line: its id, type and name. */
function plain(value: unknown): unknown {
	if (typeof value === 'function') return '<function>';
	if (value === undefined) return '<undefined>';
	if (value === null || typeof value !== 'object') return value;
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (Array.isArray(value)) return value.map(plain);
	if ('on' in value && 'emit' in value && 'off' in value) return '<eventBus>';
	const record = value as Record<string, unknown>;
	if ('id' in record && 'type' in record && 'name' in record && 'createdAt' in record) {
		return `project ${String(record.id)} ${String(record.type)} ${String(record.name)}`;
	}
	if ('slug' in record && 'roleType' in record) {
		return `role ${String(record.slug)} ${String(record.displayName)}`;
	}
	return Object.fromEntries(
		Object.entries(record)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => [key, plain(entry)]),
	);
}

/** The stores that the pinia of the case has, by id. */
const piniaStores = () => (pinia as unknown as { _s: Map<string, Record<string, unknown>> })._s;

/** The calls to the stubbed store actions since the last checkpoint, then clear them. */
function storeCalls() {
	const calls: string[] = [];
	for (const [id, store] of piniaStores()) {
		// The raw store: its getters stay refs, so that reading them here runs no getter.
		for (const [key, value] of Object.entries(toRaw(store))) {
			if (!vi.isMockFunction(value)) continue;
			for (const args of value.mock.calls)
				calls.push(`${id}.${key}(${oneLine(plain(args)).slice(1, -1)})`);
			value.mockClear();
		}
	}
	return calls;
}

/** Take the log of the calls since the last checkpoint. */
function takeLog() {
	const taken = [
		...log,
		...mocks.calls.map(([name, args]) => `${name}(${oneLine(plain(args)).slice(1, -1)})`),
		...storeCalls(),
	];
	log = [];
	mocks.calls.length = 0;
	return taken;
}

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

/** What a user sees: the text, the hidden text, the elements with a test id, and the controls. */
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
			(element) => `${element.getAttribute('data-test-id')}: ${normalize(element.textContent)}`,
		),
		controls: [...root.querySelectorAll('button, input, textarea, a[href]')].map(describeElement),
	};
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

function sharingAttrs(): Record<string, unknown> | undefined {
	const attrs = sharingInstances[0];
	if (!attrs) return undefined;
	return Object.fromEntries(Object.entries(attrs).map(([key, value]) => [camelize(key), value]));
}

function describeSharing() {
	const attrs = sharingAttrs();
	if (!attrs) return null;
	return plain(
		Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== undefined)),
	);
}

function call(attrs: Record<string, unknown>, name: string, ...args: unknown[]) {
	const handler = attrs[name];
	if (typeof handler === 'function') return handler(...args);
	if (Array.isArray(handler)) {
		for (const entry of handler) if (typeof entry === 'function') entry(...args);
	}
	return undefined;
}

/** Add a project as `ProjectSharing` does when the user picks it. */
async function addProject(added: ProjectSharingData) {
	const attrs = sharingAttrs();
	if (!attrs) return 'no select';
	const current = Array.isArray(attrs.modelValue) ? attrs.modelValue : [];
	call(attrs, 'onUpdate:modelValue', [...current, added]);
	call(attrs, 'onProjectAdded', added);
	await settle();
	return added.id;
}

async function settle() {
	for (let index = 0; index < 8; index++) await new Promise((resolve) => setTimeout(resolve, 5));
}

const modalApi: {
	close?: () => Promise<void>;
	beforeClose?: () => unknown;
	props?: () => unknown;
} = {};

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
		eventBus: Object,
		loading: Boolean,
		beforeClose: Function as PropType<() => unknown>,
		width: String,
		maxHeight: String,
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
			modalApi.beforeClose = () => props.beforeClose?.();
			modalApi.props = () => plain({ ...props });
		});
		return () =>
			h('div', { role: 'dialog', 'data-test-id': `${props.name}-modal` }, [
				props.title ? h('h1', props.title) : null,
				props.loading ? h('div', 'loading') : slots.content?.(),
				!props.loading && slots.footer ? slots.footer({ close: closeDialog }) : null,
			]);
	},
});

let confirmAnswers: string[] = [];
let unmountLast: (() => void) | undefined;

beforeEach(() => {
	setNotify((options) => {
		log.push(['toast', plain(options)]);
		return { close() {} };
	});
	mocks.results['useMessage.confirm'] = async () => confirmAnswers.shift() ?? 'confirm';
	vi.spyOn(ElMessageBox, 'confirm').mockImplementation(async (message: unknown) => {
		const answer = confirmAnswers.shift() ?? 'confirm';
		log.push(['confirm', plain({ message, answer })]);
		if (answer === 'confirm') return 'confirm' as never;
		throw answer;
	});
});

afterEach(() => {
	unmountLast?.();
	unmountLast = undefined;
	for (const key of Object.keys(mocks.results)) delete mocks.results[key];
	mocks.calls.length = 0;
	log = [];
});

// #endregion

// #region Fixture

const now = '2026-01-01T00:00:00.000Z';
const project = (id: string, name: string, type: 'personal' | 'team'): ProjectSharingData => ({
	id,
	name,
	type,
	icon: null,
	createdAt: now,
	updatedAt: now,
});
const PROJECTS = {
	personalA: project('p-a', 'Ann Alpha <a@n8n.test>', 'personal'),
	personalB: project('p-b', 'Ben Beta <b@n8n.test>', 'personal'),
	personalC: project('p-c', 'Cleo Gamma <c@n8n.test>', 'personal'),
	personalAdmin: project('p-admin', 'Ada Admin <admin@n8n.test>', 'personal'),
	team: project('p-team', 'Team Alpha', 'team'),
};
const listItem = (entry: ProjectSharingData, role: string) =>
	({ ...entry, role, scopes: [] }) as unknown as ProjectListItem;

const USERS = {
	memberA: {
		id: 'u-a',
		email: 'a@n8n.test',
		firstName: 'Ann',
		lastName: 'Alpha',
		role: 'global:member' as const,
		personal: PROJECTS.personalA,
	},
	admin: {
		id: 'u-admin',
		email: 'admin@n8n.test',
		firstName: 'Ada',
		lastName: 'Admin',
		role: 'global:admin' as const,
		personal: PROJECTS.personalAdmin,
	},
};
type UserKey = keyof typeof USERS;

const WORKFLOW_SCOPES = [...WORKFLOW_SHARING_SCOPE_MAP['workflow:owner']].sort();
const CREDENTIAL_SCOPES = [...CREDENTIALS_SHARING_SCOPE_MAP['credential:owner']].sort();

function workflow(id: string, homeProject: ProjectSharingData, scopes: Scope[] = WORKFLOW_SCOPES) {
	return {
		id,
		name: `Workflow ${id}`,
		active: false,
		isArchived: false,
		createdAt: now,
		updatedAt: now,
		nodes: [],
		connections: {},
		versionId: `${id}-v1`,
		homeProject,
		sharedWithProjects: [PROJECTS.personalB],
		scopes,
	};
}

/** Set up the stores as a component test does, with each action stubbed. */
function setupStores(
	user: UserKey,
	options: { sharing?: boolean; credSharingFlag?: boolean } = {},
) {
	unmountLast?.();
	unmountLast = undefined;
	for (const key of Object.keys(mocks.results)) delete mocks.results[key];
	mocks.results['useMessage.confirm'] = async () => confirmAnswers.shift() ?? 'confirm';
	pinia = createTestingPinia({ createSpy: vi.fn, stubActions: true });
	setActivePinia(pinia);
	const Empty = defineComponent({ render: () => null });
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/', name: VIEWS.HOMEPAGE, component: Empty },
			{ path: '/home/workflows', name: VIEWS.WORKFLOWS, component: Empty },
			{ path: '/workflow/:workflowId/:nodeId?', name: VIEWS.WORKFLOW, component: Empty },
		],
	});

	const settingsStore = mockedStore(useSettingsStore);
	settingsStore.settings = {
		...defaultSettings,
		enterprise: { ...defaultSettings.enterprise, sharing: options.sharing ?? true },
		envFeatureFlags: options.credSharingFlag ? { N8N_ENV_FEAT_CRED_SHARING: 'true' } : {},
	};

	const entry = USERS[user];
	const usersStore = mockedStore(useUsersStore);
	usersStore.currentUser = {
		id: entry.id,
		email: entry.email,
		firstName: entry.firstName,
		lastName: entry.lastName,
		role: entry.role,
		isPending: false,
		isDefaultUser: false,
		isPendingUser: false,
		mfaEnabled: false,
		globalScopes: GLOBAL_SCOPE_MAP[entry.role],
	} as unknown as typeof usersStore.currentUser;

	const projectsStore = mockedStore(useProjectsStore);
	projectsStore.personalProject = {
		...entry.personal,
		relations: [],
	} as unknown as typeof projectsStore.personalProject;
	projectsStore.myProjects = [
		listItem(entry.personal, 'project:personalOwner'),
		listItem(PROJECTS.team, 'project:admin'),
	];
	projectsStore.searchShareableProjects.mockResolvedValue({
		count: 2,
		data: [
			listItem(PROJECTS.personalB, 'project:personalOwner'),
			listItem(PROJECTS.personalC, 'project:personalOwner'),
		],
	} as never);

	const rolesStore = mockedStore(useRolesStore);
	rolesStore.roles = { ...ALL_ROLES } as typeof rolesStore.roles;
	return { settingsStore, projectsStore };
}

// #endregion

// #region Workflow share modal

type ModalCase = {
	user: UserKey;
	sharing?: boolean;
	/** Set the stores for the case. */
	prepare: () => void;
	/** Release the first load later: add a project, close and save while it waits. */
	loadWaits?: boolean;
	/** The request of the first load that waits, else the workflow. */
	waitsFor?: 'workflow' | 'project';
	/** The route of the editor, else `/workflow/<id>`. */
	route?: string;
	/** What `workflowsListStore.fetchWorkflow` gives, else nothing. */
	loadGives?: () => unknown;
};

const renderModal = createComponentRenderer(WorkflowShareModal, {
	global: { stubs: { Modal: ModalStub } },
});

async function mountModal(testCase: ModalCase, id: string, modalName = WORKFLOW_SHARE_MODAL_KEY) {
	setupStores(testCase.user, { sharing: testCase.sharing });
	await router.push(testCase.route ?? `/workflow/${id}`);
	testCase.prepare();
	if (testCase.loadGives) {
		mockedStore(useWorkflowsListStore).fetchWorkflow.mockResolvedValue(
			testCase.loadGives() as never,
		);
	}
	takeLog();
	const rendered = renderModal({
		pinia,
		props: { modalName, isActive: true, data: { id } },
		global: { plugins: [router] },
	});
	unmountLast = rendered.unmount;
	return rendered;
}

function modalCheckpoint(container: Element) {
	return {
		route: router.currentRoute.value.fullPath,
		dom: describeDom(container),
		modal: modalApi.props?.(),
		sharing: describeSharing(),
		calls: takeLog(),
	};
}

/** Call `beforeClose` of the modal as `Modal` does. The result tells how its promise ended. */
function startBeforeClose() {
	let state = 'pending';
	void Promise.resolve(modalApi.beforeClose?.()).then(
		(value) => (state = `resolved ${String(value)}`),
		(error: unknown) => (state = `rejected ${String(plain(error))}`),
	);
	return () => state;
}

const saveButton = (container: Element) =>
	container.querySelector('[data-test-id="workflow-sharing-modal-save-button"]');

/** A workflow that the workflow list has. */
function listWorkflow(id: string, data = workflow(id, PROJECTS.personalA)) {
	mockedStore(useWorkflowsListStore).workflowsById = { [id]: data } as never;
}

const MODAL_CASES: Record<string, ModalCase> = {
	'listed workflow': {
		user: 'memberA',
		prepare: () => listWorkflow('wf-a'),
	},
	'listed workflow, the workflows store has its id': {
		user: 'memberA',
		prepare: () => {
			listWorkflow('wf-a');
			mockedStore(useWorkflowsStore).workflowId = 'wf-a';
		},
	},
	'listed workflow that the workflows store does not count as saved': {
		user: 'memberA',
		route:
			'/workflow/wf-a?new=true&parentFolderId=folder-1&folderId=folder-2&projectId=p-a&uiContext=workflow_list',
		prepare: () => {
			listWorkflow('wf-a');
			mockedStore(useWorkflowsStore).isWorkflowSaved = {};
			mocks.results['useWorkflowSaving.saveAsNewWorkflow'] = async () => 'wf-saved';
			mocks.results['useWorkflowSaving.saveCurrentWorkflow'] = async () => true;
		},
	},
	'listed workflow not counted as saved, the save gives no id': {
		user: 'memberA',
		route:
			'/workflow/wf-a?new=true&parentFolderId=folder-1&folderId=folder-2&projectId=p-a&uiContext=workflow_list',
		prepare: () => {
			listWorkflow('wf-a');
			mockedStore(useWorkflowsStore).isWorkflowSaved = {};
			mocks.results['useWorkflowSaving.saveAsNewWorkflow'] = async () => null;
			mocks.results['useWorkflowSaving.saveCurrentWorkflow'] = async () => false;
		},
	},
	'listed workflow, the workflows store says new': {
		user: 'memberA',
		prepare: () => {
			listWorkflow('wf-a');
			const workflowsStore = mockedStore(useWorkflowsStore);
			workflowsStore.workflowId = 'wf-a';
			workflowsStore.isNewWorkflow = true;
			mocks.results['useWorkflowSaving.saveAsNewWorkflow'] = async () => 'wf-saved';
			mocks.results['useWorkflowSaving.saveCurrentWorkflow'] = async () => true;
		},
	},
	'workflow only in the list getter': {
		user: 'memberA',
		prepare: () => {
			const data = workflow('wf-a', PROJECTS.personalA);
			mockedStore(useWorkflowsListStore).getWorkflowById = ((id: string) =>
				id === 'wf-a' ? data : undefined) as never;
		},
	},
	'listed workflow, the first load waits': {
		user: 'memberA',
		loadWaits: true,
		prepare: () => listWorkflow('wf-a'),
	},
	'listed workflow, the load gives it with other shares': {
		user: 'memberA',
		prepare: () => listWorkflow('wf-a'),
		loadGives: () => ({
			...workflow('wf-a', PROJECTS.personalA),
			sharedWithProjects: [PROJECTS.personalC],
		}),
	},
	'saved workflow that the list does not have, the load gives it': {
		user: 'memberA',
		prepare: () => {
			mockedStore(useWorkflowsStore).isWorkflowSaved = { 'wf-a': true };
		},
		loadGives: () => workflow('wf-a', PROJECTS.personalA),
	},
	'listed workflow, the first load waits and gives it with other shares': {
		user: 'memberA',
		loadWaits: true,
		prepare: () => listWorkflow('wf-a'),
		loadGives: () => ({
			...workflow('wf-a', PROJECTS.personalA),
			sharedWithProjects: [PROJECTS.personalC],
		}),
	},
	'saved workflow that the list does not have, the first load waits and gives it': {
		user: 'memberA',
		loadWaits: true,
		prepare: () => {
			mockedStore(useWorkflowsStore).isWorkflowSaved = { 'wf-a': true };
		},
		loadGives: () => workflow('wf-a', PROJECTS.personalA),
	},
	'listed team workflow, the team project loads later': {
		user: 'memberA',
		loadWaits: true,
		waitsFor: 'project',
		prepare: () => {
			listWorkflow('wf-team', workflow('wf-team', PROJECTS.team));
			mockedStore(useProjectsStore).fetchProject.mockResolvedValue({
				...PROJECTS.team,
				relations: [{ id: 'u-a' }, { id: 'u-b' }, { id: 'u-c' }],
			} as never);
		},
	},
	'listed team workflow': {
		user: 'memberA',
		prepare: () => {
			listWorkflow('wf-team', workflow('wf-team', PROJECTS.team));
			mockedStore(useProjectsStore).fetchProject.mockResolvedValue({
				...PROJECTS.team,
				relations: [{ id: 'u-a' }, { id: 'u-b' }, { id: 'u-c' }],
			} as never);
		},
	},
	'listed workflow of memberA without the share scope': {
		user: 'memberA',
		prepare: () =>
			listWorkflow(
				'wf-a',
				workflow(
					'wf-a',
					PROJECTS.personalA,
					WORKFLOW_SCOPES.filter((scope) => scope !== 'workflow:share'),
				),
			),
	},
	'listed workflow of another user, without the share scope': {
		user: 'memberA',
		prepare: () =>
			listWorkflow(
				'wf-b',
				workflow(
					'wf-b',
					PROJECTS.personalB,
					WORKFLOW_SCOPES.filter((scope) => scope !== 'workflow:share'),
				),
			),
	},
	'listed workflow without the sharing licence': {
		user: 'memberA',
		sharing: false,
		prepare: () => listWorkflow('wf-a'),
	},
};

const MODAL_IDS: Record<string, string> = {
	'listed team workflow': 'wf-team',
	'listed team workflow, the team project loads later': 'wf-team',
	'listed workflow of another user, without the share scope': 'wf-b',
};

async function runModalCase(name: string, testCase: ModalCase) {
	const id = MODAL_IDS[name] ?? 'wf-a';
	const result: Outcomes = {};
	if (testCase.loadWaits) {
		const releases: Array<() => void> = [];
		/** The case, and a first load that waits until the test releases it. */
		const held: ModalCase = {
			...testCase,
			prepare: () => {
				testCase.prepare();
				if (testCase.waitsFor === 'project') {
					const projectsStore = mockedStore(useProjectsStore);
					const project: unknown = projectsStore.fetchProject.getMockImplementation()?.('');
					projectsStore.fetchProject.mockImplementation(
						async () =>
							await new Promise((resolve) => releases.push(() => resolve(project as never))),
					);
					return;
				}
				mockedStore(useWorkflowsListStore).fetchWorkflow.mockImplementation(
					async () =>
						await new Promise((resolve) =>
							releases.push(() => resolve(testCase.loadGives?.() as never)),
						),
				);
			},
		};
		{
			const { container } = await mountModal(held, id);
			await settle();
			result.opened = modalCheckpoint(container);
			result.addedProject = await addProject(PROJECTS.personalC);
			confirmAnswers = ['confirm'];
			const closing = closeModal();
			await settle();
			result['closed while loading'] = modalCheckpoint(container);
			for (const release of releases) release();
			await closing;
			await settle();
			result['load done'] = modalCheckpoint(container);
		}
		{
			const { container } = await mountModal(held, id);
			await settle();
			await addProject(PROJECTS.personalC);
			const button = saveButton(container);
			if (button) await fireEvent.click(button);
			await settle();
			result['saved while loading'] = modalCheckpoint(container);
			for (const release of releases) release();
			await settle();
			result['saved while loading, load done'] = modalCheckpoint(container);
		}
		{
			const { container } = await mountModal(held, id);
			await settle();
			await addProject(PROJECTS.personalC);
			confirmAnswers = ['confirm'];
			const beforeClose = startBeforeClose();
			await settle();
			result['before close while loading'] = {
				beforeClose: beforeClose(),
				...modalCheckpoint(container),
			};
			for (const release of releases) release();
			await settle();
			result['before close, load done'] = {
				beforeClose: beforeClose(),
				...modalCheckpoint(container),
			};
		}
		return result;
	}
	{
		const { container } = await mountModal(testCase, id);
		await settle();
		result.opened = modalCheckpoint(container);
		result.addedProject = await addProject(PROJECTS.personalC);
		result.added = modalCheckpoint(container);
		const button = saveButton(container);
		if (button) await fireEvent.click(button);
		await settle();
		result.saved = modalCheckpoint(container);
	}
	{
		const { container } = await mountModal(testCase, id);
		await settle();
		await addProject(PROJECTS.personalC);
		confirmAnswers = ['confirm'];
		await closeModal();
		await settle();
		result['closed with changes, confirm'] = modalCheckpoint(container);
	}
	return result;
}

type BeforeCloseCase = {
	/** The modal case to mount. */
	modalCase: string;
	/** The answers to the "save before close" dialog. */
	answers: string[];
	/** Leave the shares as they are. */
	noChange?: boolean;
	/** The store action that saves the shares fails. */
	saveFails?: boolean;
	/** Mount the modal with another name than its key. */
	modalName?: string;
};

const BEFORE_CLOSE_CASES: Record<string, BeforeCloseCase> = {
	'no changes': { modalCase: 'listed workflow', answers: [], noChange: true },
	'changes, save': { modalCase: 'listed workflow', answers: ['confirm'] },
	'changes, close without saving': { modalCase: 'listed workflow', answers: ['cancel'] },
	'changes, the dialog is closed': { modalCase: 'listed workflow', answers: ['close'] },
	'changes, save, the save fails': {
		modalCase: 'listed workflow',
		answers: ['confirm'],
		saveFails: true,
	},
	'changes, save, the modal has another name': {
		modalCase: 'listed workflow',
		answers: ['confirm'],
		modalName: 'otherModal',
	},
	'new workflow, changes, save': {
		modalCase: 'listed workflow that the workflows store does not count as saved',
		answers: ['confirm'],
	},
	'new workflow, changes, save, the save gives no id': {
		modalCase: 'listed workflow not counted as saved, the save gives no id',
		answers: ['confirm'],
	},
};

async function runBeforeCloseCase(testCase: BeforeCloseCase) {
	const { container } = await mountModal(
		MODAL_CASES[testCase.modalCase],
		'wf-a',
		testCase.modalName,
	);
	await settle();
	if (testCase.saveFails) {
		const store = piniaStores().get(STORES.WORKFLOWS_EE);
		vi.mocked(store?.saveWorkflowSharedWith as () => Promise<void>).mockRejectedValue(
			new Error('Save failed'),
		);
	}
	if (!testCase.noChange) await addProject(PROJECTS.personalC);
	takeLog();
	confirmAnswers = [...testCase.answers];
	const beforeClose = startBeforeClose();
	await settle();
	return { beforeClose: beforeClose(), ...modalCheckpoint(container) };
}

/** The modal in the ordinary `Modal`, closed with the close button of the dialog. */
const renderModalInDialog = createComponentRenderer(WorkflowShareModal);

type DialogCloseCase = {
	/** The answers to the "save before close" dialog. */
	answers: string[];
	/** The first load waits until the dialog is closed. */
	loadWaits?: boolean;
};

const DIALOG_CLOSE_CASES: Record<string, DialogCloseCase> = {
	'changes, save': { answers: ['confirm'] },
	'changes, close without saving': { answers: ['cancel'] },
	'changes, the first load waits, save': { answers: ['confirm'], loadWaits: true },
};

function dialogCheckpoint() {
	const modals = document.getElementById(APP_MODALS_ELEMENT_ID);
	return {
		dom: modals ? describeDom(modals) : null,
		sharing: describeSharing(),
		calls: takeLog(),
	};
}

async function runDialogCloseCase(testCase: DialogCloseCase) {
	setupStores('memberA');
	await router.push('/workflow/wf-a');
	listWorkflow('wf-a');
	mockedStore(useUIStore).modalsById = {
		[WORKFLOW_SHARE_MODAL_KEY]: { open: true },
	} as never;
	const releases: Array<() => void> = [];
	if (testCase.loadWaits) {
		mockedStore(useWorkflowsListStore).fetchWorkflow.mockImplementation(
			async () => await new Promise((resolve) => releases.push(() => resolve(undefined as never))),
		);
	}
	if (!document.getElementById(APP_MODALS_ELEMENT_ID)) {
		const modals = document.createElement('div');
		modals.id = APP_MODALS_ELEMENT_ID;
		document.body.appendChild(modals);
	}
	takeLog();
	const rendered = renderModalInDialog({
		pinia,
		props: { modalName: WORKFLOW_SHARE_MODAL_KEY, isActive: true, data: { id: 'wf-a' } },
		global: { plugins: [router] },
	});
	unmountLast = rendered.unmount;
	await settle();
	const result: Outcomes = { opened: dialogCheckpoint() };
	result.addedProject = await addProject(PROJECTS.personalC);
	confirmAnswers = [...testCase.answers];
	const closeButton = document.querySelector('.el-dialog__headerbtn');
	result.closeButton = closeButton ? describeElement(closeButton) : 'none';
	if (closeButton) await fireEvent.click(closeButton);
	await settle();
	result.closed = dialogCheckpoint();
	if (releases.length) {
		for (const release of releases) release();
		await settle();
		result['load done'] = dialogCheckpoint();
	}
	return result;
}

// #endregion

// #region Credential sharing tab

type CredentialCase = {
	user: UserKey;
	homeProject: ProjectSharingData;
	sharedWithProjects?: ProjectSharingData[];
	canShare?: boolean;
	credSharingFlag?: boolean;
	sharing?: boolean;
	/** A credential that is not saved yet: no credential, and no id. */
	isNew?: boolean;
	/** The workflows that use the credential, as `useDependencies` gives them. */
	usedIn?: Array<[string, string, string]>;
};

const renderCredentialSharing = createComponentRenderer(CredentialSharing);

function mountCredentialSharing(testCase: CredentialCase) {
	setupStores(testCase.user, {
		credSharingFlag: testCase.credSharingFlag ?? true,
		sharing: testCase.sharing,
	});
	if (testCase.usedIn) {
		const dependencies = testCase.usedIn.map(([id, name, projectId]) => ({
			type: 'workflowParent',
			id,
			name,
			projectId,
		}));
		mocks.results['useDependencies.getDependencies'] = () => ({
			dependencies,
			inaccessibleCount: 0,
		});
	}
	mocks.results['useDependencies.fetchDependencies'] = async () => undefined;
	takeLog();
	const scopes =
		testCase.canShare === false
			? CREDENTIAL_SCOPES.filter((scope) => scope !== 'credential:share')
			: CREDENTIAL_SCOPES;
	const props = {
		credential: testCase.isNew
			? null
			: {
					id: 'cred-1',
					name: 'Shared API key',
					type: 'httpHeaderAuth',
					createdAt: now,
					updatedAt: now,
					isManaged: false,
					homeProject: testCase.homeProject,
					sharedWithProjects: testCase.sharedWithProjects ?? [],
					scopes,
				},
		credentialData: { name: 'Shared API key' },
		credentialId: testCase.isNew ? '' : 'cred-1',
		credentialPermissions: getResourcePermissions(scopes).credential,
		isSharedGlobally: false,
		modalBus: createEventBus(),
	};
	const rendered = renderCredentialSharing({ pinia, props, global: { plugins: [router] } });
	unmountLast = rendered.unmount;
	return rendered;
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
		calls: takeLog(),
	};
}

const CREDENTIAL_CASES: Record<string, CredentialCase> = {
	'own credential, used in a team project of the user': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		usedIn: [['wf-1', 'Team flow', 'p-team']],
	},
	'own credential, used twice in a team project of the user': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		usedIn: [
			['wf-1', 'Team flow', 'p-team'],
			['wf-2', 'Second flow', 'p-team'],
		],
	},
	'own credential, used in a project that has a share': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharedWithProjects: [PROJECTS.team],
		usedIn: [['wf-1', 'Team flow', 'p-team']],
	},
	'credential of memberA, seen by the admin': {
		user: 'admin',
		homeProject: PROJECTS.personalA,
		usedIn: [['wf-1', 'Team flow', 'p-team']],
	},
	'own credential, without the sharing licence': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		sharing: false,
		usedIn: [['wf-1', 'Team flow', 'p-team']],
	},
	'new credential': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		isNew: true,
		usedIn: [['wf-1', 'Team flow', 'p-team']],
	},
	'credential of a project without a name, seen by the admin': {
		user: 'admin',
		homeProject: project('p-x', '', 'personal'),
		usedIn: [['wf-1', 'Team flow', 'p-team']],
	},
	'own credential, no usage data': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
	},
	'own credential, without the credential sharing flag': {
		user: 'memberA',
		homeProject: PROJECTS.personalA,
		credSharingFlag: false,
		usedIn: [['wf-1', 'Team flow', 'p-team']],
	},
	'credential of memberB, without the share scope': {
		user: 'memberA',
		homeProject: PROJECTS.personalB,
		canShare: false,
		usedIn: [['wf-1', 'Team flow', 'p-team']],
	},
};

async function runCredentialCase(testCase: CredentialCase) {
	const result: Outcomes = {};
	const { container, emitted } = mountCredentialSharing(testCase);
	await settle();
	result.opened = credentialCheckpoint(container, emitted);
	const share = [...container.querySelectorAll('button')].find(
		(button) => normalize(button.textContent) === 'Share',
	);
	if (share) {
		await fireEvent.click(share);
		await settle();
		result['clicked Share'] = credentialCheckpoint(container, emitted);
	}
	return result;
}

// #endregion

describe('sharing UI with stubbed stores', () => {
	test('workflow share modal', async () => {
		const outcomes: Outcomes = {};
		for (const [name, testCase] of Object.entries(MODAL_CASES)) {
			outcomes[name] = await runModalCase(name, testCase);
		}
		expect(outcomes).toMatchSnapshot();
	}, 120_000);

	test('workflow share modal, before close', async () => {
		const outcomes: Outcomes = {};
		for (const [name, testCase] of Object.entries(BEFORE_CLOSE_CASES)) {
			outcomes[name] = await runBeforeCloseCase(testCase);
		}
		expect(outcomes).toMatchSnapshot();
	}, 120_000);

	test('workflow share modal in the ordinary Modal', async () => {
		const outcomes: Outcomes = {};
		for (const [name, testCase] of Object.entries(DIALOG_CLOSE_CASES)) {
			outcomes[name] = await runDialogCloseCase(testCase);
		}
		expect(outcomes).toMatchSnapshot();
	}, 120_000);

	test('credential sharing tab', async () => {
		const outcomes: Outcomes = {};
		for (const [name, testCase] of Object.entries(CREDENTIAL_CASES)) {
			outcomes[name] = await runCredentialCase(testCase);
		}
		expect(outcomes).toMatchSnapshot();
	}, 120_000);
});
