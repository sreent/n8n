// Fork test (not in upstream n8n): the editor of Git connections (promotions) as a black box: the
// module descriptor, the project banners and the selection modal. The test runs them against a
// fake server, clicks and types into their controls, and records what a user sees (text, test
// ids, controls, icons), the requests, the navigation, the toasts, the telemetry and the open
// modals. It records no markup and no styles. The snapshot was recorded against the enterprise
// files, and the fork files give the same snapshot. See `../../FORK.md`.
import { PROJECT_SCOPE_MAP } from '@n8n/permissions';

import { useUIStore } from '@/app/stores/ui.store';
import {
	finishPages,
	installRecorders,
	plain,
	raw,
	record,
	route,
	router,
	ServerError,
	settle,
	type Scenario,
} from '@/features/ai/evaluation/__tests__/golden/harness';

import {
	APPLIED,
	APPLIED_NOT_PUBLISHED,
	APPLIED_PROJECT_REMOVED,
	APPLY_CHANGES,
	APPLY_SOURCE,
	BLOCKED,
	BLOCKED_HARD,
	CONNECTION,
	DATE,
	GIT_SCOPES,
	PROMOTE_CHANGES,
	SHA_APPLY,
	SHA_PROMOTE,
	SOURCE_CHANGED,
	TEAM,
	config,
	connection,
	project,
	sorted,
} from './fixtures';
import { act, effects, load, mountComponent, prepare, screen, shape, type Step } from './recording';
import * as subject from './subject';

// #region Servers

type ServerOptions = {
	project?: Record<string, unknown>;
	connections?: unknown[];
	promote?: unknown[] | 'error';
	apply?: unknown[] | 'error';
	/** The answers of the apply route, one for each call. The last one repeats. */
	applyResults?: Array<Record<string, unknown> | 'error'>;
	continueResults?: Array<Record<string, unknown> | 'error'>;
	/** The project is gone after the first apply. */
	projectGoneAfterApply?: boolean;
	/** The public API refuses to create a credential. */
	failCredential?: boolean;
};

function server(options: ServerOptions = {}) {
	return () => {
		const current = options.project ?? TEAM;
		let applied = false;
		route('GET', /^\/projects\/([^/]+)$/, (_request, match) => {
			if (match[1] !== current.id) throw new ServerError(404, 'Project not found');
			if (applied && options.projectGoneAfterApply) {
				throw new ServerError(404, 'Could not find project');
			}
			return current;
		});
		route('GET', /^\/variables$/, () => []);
		route('POST', /^\/api\/v1\/credentials$/, (request) => {
			if (options.failCredential) throw new ServerError(400, 'Credential refused');
			const body = request.data as Record<string, unknown>;
			return raw({
				id: body.id ?? 'credNew',
				name: body.name,
				type: body.type,
				isManaged: false,
				isGlobal: false,
				isResolvable: false,
				createdAt: DATE,
				updatedAt: DATE,
				scopes: ['credential:read', 'credential:update'],
				homeProject: { id: 'p1', name: 'Team', type: 'team', icon: null },
			});
		});
		route('POST', /^\/variables$/, (request) => {
			const body = request.data as Record<string, unknown>;
			return { id: 'varNew', type: 'string', ...body };
		});
		route('GET', /^\/types\/credentials\.json$/, () =>
			raw([
				{
					name: 'slackApi',
					displayName: 'Slack API',
					properties: [
						{ displayName: 'Access Token', name: 'accessToken', type: 'string', default: '' },
					],
				},
				{
					name: 'httpHeaderAuth',
					displayName: 'Header Auth',
					properties: [{ displayName: 'Name', name: 'name', type: 'string', default: '' }],
				},
			]),
		);
		route('GET', /^\/projects\/my-projects$/, () => [
			{
				id: 'p0',
				name: 'Test User <user@example.com>',
				icon: null,
				type: 'personal',
				role: 'project:personalOwner',
				scopes: sorted(PROJECT_SCOPE_MAP['project:personalOwner']),
				createdAt: DATE,
				updatedAt: DATE,
			},
			{ ...current, role: 'project:admin' },
		]);
		route('GET', /^\/api\/v1\/promotions\/connections$/, () =>
			raw({ data: options.connections ?? [CONNECTION], nextCursor: null }),
		);
		route('GET', /^\/promotions\/([^/]+)\/changes\/(promote|apply)$/, (_request, match) => {
			const rows = match[2] === 'promote' ? options.promote : options.apply;
			if (rows === 'error') throw new ServerError(500, 'Git failed');
			return {
				commitSha: match[2] === 'promote' ? SHA_PROMOTE : SHA_APPLY,
				changes: rows ?? (match[2] === 'promote' ? PROMOTE_CHANGES : APPLY_CHANGES),
			};
		});
		const answer = (
			results: Array<Record<string, unknown> | 'error'> | undefined,
			calls: number,
		) => {
			const list = results ?? [APPLIED];
			const result = list[Math.min(calls, list.length - 1)];
			if (result === 'error') throw new ServerError(500, 'Apply failed');
			return raw(result);
		};
		let applyCalls = 0;
		route('POST', /^\/api\/v1\/promotions\/connections\/conn1\/apply$/, () => {
			applied = true;
			return answer(options.applyResults, applyCalls++);
		});
		let continueCalls = 0;
		route('POST', /^\/api\/v1\/promotions\/connections\/conn1\/apply\/continue$/, () =>
			answer(options.continueResults, continueCalls++),
		);
	};
}

