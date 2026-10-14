// Fork test (not in upstream n8n): the source control editor as a black box: the store, the
// settings page with the licence feature, and the push, pull and pull result modals. The test runs
// them against a fake server, clicks and types into their controls, and records what a user sees
// (text, test ids, controls, icons), the requests, the navigation, the toasts, the telemetry and
// the open modals. It records no markup and no styles. The snapshot was recorded against the
// enterprise files, and the fork files give the same snapshot. See `../../FORK.md`.
import type { SourceControlledFile } from '@n8n/api-types';
import { setNotify } from '@n8n/composables/useToast';
import { createEventBus } from '@n8n/utils/event-bus';
import { fireEvent } from '@testing-library/vue';
import { defineComponent, isVNode, type VNode } from 'vue';

import { createComponentRenderer, renderComponent } from '@/__tests__/render';
import { useUIStore } from '@/app/stores/ui.store';
import {
	describeDom,
	finishPages,
	installRecorders,
	normalize,
	pinia,
	plain,
	record,
	route,
	router,
	ServerError,
	setUnmount,
	settle,
	setup,
	takeLog,
	type Scenario,
} from '@/features/ai/evaluation/__tests__/golden/harness';

import * as subject from './subject';

// A virtual list renders a few rows in the DOM of the tests, and reuses them when the list changes.
// The stub renders each item, so that the record shows the full list.
vi.mock('vue-virtual-scroller', async () => {
	const { defineComponent, h } = await import('vue');
	const { record: recordCall } = await import('@/features/ai/evaluation/__tests__/golden/harness');
	const RecycleScroller = defineComponent({
		name: 'RecycleScroller',
		props: { items: { type: Array, default: () => [] } },
		setup(props, { slots, expose }) {
			expose({
				scrollToItem: (index: unknown) => recordCall('scroller.scrollToItem', index),
				scrollToBottom: () => recordCall('scroller.scrollToBottom'),
			});
			return () =>
				h(
					'div',
					props.items.map((item, index) =>
						h('div', { key: index }, slots.default?.({ item, index, active: true })),
					),
				);
		},
	});
	const DynamicScrollerItem = defineComponent({
		name: 'DynamicScrollerItem',
		setup(_props, { slots }) {
			return () => h('div', slots.default?.());
		},
	});
	return { RecycleScroller, DynamicScroller: RecycleScroller, DynamicScrollerItem };
});

// #region Fixtures

const LICENSED = { enterprise: { sourceControl: true } };
const WITH_DIFFS = { enterprise: { sourceControl: true, workflowDiffs: true } };

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGolden n8n deploy key';

const PREFS_DISCONNECTED = {
	branchName: '',
	branches: [],
	connectionType: 'ssh',
	connected: false,
	repositoryUrl: '',
	branchReadOnly: false,
	branchColor: '#5296D6',
	keyGeneratorType: 'ed25519',
	publicKey: PUBLIC_KEY,
};

const PREFS_CONNECTED = {
	...PREFS_DISCONNECTED,
	branchName: 'main',
	connected: true,
	repositoryUrl: 'git@github.com:acme/flows.git',
};

const PREFS_HTTPS = {
	...PREFS_CONNECTED,
	connectionType: 'https',
	repositoryUrl: 'https://github.com/acme/flows.git',
};

const BRANCHES = { branches: ['main', 'dev', 'release'], currentBranch: 'main' };

type Owner = NonNullable<SourceControlledFile['owner']>;

const PERSONAL: Owner = {
	type: 'personal',
	projectId: 'p0',
	projectName: 'Test User <user@example.com>',
};
const TEAM: Owner = { type: 'team', projectId: 'p1', projectName: 'Team' };

const FOLDERS: Record<string, string> = {
	workflow: 'workflows',
	credential: 'credential_stubs',
	datatable: 'datatables',
	project: 'projects',
};

const file = (
	id: string,
	name: string,
	type: SourceControlledFile['type'],
	status: SourceControlledFile['status'],
	extra: Partial<SourceControlledFile> = {},
): SourceControlledFile => ({
	id,
	name,
	type,
	status,
	location: 'local',
	conflict: false,
	file: FOLDERS[type]
		? `/home/node/.n8n/git/${FOLDERS[type]}/${id}.json`
		: `/home/node/.n8n/git/${type}.json`,
	updatedAt: '2026-01-02T03:04:05.000Z',
	...extra,
});

const WF_NEW = file('wf1', 'New workflow', 'workflow', 'created', {
	isLocalPublished: false,
	parentFolderId: null,
	folderPath: [],
	owner: PERSONAL,
});
const WF_CHANGED = file('wf2', 'Changed workflow', 'workflow', 'modified', {
	conflict: true,
	isLocalPublished: true,
	parentFolderId: 'f1',
	folderPath: ['Folder A'],
	remoteFolderPath: ['Folder B'],
	owner: TEAM,
});
const WF_DELETED = file('wf3', 'Deleted workflow', 'workflow', 'deleted', {
	parentFolderId: null,
	folderPath: [],
	owner: TEAM,
});
const WF_NESTED = file('wf4', 'Nested workflow', 'workflow', 'created', {
	isLocalPublished: false,
	parentFolderId: 'f2',
	folderPath: ['Folder A', 'Sub folder'],
	owner: TEAM,
});
const CRED_NEW = file('cr1', 'New credential', 'credential', 'created', { owner: TEAM });
const CRED_CHANGED = file('cr2', 'Changed credential', 'credential', 'modified', {
	owner: PERSONAL,
});
const VARIABLE = file('var1', 'MY_VAR', 'variables', 'created', {
	file: '/home/node/.n8n/git/variable_stubs.json',
});
const TAG = file('tag1', 'alpha', 'tags', 'created');
const FOLDER = file('f1', 'Folder A', 'folders', 'created');
const PROJECT = file('p1', 'Team', 'project', 'created', { owner: TEAM });
const TABLE = file('dt1', 'Table', 'datatable', 'modified', { owner: TEAM });

const PUSH_STATUS = [
	WF_NEW,
	WF_CHANGED,
	WF_DELETED,
	WF_NESTED,
	CRED_NEW,
	CRED_CHANGED,
	VARIABLE,
	TAG,
	FOLDER,
	PROJECT,
	TABLE,
];

const remote = (entry: SourceControlledFile): SourceControlledFile => ({
	...entry,
	location: 'remote',
});

const PULL_STATUS = PUSH_STATUS.map(remote);

const PROJECTS = [
	{
		id: 'p0',
		name: 'Test User <user@example.com>',
		icon: null,
		type: 'personal',
		role: 'project:personalOwner',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	},
	{
		id: 'p1',
		name: 'Team',
		icon: { type: 'icon', value: 'layers' },
		type: 'team',
		role: 'project:admin',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	},
];

// #endregion

// #region Recording

let container: Element;
const vueErrors: string[] = [];

function effects() {
	const entries = takeLog();
	const result: Record<string, unknown> = {};
	if (entries.length) result.effects = entries;
	if (vueErrors.length) result.errors = [...new Set(vueErrors)];
	vueErrors.length = 0;
	return result;
}

function isShown(element: Element | null): boolean {
	for (let current = element; current; current = current.parentElement) {
		if (current.hasAttribute('hidden')) return false;
		if (current instanceof HTMLElement && current.style.display === 'none') return false;
	}
	return true;
}

/** A toast message that is a VNode, as the text, test ids and controls that it renders. */
function renderMessage(message: VNode) {
	const rendered = renderComponent(defineComponent({ render: () => message }), {
		pinia,
		global: { plugins: [router] },
	});
	const text = plain(describeDom(rendered.container));
	rendered.unmount();
	rendered.container.remove();
	return text;
}

function installToastRecorder() {
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

/** The open modals, the open message boxes and the open dropdowns, outside the page. */
function view() {
	const result: Record<string, unknown> = {};
	const modals = Object.entries(useUIStore().modalsById)
		.filter(([, modal]) => modal.open)
		.map(([name]) => name);
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
function screen(modalTestId?: string) {
	if (modalTestId) {
		const modal = document.body.querySelector(`[data-test-id="${modalTestId}"]`);
		return {
			...view(),
			modal: modal && isShown(modal) ? plain(describeDom(modal)) : '<closed>',
		};
	}
	return { ...view(), page: plain(describeDom(container)) };
}

/**
 * Finds a control: by a CSS selector after `css:`, by a CSS selector and an exact text after
 * `text:` (`text:<selector>|<text>`, also hidden elements), by its test id, or by its text. A `#n`
 * at the end picks the n-th match.
 */
function find(target: string): Element | undefined {
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
			'button, a, [role="button"], [role="option"], [role="tab"], [role="radio"], [role="menuitem"], li, label',
		),
	];
	// A shown control first. The options of a select stay hidden in the DOM of the tests.
	const exact =
		candidates.find((element) => isShown(element) && normalize(element.textContent) === target) ??
		candidates.find((element) => normalize(element.textContent) === target);
	if (exact) return exact;
	return [...document.body.querySelectorAll('*')]
		.filter(isShown)
		.filter((element) => normalize(element.textContent) === target)
		.pop();
}