// #endregion

// #region Editors

type EditorState = Record<string, unknown>;

const modalState = (name: string): EditorState =>
	(useUIStore().modalsById[name] ?? {}) as unknown as EditorState;

/** Saves the open credential editor as a user would: through its `createCredential` callback. */
const saveCredential = (details: Record<string, unknown>) => async () => {
	const state = modalState('editCredential');
	const create = state.createCredential as
		| ((payload: unknown, projectId: string) => Promise<unknown>)
		| undefined;
	const destination = state.destination as { project?: { id?: string } } | undefined;
	if (!create) return '<no createCredential>';
	return await create(details, destination?.project?.id ?? '');
};

const closeEditor = (name: string) => () => {
	useUIStore().closeModal(name);
};

/** Saves the open variable modal through its `onCreate` callback. */
const saveVariable = (values: Record<string, unknown>) => async () => {
	const data = (modalState('variableModal').data ?? {}) as Record<string, unknown>;
	const create = data.onCreate as ((variable: unknown) => unknown) | undefined;
	if (!create) return '<no onCreate>';
	return await create(values);
};

// #endregion

// #region Flows

async function bannerSteps(scenario: Scenario, serve: () => void, actions: Step[] = []) {
	await prepare({ path: '/projects/p1/workflows', ...scenario }, serve);
	await mountComponent(subject.PromotionBanners);
	const result: unknown[] = [{ mounted: true, ...effects(), screen: screen() }];
	for (const action of actions) result.push(await act(action));
	return result;
}

async function modalSteps(
	data: Record<string, unknown>,
	scenario: Scenario,
	serve: () => void,
	actions: Step[] = [],
) {
	await prepare({ path: '/projects/p1/workflows', ...scenario }, serve);
	useUIStore().openModalWithData({ name: subject.PROMOTION_SELECT_MODAL_KEY, data });
	const modal = subject.PromotionsModule.modals?.[0];
	await mountComponent(await load(modal?.component), {
		modalName: subject.PROMOTION_SELECT_MODAL_KEY,
		data,
	});
	const testId = `${subject.PROMOTION_SELECT_MODAL_KEY}-modal`;
	const result: unknown[] = [{ mounted: true, ...effects(), screen: screen(testId) }];
	for (const action of actions) result.push(await act(action, testId));
	return result;
}

// #endregion

/** The events of the promotion event bus go to the log. */
const onApplied = (payload: unknown) => record('promotionEventBus.applied', plain(payload));
const onProjectRemoved = (payload: unknown) =>
	record('promotionEventBus.projectRemoved', plain(payload));

beforeEach(() => {
	installRecorders();
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
	subject.promotionEventBus.on('applied', onApplied);
	subject.promotionEventBus.on('projectRemoved', onProjectRemoved);
});