/** A click, a text to type into a field, a key, or a time to let pass. */
type Step =
	| string
	| ['type', string, string]
	| ['key', string, string]
	| ['wait', number]
	| ['hover', string];

async function act(step: Step, modalTestId?: string) {
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
	const [kind, target, value] = step;
	const element = find(target);
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

async function mountPage(component: Parameters<typeof createComponentRenderer>[0]) {
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
	})({ pinia });
	setUnmount(rendered.unmount);
	container = rendered.container;
	await settle();
}

async function mountModal(
	component: Parameters<typeof createComponentRenderer>[0],
	name: string,
	data: Record<string, unknown>,
) {
	useUIStore().openModalWithData({ name, data });
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
	})({ pinia, props: { modalName: name, data } });
	setUnmount(rendered.unmount);
	container = rendered.container;
	await settle();
}

async function prepare(scenario: Scenario, server: () => void) {
	vueErrors.length = 0;
	await setup({ settings: LICENSED, ...scenario });
	installToastRecorder();
	server();
}

// #endregion

// #region Servers

function settingsServer(
	preferences: Record<string, unknown>,
	options: { failures?: string[] } = {},
) {
	return () => {
		let current = { ...preferences };
		const fail = (name: string) => {
			if (options.failures?.includes(name)) throw new ServerError(400, `The ${name} failed`);
		};
		route('GET', /^\/source-control\/preferences$/, () => {
			fail('preferences');
			return current;
		});
		route('POST', /^\/source-control\/preferences$/, (request) => {
			fail('connection');
			const body = request.data as Record<string, unknown>;
			current = { ...current, ...body, connected: true };
			delete current.httpsPassword;
			delete current.httpsUsername;
			return current;
		});
		route('PATCH', /^\/source-control\/preferences$/, (request) => {
			fail('update');
			current = { ...current, ...(request.data as Record<string, unknown>) };
			return current;
		});
		let branchCalls = 0;
		route('GET', /^\/source-control\/get-branches$/, () => {
			branchCalls++;
			// The page loads the branches when it opens: only a refresh fails.
			if (branchCalls > 1) fail('branches');
			return BRANCHES;
		});
		route('POST', /^\/source-control\/disconnect$/, () => {
			fail('disconnect');
			current = { ...current, connected: false, branchName: '', repositoryUrl: '' };
			return current;
		});
		route('POST', /^\/source-control\/generate-key-pair$/, (request) => {
			fail('key');
			const type = (request.data as { keyGeneratorType?: string }).keyGeneratorType;
			current = {
				...current,
				keyGeneratorType: type ?? 'ed25519',
				publicKey: type === 'rsa' ? 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABGolden' : `${PUBLIC_KEY} 2`,
			};
			return current;
		});
	};
}

/**
 * The project search of a page answers with the scopes of the user in each project, as the server
 * does. The owner filter of the push modal lists only the projects with `sourceControl:push`.
 */
function withPushScope(install: () => void) {
	return () => {
		install();
		route('GET', /^\/projects$/, (request) =>
			request.params
				? PROJECTS.map((project) => ({ ...project, scopes: ['sourceControl:push'] }))
				: PROJECTS,
		);
	};
}

function modalServer(
	status: unknown[],
	options: {
		pushResult?: unknown;
		pullResult?: unknown;
		statusError?: number;
		pushError?: number;
		pullError?: number;
		preferences?: Record<string, unknown>;
	} = {},
) {
	return () => {
		route('GET', /^\/source-control\/preferences$/, () => options.preferences ?? PREFS_CONNECTED);
		route('GET', /^\/projects$/, () => PROJECTS);
		route('GET', /^\/projects\/my-projects$/, () => PROJECTS);
		route('GET', /^\/source-control\/get-status$/, () => {
			if (options.statusError) throw new ServerError(options.statusError, 'The status failed');
			return status;
		});
		route('POST', /^\/source-control\/push-workfolder$/, (request) => {
			if (options.pushError) throw new ServerError(options.pushError, 'The push failed');
			if (options.pushResult !== undefined) return options.pushResult;
			const names = (request.data as { fileNames?: Array<{ id: string }> }).fileNames ?? [];
			return {
				files: status.filter((entry) =>
					names.some((name) => name.id === (entry as { id: string }).id),
				),
				commit: { hash: 'abc1234', message: 'Ship it', branch: 'main' },
			};
		});
		route('POST', /^\/source-control\/pull-workfolder$/, () => {
			if (options.pullError) throw new ServerError(options.pullError, 'The pull failed');
			return options.pullResult ?? status;
		});
		route('GET', /^\/source-control\/remote-content\/workflow\/(.+)$/, (_request, match) => ({
			content: { id: match[1], name: 'Remote', nodes: [], connections: {} },
			type: 'workflow',
		}));
	};
}