afterEach(() => {
	subject.promotionEventBus.off('applied', onApplied);
	subject.promotionEventBus.off('projectRemoved', onProjectRemoved);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

afterAll(finishPages);

describe('the editor of Git connections', () => {
	test('the module descriptor, the constants and the event bus', async () => {
		await prepare({ path: '/settings/promotions' }, server());
		const module = subject.PromotionsModule;
		const settingsRoute = module.routes?.[0];
		const meta = (settingsRoute?.meta ?? {}) as Record<string, unknown>;
		const telemetry = meta.telemetry as { getProperties?: (route: unknown) => unknown } | undefined;
		const guard = settingsRoute?.beforeEnter as
			| ((to: unknown, from: unknown, next?: unknown) => unknown)
			| undefined;
		const guardResult = async () => {
			try {
				return plain(
					await guard?.(router.currentRoute.value, router.currentRoute.value, () => 'next'),
				);
			} catch (error) {
				return { error: String(error) };
			}
		};
		const result: Record<string, unknown> = {
			descriptor: shape(module),
			constants: {
				PROMOTION_SELECT_MODAL_KEY: subject.PROMOTION_SELECT_MODAL_KEY,
				PROMOTIONS_SETTINGS_VIEW: subject.PROMOTIONS_SETTINGS_VIEW,
			},
			eventBus: Object.keys(subject.promotionEventBus).sort(),
			telemetry: plain(telemetry?.getProperties?.(router.currentRoute.value)),
			'guard while enabled': await guardResult(),
		};
		useUIStore();
		const { useSettingsStore } = await import('@n8n/stores/settings.store');
		useSettingsStore().setSettings({ ...useSettingsStore().settings, activeModules: [] });
		result['guard while the module is off'] = await guardResult();
		useSettingsStore().setSettings({
			...useSettingsStore().settings,
			activeModules: ['promotions'],
			envFeatureFlags: { N8N_ENV_FEAT_PROMOTIONS: 'false' },
		});
		result['guard while the flag is off'] = await guardResult();
		result.effects = effects();
		expect(result).toMatchSnapshot();
	});

	test('the banners', async () => {
		const result: Record<string, unknown> = {};
		result['changes in both directions'] = await bannerSteps({}, server(), [
			['inner', 'promotion-banner-link'],
			['inner', 'promotion-incoming-banner-link'],
		]);
		result['one change in each direction'] = await bannerSteps(
			{},
			server({ promote: [PROMOTE_CHANGES[1]], apply: [APPLY_CHANGES[0]] }),
		);
		result['no changes'] = await bannerSteps({}, server({ promote: [], apply: [] }));
		result['failing change lists'] = await bannerSteps(
			{},
			server({ promote: 'error', apply: 'error' }),
			[['inner', 'promotion-incoming-banner-link']],
		);
		result['no instance connection'] = await bannerSteps({}, server({ connections: [] }));
		result['no apply configuration'] = await bannerSteps(
			{},
			server({ connections: [connection({ promote: config('promote') })] }),
		);
		result['no promote configuration'] = await bannerSteps(
			{},
			server({ connections: [connection({ apply: config('apply') })] }),
		);
		result['configurations without a checkout'] = await bannerSteps(
			{},
			server({
				connections: [
					connection({
						apply: config('apply', { hasCheckout: false, matchesConfig: false }),
						promote: config('promote', { hasCheckout: true, matchesConfig: false }),
					}),
				],
			}),
		);
		result['a personal project'] = await bannerSteps(
			{},
			server({ project: project('p1', 'Test User <user@example.com>', { type: 'personal' }) }),
		);
		result['a project without the user'] = await bannerSteps(
			{},
			server({ project: project('p1', 'Team', { relations: [] }) }),
		);
		result['a project without git scopes'] = await bannerSteps(
			{},
			server({
				project: project('p1', 'Team', { scopes: sorted(PROJECT_SCOPE_MAP['project:admin']) }),
			}),
		);
		result['a member'] = await bannerSteps({ role: 'global:member' }, server());
		result['an admin'] = await bannerSteps({ role: 'global:admin' }, server());
		for (const role of ['project:editor', 'project:viewer', 'project:chatUser'] as const) {
			result[`the role ${role}`] = await bannerSteps(
				{},
				server({
					project: project('p1', 'Team', {
						scopes: sorted([...PROJECT_SCOPE_MAP[role], ...GIT_SCOPES]),
					}),
				}),
			);
		}
		result['the module is off'] = await bannerSteps({ settings: { activeModules: [] } }, server());
		result['the applied event'] = await bannerSteps({}, server(), []);
		subject.promotionEventBus.emit('applied');
		await settle();
		(result['the applied event'] as unknown[]).push({
			emitted: 'applied',
			...effects(),
			screen: screen(),
		});
		(result['the applied event'] as unknown[]).push(await act(['wait', 5000]));
		subject.promotionEventBus.emit('applied', { projectId: 'p1' });
		await settle();
		(result['the applied event'] as unknown[]).push({
			emitted: 'applied p1',
			...effects(),
			screen: screen(),
		});
		(result['the applied event'] as unknown[]).push(await act(['wait', 5000]));
		subject.promotionEventBus.emit('projectRemoved', { projectId: 'p1' });
		await settle();
		(result['the applied event'] as unknown[]).push({
			emitted: 'projectRemoved',
			...effects(),
			screen: screen(),
		});
		expect(result).toMatchSnapshot();
	});

	test('the selection modal for promote', async () => {
		const result: Record<string, unknown> = {};
		const data = { projectId: 'p1', direction: 'promote' };
		result['the changes'] = await modalSteps(data, {}, server(), [
			['type', 'promotion-search', 'flow 2'],
			['type', 'promotion-search', 'nothing'],
			['type', 'promotion-search', ''],
			'promotion-select-all',
			'promotion-select-all',
			'promotion-refresh',
			['wait', 60_000],
			'Close',
		]);
		result['no changes'] = await modalSteps(data, {}, server({ promote: [] }));
		result['an error and a retry'] = await modalSteps(data, {}, server({ promote: 'error' }), [
			'promotion-retry',
		]);
		result['one change'] = await modalSteps(data, {}, server({ promote: [PROMOTE_CHANGES[0]] }));
		expect(result).toMatchSnapshot();
	});

	test('the selection modal for apply', async () => {
		const result: Record<string, unknown> = {};
		const data = { projectId: 'p1', direction: 'apply', apply: APPLY_SOURCE };
		const confirm = 'css:.el-message-box button#1';
		result['the changes and an apply'] = await modalSteps(data, {}, server(), [
			'promotion-select-all',
			['type', 'promotion-search', 'flow 8'],
			['type', 'promotion-search', ''],
			'Apply all changes',
			confirm,
			['wait', 1000],
		]);
		result['a cancelled apply'] = await modalSteps(data, {}, server(), [
			'Apply all changes',
			'css:.el-message-box button#0',
		]);
		result['workflows that could not be published'] = await modalSteps(
			data,
			{},
			server({ applyResults: [APPLIED_NOT_PUBLISHED] }),
			['Apply all changes', confirm],
		);
		result['a removed project'] = await modalSteps(
			data,
			{},
			server({ applyResults: [APPLIED_PROJECT_REMOVED], projectGoneAfterApply: true }),
			['Apply all changes', confirm, ['wait', 1000]],
		);
		result['a changed source'] = await modalSteps(
			data,
			{},
			server({ applyResults: [SOURCE_CHANGED] }),
			['Apply all changes', confirm, 'promotion-refresh'],
		);
		result['an error'] = await modalSteps(data, {}, server({ applyResults: ['error'] }), [
			'Apply all changes',
			confirm,
		]);
		result['no changes'] = await modalSteps(data, {}, server({ apply: [] }));
		result['an error of the list'] = await modalSteps(data, {}, server({ apply: 'error' }), [
			'promotion-retry',
		]);
		result['without the apply source'] = await modalSteps(
			{ projectId: 'p1', direction: 'apply' },
			{},
			server(),
		);
		result['missing bindings'] = await modalSteps(
			data,
			{},
			server({ applyResults: [BLOCKED], continueResults: [BLOCKED, APPLIED] }),
			['Apply all changes', confirm],
		);
		result['the create buttons'] = await modalSteps(
			data,
			{},
			server({ applyResults: [BLOCKED], continueResults: [BLOCKED, APPLIED] }),
			[
				'Apply all changes',
				confirm,
				'Create Slack account',
				'Create API_URL',
				'Create TEAM_KEY',
				'Back',
				'Apply all changes',
				confirm,
				'Close',
			],
		);
		result['a credential binding'] = await modalSteps(
			data,
			{},
			server({ applyResults: [BLOCKED], continueResults: [BLOCKED, APPLIED] }),
			[
				'Apply all changes',
				confirm,
				'Create Slack account',
				[
					'run',
					'save the credential',
					saveCredential({ name: 'Slack account', type: 'slackApi', data: { accessToken: 'x' } }),
				],
				['run', 'close the credential editor', closeEditor('editCredential')],
			],
		);
		result['all bindings and continue'] = await modalSteps(
			data,
			{},
			server({ applyResults: [BLOCKED], continueResults: [APPLIED] }),
			[
				'Apply all changes',
				confirm,
				'Create API_URL',
				[
					'run',
					'save the variable',
					saveVariable({ key: 'API_URL', value: 'https://api.example.com' }),
				],
				['run', 'close the variable modal', closeEditor('variableModal')],
				'Create TEAM_KEY',
				[
					'run',
					'save the project variable',
					saveVariable({ key: 'TEAM_KEY', value: 'team key', projectId: 'p1' }),
				],
				['run', 'close the project variable modal', closeEditor('variableModal')],
				'Create Slack account',
				[
					'run',
					'save the credential',
					saveCredential({ name: 'Slack account', type: 'slackApi', data: { accessToken: 'x' } }),
				],
				[
					'run',
					'the credentials store',
					async () => {
						const { useCredentialsStore } = await import(
							'@/features/credentials/credentials.store'
						);
						return useCredentialsStore().allCredentials.map((credential) => ({
							id: credential.id,
							name: credential.name,
							type: credential.type,
							homeProject: credential.homeProject?.id,
						}));
					},
				],
				['run', 'close the credential editor', closeEditor('editCredential')],
				'Continue',
			],
		);
		const resolveAll: Step[] = [
			'Create API_URL',
			[
				'run',
				'save the variable',
				saveVariable({ key: 'API_URL', value: 'https://api.example.com' }),
			],
			['run', 'close the variable modal', closeEditor('variableModal')],
			'Create TEAM_KEY',
			[
				'run',
				'save the project variable',
				saveVariable({ key: 'TEAM_KEY', value: 'team key', projectId: 'p1' }),
			],
			['run', 'close the project variable modal', closeEditor('variableModal')],
			'Create Slack account',
			[
				'run',
				'save the credential',
				saveCredential({ name: 'Slack account', type: 'slackApi', data: { accessToken: 'x' } }),
			],
			['run', 'close the credential editor', closeEditor('editCredential')],
		];
		result['back to the list'] = await modalSteps(data, {}, server({ applyResults: [BLOCKED] }), [
			'Apply all changes',
			confirm,
			'Back',
			'Apply all changes',
			confirm,
		]);
		result['close the bindings'] = await modalSteps(data, {}, server({ applyResults: [BLOCKED] }), [
			'Apply all changes',
			confirm,
			'Close',
			'Close',
		]);
		result['the x of the bindings'] = await modalSteps(
			data,
			{},
			server({ applyResults: [BLOCKED] }),
			['Apply all changes', confirm, 'dialog-close-button'],
		);
		result['continue, blocked again'] = await modalSteps(
			data,
			{},
			server({ applyResults: [BLOCKED], continueResults: [BLOCKED_HARD] }),
			['Apply all changes', confirm, ...resolveAll, 'Continue'],
		);
		result['continue with an error'] = await modalSteps(
			data,
			{},
			server({ applyResults: [BLOCKED], continueResults: ['error'] }),
			['Apply all changes', confirm, ...resolveAll, 'Continue'],
		);
		result['continue with a changed source'] = await modalSteps(
			data,
			{},
			server({ applyResults: [BLOCKED], continueResults: [SOURCE_CHANGED] }),
			['Apply all changes', confirm, ...resolveAll, 'Continue'],
		);
		result['a failed credential save'] = await modalSteps(
			data,
			{},
			server({ applyResults: [BLOCKED], failCredential: true }),
			[
				'Apply all changes',
				confirm,
				'Create Slack account',
				[
					'run',
					'save the credential',
					saveCredential({ name: 'Slack account', type: 'slackApi', data: { accessToken: 'x' } }),
				],
				['run', 'close the credential editor', closeEditor('editCredential')],
			],
		);
		result['a closed editor without a save'] = await modalSteps(
			data,
			{},
			server({ applyResults: [BLOCKED] }),
			[
				'Apply all changes',
				confirm,
				'Create API_URL',
				['run', 'close the variable modal', closeEditor('variableModal')],
			],
		);
		result['access, conflicts and warnings'] = await modalSteps(
			data,
			{},
			server({ applyResults: [BLOCKED_HARD] }),
			['Apply all changes', confirm],
		);
		expect(result).toMatchSnapshot();
	});
});