// #endregion

// #region Flows

async function settingsSteps(
	scenario: Scenario,
	server: () => void,
	actions: Step[] = [],
): Promise<unknown[]> {
	await prepare({ path: '/settings/environments', ...scenario }, server);
	await mountPage(subject.SettingsSourceControl);
	const result: unknown[] = [{ mounted: true, ...effects(), screen: screen() }];
	for (const action of actions) result.push(await act(action));
	return result;
}

async function modalSteps(
	modal: 'push' | 'pull',
	scenario: Scenario,
	server: () => void,
	actions: Step[] = [],
): Promise<unknown[]> {
	await prepare({ path: `/home/workflows?sourceControl=${modal}`, ...scenario }, server);
	const testId = modal === 'push' ? 'sourceControlPush-modal' : 'sourceControlPull-modal';
	const eventBus = createEventBus();
	eventBus.on('closed', () => record('eventBus', 'closed'));
	if (modal === 'push') {
		await mountModal(subject.SourceControlPushModal, subject.SOURCE_CONTROL_PUSH_MODAL_KEY, {
			eventBus,
		});
	} else {
		await mountModal(subject.SourceControlPullModal, subject.SOURCE_CONTROL_PULL_MODAL_KEY, {
			eventBus,
		});
	}
	const result: unknown[] = [{ mounted: true, ...effects(), screen: screen(testId) }];
	for (const action of actions) result.push(await act(action, testId));
	const resultModal = useUIStore().modalsById[subject.SOURCE_CONTROL_PULL_RESULT_MODAL_KEY];
	if (resultModal?.open) result.push({ pullResultModalData: plain(resultModal.data) });
	return result;
}

// #endregion

/** The pull event of the source control event bus goes to the log. */
const onPull = (payload: unknown) => record('sourceControlEventBus.pull', plain(payload));

beforeEach(() => {
	installRecorders();
	// The DOM of the tests has no clipboard command.
	Object.defineProperty(document, 'execCommand', {
		configurable: true,
		value: (...args: unknown[]) => {
			record('document.execCommand', args[0]);
			return true;
		},
	});
	vi.useFakeTimers({
		now: new Date('2026-03-01T12:00:00.000Z'),
		toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
	});
	subject.sourceControlEventBus.on('pull', onPull);
});

afterEach(() => {
	subject.sourceControlEventBus.off('pull', onPull);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

afterAll(finishPages);

describe('the source control editor', () => {
	test('the store', async () => {
		const result: Record<string, unknown> = {};
		const outcome = async (run: () => unknown) => {
			try {
				return { result: plain(await run()) };
			} catch (error) {
				return {
					error:
						error instanceof Error ? { name: error.name, message: error.message } : String(error),
				};
			}
		};

		await prepare({}, () => {
			modalServer(PUSH_STATUS)();
			settingsServer(PREFS_DISCONNECTED)();
		});
		const store = subject.useSourceControlStore();
		result['the first state'] = {
			members: Object.keys(store)
				.filter((key) => !key.startsWith('$') && !key.startsWith('_'))
				.sort(),
			preferences: plain(store.preferences),
			state: plain(store.state),
			sshKeyTypesWithLabel: plain(store.sshKeyTypesWithLabel),
		};
		const call = async (name: string, run: () => unknown) => {
			result[name] = {
				outcome: await outcome(run),
				preferences: plain(store.preferences),
				state: plain(store.state),
				...effects(),
			};
		};
		await call('getPreferences', async () => await store.getPreferences());
		await call(
			'savePreferences',
			async () =>
				await store.savePreferences({
					repositoryUrl: 'git@github.com:acme/flows.git',
					connectionType: 'ssh',
				}),
		);
		await call('getBranches', async () => await store.getBranches());
		await call(
			'updatePreferences',
			async () =>
				await store.updatePreferences({
					branchName: 'dev',
					branchReadOnly: true,
					branchColor: '#000000',
				}),
		);
		await call('setPreferences', () => store.setPreferences({ branchName: 'release' }));
		await call('generateKeyPair rsa', async () => await store.generateKeyPair('rsa'));
		await call('generateKeyPair without a type', async () => await store.generateKeyPair());
		await call('getStatus', async () => await store.getStatus());
		await call('getAggregatedStatus', async () => await store.getAggregatedStatus());
		await call(
			'pushWorkfolder',
			async () =>
				await store.pushWorkfolder({
					commitMessage: 'Ship it',
					fileNames: [WF_NEW, CRED_NEW],
					force: true,
				}),
		);
		await call('pullWorkfolder', async () => await store.pullWorkfolder(true, 'all'));
		await call('getRemoteWorkflow', async () => await store.getRemoteWorkflow('wf2'));
		await call('getBranches before the disconnection', async () => await store.getBranches());
		await call('disconnect keeping the key pair', async () => await store.disconnect(true));
		await call('disconnect', async () => await store.disconnect(false));

		await prepare({}, () => {
			route('GET', /^\/source-control\/.*$/, () => {
				throw new ServerError(500, 'Server down');
			});
			route('POST', /^\/source-control\/.*$/, () => {
				throw new ServerError(500, 'Server down');
			});
			route('PATCH', /^\/source-control\/.*$/, () => {
				throw new ServerError(500, 'Server down');
			});
		});
		const failing = subject.useSourceControlStore();
		for (const [name, run] of [
			['getPreferences', async () => await failing.getPreferences()],
			['savePreferences', async () => await failing.savePreferences({ repositoryUrl: 'x' })],
			['getBranches', async () => await failing.getBranches()],
			['updatePreferences', async () => await failing.updatePreferences({ branchName: 'x' })],
			['generateKeyPair', async () => await failing.generateKeyPair('ed25519')],
			['getAggregatedStatus', async () => await failing.getAggregatedStatus()],
			['disconnect', async () => await failing.disconnect(true)],
		] as const) {
			result[`${name} fails`] = {
				outcome: await outcome(run),
				preferences: plain(failing.preferences),
				...effects(),
			};
		}

		expect(result).toMatchSnapshot();
	}, 120_000);

	test('the API module', async () => {
		await prepare({}, () => {
			settingsServer(PREFS_CONNECTED)();
			modalServer(PUSH_STATUS)();
		});
		const context = { baseUrl: 'http://localhost/rest', pushRef: 'golden' };
		const api = subject.sourceControlApi;
		const result: Record<string, unknown> = { exports: Object.keys(api).sort() };
		const calls: Array<[string, () => Promise<unknown>]> = [
			['getPreferences', async () => await api.getPreferences(context)],
			[
				'savePreferences',
				async () => await api.savePreferences(context, { repositoryUrl: 'git@x:y/z.git' }),
			],
			[
				'updatePreferences',
				async () => await api.updatePreferences(context, { branchName: 'dev' }),
			],
			['getBranches', async () => await api.getBranches(context)],
			['getStatus', async () => await api.getStatus(context)],
			['getAggregatedStatus', async () => await api.getAggregatedStatus(context)],
			[
				'getAggregatedStatus with options',
				async () =>
					await api.getAggregatedStatus(context, {
						direction: 'pull',
						preferLocalVersion: false,
						verbose: true,
					}),
			],
			['getRemoteWorkflow', async () => await api.getRemoteWorkflow(context, 'wf2')],
			['disconnect', async () => await api.disconnect(context, true)],
			['generateKeyPair', async () => await api.generateKeyPair(context, 'rsa')],
			[
				'pushWorkfolder',
				async () =>
					await api.pushWorkfolder(context, {
						commitMessage: 'Ship it',
						fileNames: [WF_NEW],
						force: false,
					}),
			],
			[
				'pullWorkfolder',
				async () => await api.pullWorkfolder(context, { force: true, autoPublish: 'published' }),
			],
		];
		for (const [name, run] of calls) {
			try {
				result[name] = { result: plain(await run()), ...effects() };
			} catch (error) {
				result[name] = { error: String(error), ...effects() };
			}
		}
		expect(result).toMatchSnapshot();
	}, 120_000);

	test('the settings page, not connected', async () => {
		expect({
			'connect over SSH': await settingsSteps({}, settingsServer(PREFS_DISCONNECTED), [
				['type', 'css:input[placeholder="git@github.com:user/repository.git"]', 'not a url'],
				[
					'type',
					'css:input[placeholder="git@github.com:user/repository.git"]',
					'git@github.com:acme/flows.git',
				],
				'source-control-connect-button',
				['wait', 500],
			]),
			'refresh the key': await settingsSteps({}, settingsServer(PREFS_DISCONNECTED), [
				'source-control-refresh-ssh-key-button',
				'Cancel',
				'source-control-refresh-ssh-key-button',
				'Refresh key',
				['wait', 500],
			]),
			'change the key type': await settingsSteps({}, settingsServer(PREFS_DISCONNECTED), [
				'css:[data-test-id="source-control-ssh-key-type-select"] input',
				'RSA',
				['wait', 500],
			]),
			'connect over HTTPS': await settingsSteps({}, settingsServer(PREFS_DISCONNECTED), [
				'css:[data-test-id="source-control-connection-type-select"] input',
				'HTTPS',
				['type', 'css:input[placeholder="https://github.com/user/repository.git"]', 'ftp://x'],
				[
					'type',
					'css:input[placeholder="https://github.com/user/repository.git"]',
					'https://github.com/acme/flows.git',
				],
				['type', 'css:input[placeholder="Enter your GitHub username"]', 'octocat'],
				['type', 'css:input[placeholder="Enter your Personal Access Token (PAT)"]', 'ghp_golden'],
				'source-control-connect-button',
				['wait', 500],
			]),
			'the connection fails': await settingsSteps(
				{},
				settingsServer(PREFS_DISCONNECTED, { failures: ['connection'] }),
				[
					[
						'type',
						'css:input[placeholder="git@github.com:user/repository.git"]',
						'git@github.com:acme/flows.git',
					],
					'source-control-connect-button',
					['wait', 500],
				],
			),
			'the key refresh fails': await settingsSteps(
				{},
				settingsServer(PREFS_DISCONNECTED, { failures: ['key'] }),
				['source-control-refresh-ssh-key-button', 'Refresh key', ['wait', 500]],
			),
			'the preferences fail to load': await settingsSteps(
				{},
				settingsServer(PREFS_DISCONNECTED, { failures: ['preferences'] }),
			),
			'copy the key': await settingsSteps({}, settingsServer(PREFS_DISCONNECTED), ['copy-input']),
		}).toMatchSnapshot();
	}, 120_000);

	test('the settings page, connected', async () => {
		expect({
			'change the settings': await settingsSteps({}, settingsServer(PREFS_CONNECTED), [
				'css:[data-test-id="source-control-branch-select"] input',
				'dev',
				'source-control-read-only-checkbox',
				['type', 'css:.n8n-color-picker > .n8n-input input', '#FF0000'],
				'css:.n8n-color-picker .el-color-picker__trigger',
				['type', 'css:.el-color-dropdown__value input', '#00FF00'],
				'OK',
				'source-control-save-settings-button',
				['wait', 500],
			]),
			'refresh the branches': await settingsSteps({}, settingsServer(PREFS_CONNECTED), [
				['hover', 'source-control-refresh-branches-button'],
				'source-control-refresh-branches-button',
				['wait', 500],
			]),
			disconnect: await settingsSteps({}, settingsServer(PREFS_CONNECTED), [
				'source-control-disconnect-button',
				'Cancel',
				'source-control-disconnect-button',
				'css:.el-message-box button#1',
				['wait', 500],
			]),
			'over HTTPS': await settingsSteps({}, settingsServer(PREFS_HTTPS), [
				'source-control-read-only-checkbox',
				'source-control-save-settings-button',
				['wait', 500],
			]),
			'a protected instance': await settingsSteps(
				{},
				settingsServer({ ...PREFS_CONNECTED, branchReadOnly: true, branchColor: '#1d6acb' }),
				['source-control-read-only-checkbox', 'source-control-save-settings-button'],
			),
			'the save fails': await settingsSteps(
				{},
				settingsServer(PREFS_CONNECTED, { failures: ['update'] }),
				['source-control-save-settings-button', ['wait', 500]],
			),
			'the branches fail': await settingsSteps(
				{},
				settingsServer(PREFS_CONNECTED, { failures: ['branches'] }),
				['source-control-refresh-branches-button', ['wait', 500]],
			),
			'the disconnection fails': await settingsSteps(
				{},
				settingsServer(PREFS_CONNECTED, { failures: ['disconnect'] }),
				['source-control-disconnect-button', 'css:.el-message-box button#1', ['wait', 500]],
			),
		}).toMatchSnapshot();
	}, 120_000);

	test('the push modal', async () => {
		expect({
			'select and push': await modalSteps('push', {}, modalServer(PUSH_STATUS), [
				'source-control-push-modal-tab-credential',
				'source-control-push-modal-tab-datatable',
				'source-control-push-modal-tab-workflow',
				'source-control-push-modal-toggle-all',
				'source-control-push-modal-toggle-all',
				'source-control-push-modal-file-checkbox#0',
				'source-control-push-modal-folder-toggle#0',
				'source-control-push-modal-folder-toggle#0',
				'source-control-push-modal-folder-checkbox#0',
				['type', 'source-control-push-modal-commit', 'Ship it'],
				'source-control-push-modal-submit',
				['wait', 500],
			]),
			'search and filter': await modalSteps('push', {}, modalServer(PUSH_STATUS), [
				['type', 'source-control-push-search', 'Changed'],
				['wait', 500],
				['type', 'source-control-push-search', ''],
				['wait', 500],
				'source-control-filter-dropdown',
				['wait', 300],
				'css:[data-test-id="source-control-status-filter"] input',
				'source-control-status-filter-option#1',
				['wait', 300],
				'css:[data-test-id="source-control-folder-filter"] input',
				'Folder A',
				['wait', 300],
				'Remove filters',
				['wait', 300],
				'source-control-push-modal-tab-credential',
				['type', 'source-control-push-search', 'New'],
				['wait', 500],
			]),
			'filter by owner': await modalSteps('push', {}, modalServer(PUSH_STATUS), [
				'source-control-filter-dropdown',
				['wait', 300],
				'css:[data-test-id="project-sharing-select"] input',
				['wait', 300],
			]),
			'filter by owner with the push scope': await modalSteps(
				'push',
				{},
				withPushScope(modalServer(PUSH_STATUS)),
				[
					'source-control-filter-dropdown',
					['wait', 300],
					'css:[data-test-id="project-sharing-select"] input',
					['wait', 300],
					'text:.el-select__popper [role="option"]|Team',
					['wait', 300],
					'css:[data-test-id="project-sharing-select"] input',
					['wait', 300],
					'text:.el-select__popper [role="option"]|TUTest Useruser@example.com',
					['wait', 300],
					'source-control-push-modal-tab-datatable',
					'source-control-push-modal-tab-credential',
					'Remove filters',
					['wait', 300],
				],
			),
			'the diff of a workflow': await modalSteps(
				'push',
				{ settings: WITH_DIFFS },
				modalServer(PUSH_STATUS),
				['source-control-workflow-diff-button#1', ['wait', 300]],
			),
			'select by the row': await modalSteps('push', {}, modalServer(PUSH_STATUS), [
				'Changed workflow',
				'Changed workflow',
				'Folder A',
			]),
			'push with the Enter key': await modalSteps('push', {}, modalServer(PUSH_STATUS), [
				['type', 'source-control-push-modal-commit', 'Quick push'],
				['key', 'source-control-push-modal-commit', 'Enter'],
				['wait', 500],
			]),
			'only credentials': await modalSteps('push', {}, modalServer([CRED_NEW, CRED_CHANGED]), []),
			'a single credential': await modalSteps('push', {}, modalServer([CRED_NEW]), [
				['type', 'source-control-push-modal-commit', 'One credential'],
				'source-control-push-modal-submit',
				['wait', 500],
			]),
			'a single workflow': await modalSteps('push', {}, modalServer([WF_NEW]), [
				'source-control-push-modal-toggle-all',
				['type', 'source-control-push-modal-commit', 'One workflow'],
				'source-control-push-modal-submit',
				['wait', 500],
			]),
			'only variables and tags': await modalSteps('push', {}, modalServer([VARIABLE, TAG]), [
				['type', 'source-control-push-modal-commit', 'Settings only'],
				'source-control-push-modal-submit',
				['wait', 500],
			]),
			'nothing to push': await modalSteps('push', {}, modalServer([]), [['wait', 500]]),
			'the status fails': await modalSteps(
				'push',
				{},
				modalServer(PUSH_STATUS, { statusError: 500 }),
				[['wait', 500]],
			),
			'the push fails': await modalSteps('push', {}, modalServer(PUSH_STATUS, { pushError: 409 }), [
				'source-control-push-modal-toggle-all',
				['type', 'source-control-push-modal-commit', 'Ship it'],
				'source-control-push-modal-submit',
				['wait', 500],
			]),
			cancel: await modalSteps('push', {}, modalServer(PUSH_STATUS), [
				'css:[data-test-id="sourceControlPush-modal"] .el-dialog__headerbtn',
				['wait', 500],
			]),
			'from a workflow page': await modalSteps(
				'push',
				{ path: '/workflow/wf2?sourceControl=push' },
				modalServer(PUSH_STATUS),
				[],
			),
			'as a project admin': await modalSteps(
				'push',
				{ role: 'global:member', projectRole: 'project:admin' },
				modalServer(PUSH_STATUS),
				[],
			),
		}).toMatchSnapshot();
	}, 120_000);

	test('the pull modal', async () => {
		const published = [
			{ ...remote(WF_CHANGED), status: 'modified' },
			{
				...remote(WF_NEW),
				publishingError: 'Unrecognized node type: n8n-nodes-base.missing',
			},
		];
		const result = {
			'pull and override': await modalSteps('pull', {}, modalServer(PULL_STATUS), [
				'source-control-pull-modal-tab-credential',
				'source-control-pull-modal-tab-datatable',
				'source-control-pull-modal-tab-workflow',
				'source-control-pull-modal-folder-toggle#0',
				'source-control-pull-modal-folder-toggle#0',
				'force-pull',
				['wait', 500],
			]),
			'auto-publish': await modalSteps(
				'pull',
				{},
				modalServer(PULL_STATUS, { pullResult: published }),
				[
					'css:[data-test-id="auto-publish-select"] input',
					'If workflow already publishedWorkflows that are published in this instance',
					'force-pull',
					['wait', 500],
				],
			),
			'auto-publish all': await modalSteps(
				'pull',
				{},
				modalServer(PULL_STATUS, { pullResult: published }),
				[
					'css:[data-test-id="auto-publish-select"] input',
					'OnAttempt to publish all workflows',
					'force-pull',
					['wait', 500],
				],
			),
			'the diff of a workflow': await modalSteps(
				'pull',
				{ settings: WITH_DIFFS },
				modalServer(PULL_STATUS),
				[
					'Changed workflow',
					['wait', 300],
					'css:[data-test-id="sourceControlPull-modal"] [data-test-id="pull-modal-item"] button',
					['wait', 300],
				],
			),
			'only new workflows': await modalSteps(
				'pull',
				{},
				modalServer([remote(WF_NEW), remote(WF_NESTED)]),
				['force-pull', ['wait', 500]],
			),
			'a changed credential and a conflicting data table': await modalSteps(
				'pull',
				{},
				modalServer([
					remote(CRED_CHANGED),
					{ ...remote(TABLE), conflict: true },
					{ ...remote(TABLE), id: 'dt2', name: 'Other table', conflict: true },
				]),
				['source-control-pull-modal-tab-datatable', 'force-pull', ['wait', 500]],
			),
			'a single workflow': await modalSteps('pull', {}, modalServer([remote(WF_NEW)]), [
				'force-pull',
				['wait', 500],
			]),
			'a conflicting credential': await modalSteps(
				'pull',
				{},
				modalServer([{ ...remote(CRED_CHANGED), conflict: true }, remote(TAG)]),
				['force-pull', ['wait', 500]],
			),
			'new credentials and variables': await modalSteps(
				'pull',
				{},
				modalServer([remote(CRED_NEW), remote(VARIABLE)]),
				['force-pull', ['wait', 500]],
			),
			'archived and conflicting workflows': await modalSteps(
				'pull',
				{},
				modalServer([
					{ ...remote(WF_CHANGED), isRemoteArchived: true },
					{ ...remote(WF_NESTED), conflict: true, status: 'modified' },
				]),
				[],
			),
			'nothing to pull': await modalSteps('pull', {}, modalServer([]), [['wait', 500]]),
			'the status fails': await modalSteps(
				'pull',
				{},
				modalServer(PULL_STATUS, { statusError: 500 }),
				[['wait', 500]],
			),
			'the pull fails': await modalSteps('pull', {}, modalServer(PULL_STATUS, { pullError: 409 }), [
				'force-pull',
				['wait', 500],
			]),
			cancel: await modalSteps('pull', {}, modalServer(PULL_STATUS), ['Cancel', ['wait', 500]]),
		};
		expect(result).toMatchSnapshot();
	}, 120_000);

	test('the pull result modal', async () => {
		const workflows = [
			{ ...remote(WF_CHANGED), status: 'modified' },
			{ ...remote(WF_NEW), publishingError: 'Unrecognized node type: n8n-nodes-base.missing' },
			{ ...remote(WF_NESTED), status: 'created' },
		];
		const steps = async (data: Record<string, unknown>, actions: Step[]) => {
			await prepare({ path: '/home/workflows' }, () => modalServer([])());
			await mountModal(
				subject.SourceControlPullResultModal,
				subject.SOURCE_CONTROL_PULL_RESULT_MODAL_KEY,
				data,
			);
			const testId = 'sourceControlPullResult-modal';
			const out: unknown[] = [{ mounted: true, ...effects(), screen: screen(testId) }];
			for (const action of actions) out.push(await act(action, testId));
			return out;
		};
		expect({
			'published and failed': await steps({ workflows }, [
				'Failed to publish',
				'Published',
				'Close',
				['wait', 500],
			]),
			'all published': await steps({ workflows: [workflows[0]] }, ['Failed to publish']),
			'all failed': await steps({ workflows: [workflows[1]] }, ['Published']),
			'no workflows': await steps({ workflows: [] }, []),
		}).toMatchSnapshot();
	}, 120_000);
});
