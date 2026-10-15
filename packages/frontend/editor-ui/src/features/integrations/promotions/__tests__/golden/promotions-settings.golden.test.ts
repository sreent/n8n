// Fork test (not in upstream n8n): the settings page of Git connections (Environments v2) as a
// black box: the providers, the instance connection, its checkouts and the promote of the
// instance. The test runs the page against a fake server, clicks and types into its controls, and
// records what a user sees (text, test ids, controls, icons), the requests, the toasts and the
// open dialogs. It records no markup and no styles. The snapshot was recorded against the
// enterprise files, and the fork files give the same snapshot. See `../../FORK.md`.
import {
	finishPages,
	installRecorders,
	raw,
	record,
	route,
	router,
	ServerError,
	type Scenario,
} from '@/features/ai/evaluation/__tests__/golden/harness';

import { DATE, PROVIDER_SUMMARY, SHA_PROMOTE } from './fixtures';
import { act, effects, load, mountComponent, prepare, screen, type Step } from './recording';
import * as subject from './subject';

// #region Fixtures

const LATER = '2026-02-03T04:05:06.000Z';

const TOKEN_PROVIDER = { ...PROVIDER_SUMMARY, config: { schemaVersion: 1 } };

const SSH_PROVIDER = {
	id: 'prov2',
	name: 'Deploy key',
	type: 'git',
	authType: 'ssh-key',
	config: {
		schemaVersion: 1,
		publicKey: 'ssh-ed25519 AAAAgolden n8n promotions',
		keyType: 'ed25519',
	},
	createdAt: DATE,
	updatedAt: DATE,
};

const checkout = (hasCheckout: boolean, matchesConfig = hasCheckout) => ({
	hasCheckout,
	matchesConfig,
});

const applyConfig = (state = checkout(true), branchName = 'main') => ({
	id: 'cfgA',
	name: 'Apply',
	createdAt: DATE,
	updatedAt: DATE,
	checkout: state,
	settings: { schemaVersion: 1, branchName },
});

const promoteConfig = (state = checkout(false), createBranchOnPromotion = false) => ({
	id: 'cfgP',
	name: 'Promote',
	createdAt: DATE,
	updatedAt: DATE,
	checkout: state,
	settings: { schemaVersion: 1, baseBranchName: 'main', createBranchOnPromotion },
});

const settingsConnection = (
	configs: Record<string, unknown> = { apply: applyConfig(), promote: promoteConfig() },
	provider: Record<string, unknown> = TOKEN_PROVIDER,
) => {
	const { config: _config, ...summary } = provider;
	return {
		id: 'conn1',
		name: 'Deployments',
		scope: 'instance',
		target: { schemaVersion: 1, remoteUrl: 'https://github.com/acme/flows.git' },
		provider: summary,
		configs,
		createdAt: DATE,
		updatedAt: DATE,
	};
};

// #endregion

// #region Server

type Failure = { status: number; message: string; times?: number };

type SettingsOptions = {
	providers?: Array<Record<string, unknown>>;
	/** The instance connection. `null` for none. */
	connection?: Record<string, unknown> | null;
	/** Routes that fail, by name (for example `list providers`). `times` limits the failures. */
	failures?: Record<string, Failure>;
};

const withoutConfig = (provider: Record<string, unknown>) => {
	const { config: _config, ...summary } = provider;
	return summary;
};

/** The configs of a connection as a list gives them: without the checkouts. */
const listed = (connection: Record<string, unknown>) => {
	const configs = (connection.configs ?? {}) as Record<string, Record<string, unknown>>;
	return {
		...connection,
		configs: Object.fromEntries(
			Object.entries(configs).map(([direction, { checkout: _checkout, ...rest }]) => [
				direction,
				rest,
			]),
		),
	};
};

function settingsServer(options: SettingsOptions = {}) {
	return () => {
		const providers = new Map<string, Record<string, unknown>>(
			(options.providers ?? [TOKEN_PROVIDER, SSH_PROVIDER]).map((provider) => [
				String(provider.id),
				structuredClone(provider),
			]),
		);
		let current: Record<string, unknown> | null =
			options.connection === undefined
				? settingsConnection()
				: options.connection && structuredClone(options.connection);
		const failures = new Map(
			Object.entries(options.failures ?? {}).map(([key, failure]) => [key, { ...failure }]),
		);
		const check = (name: string) => {
			const failure = failures.get(name);
			if (!failure) return;
			if (failure.times !== undefined) {
				if (failure.times <= 0) return;
				failure.times -= 1;
			}
			throw new ServerError(failure.status, failure.message);
		};
		const provider = (id: string) => {
			const found = providers.get(id);
			if (!found) throw new ServerError(404, `Provider ${id} not found`);
			return found;
		};
		const connectionOf = (id: string) => {
			if (!current || current.id !== id) throw new ServerError(404, `Connection ${id} not found`);
			return current;
		};
		const configsOf = (connection: Record<string, unknown>) =>
			connection.configs as Record<string, Record<string, unknown> | undefined>;
		let created = 0;

		route('GET', /^\/api\/v1\/promotions\/providers$/, () => {
			check('list providers');
			return raw({ data: [...providers.values()].map(withoutConfig), nextCursor: null });
		});
		route('GET', /^\/api\/v1\/promotions\/providers\/([^/]+)$/, (_request, match) => {
			check('get provider');
			return raw(provider(match[1]));
		});
		route('POST', /^\/api\/v1\/promotions\/providers$/, (request) => {
			check('create provider');
			const body = request.data as { name: string; type: string; auth: Record<string, unknown> };
			created += 1;
			const keyType = String(body.auth.keyType ?? 'ed25519');
			const config =
				body.auth.authType === 'ssh-key'
					? {
							schemaVersion: 1,
							publicKey: `ssh-${keyType} AAAAnew${created} n8n promotions`,
							keyType,
						}
					: { schemaVersion: 1 };
			const saved = {
				id: `provNew${created}`,
				name: body.name,
				type: body.type,
				authType: body.auth.authType,
				config,
				createdAt: LATER,
				updatedAt: LATER,
			};
			providers.set(saved.id, saved);
			return raw({ provider: saved, publicKey: 'publicKey' in config ? config.publicKey : null });
		});
		route('PUT', /^\/api\/v1\/promotions\/providers\/([^/]+)$/, (request, match) => {
			check('update provider');
			const found = provider(match[1]);
			const body = request.data as { name?: string; auth?: Record<string, unknown> };
			if (body.name !== undefined) found.name = body.name;
			if (body.auth?.authType === 'ssh-key') {
				const old = found.config as Record<string, unknown>;
				const keyType = String(body.auth.keyType ?? old.keyType ?? 'ed25519');
				found.config = {
					schemaVersion: 1,
					publicKey: `ssh-${keyType} AAAArotated n8n promotions`,
					keyType,
				};
			}
			found.updatedAt = LATER;
			if (current && (current.provider as { id: string }).id === found.id) {
				current.provider = withoutConfig(found);
			}
			return raw(found);
		});
		route('DELETE', /^\/api\/v1\/promotions\/providers\/([^/]+)$/, (_request, match) => {
			check('delete provider');
			provider(match[1]);
			if (current && (current.provider as { id: string }).id === match[1]) {
				throw new ServerError(409, 'The provider is used by a connection');
			}
			providers.delete(match[1]);
			return raw('');
		});

		route('GET', /^\/api\/v1\/promotions\/connections$/, (request) => {
			const { providerId } = (request.params ?? {}) as { providerId?: string };
			check(providerId === undefined ? 'list connections' : 'list provider connections');
			const matches =
				current &&
				(providerId === undefined || (current.provider as { id: string }).id === providerId);
			return raw({ data: matches && current ? [listed(current)] : [], nextCursor: null });
		});
		route('GET', /^\/api\/v1\/promotions\/connections\/([^/]+)$/, (_request, match) => {
			check('get connection');
			return raw(connectionOf(match[1]));
		});
		route('POST', /^\/api\/v1\/promotions\/connections$/, (request) => {
			check('create connection');
			const body = request.data as {
				name: string;
				scope: string;
				providerId: string;
				target: Record<string, unknown>;
				configs?: Record<string, { name?: string; settings: Record<string, unknown> }>;
			};
			const configs: Record<string, unknown> = {};
			for (const [direction, value] of Object.entries(body.configs ?? {})) {
				configs[direction] = {
					id: direction === 'apply' ? 'cfgNewA' : 'cfgNewP',
					name: value.name ?? (direction === 'apply' ? 'Apply' : 'Promote'),
					createdAt: LATER,
					updatedAt: LATER,
					checkout: checkout(false),
					settings: value.settings,
				};
			}
			current = {
				id: 'connNew',
				name: body.name,
				scope: body.scope,
				target: body.target,
				provider: withoutConfig(provider(body.providerId)),
				configs,
				createdAt: LATER,
				updatedAt: LATER,
			};
			return raw(current);
		});
		route('PUT', /^\/api\/v1\/promotions\/connections\/([^/]+)$/, (request, match) => {
			check('update connection');
			const found = connectionOf(match[1]);
			const body = request.data as {
				name?: string;
				target?: Record<string, unknown>;
				providerId?: string;
			};
			if (body.name !== undefined) found.name = body.name;
			if (body.target !== undefined || body.providerId !== undefined) {
				for (const config of Object.values(configsOf(found))) {
					if (config) {
						const state = config.checkout as { hasCheckout: boolean };
						config.checkout = checkout(state.hasCheckout, false);
					}
				}
			}
			if (body.target !== undefined) found.target = body.target;
			if (body.providerId !== undefined) found.provider = withoutConfig(provider(body.providerId));
			found.updatedAt = LATER;
			return raw(found);
		});
		route('DELETE', /^\/api\/v1\/promotions\/connections\/([^/]+)$/, (_request, match) => {
			check('delete connection');
			connectionOf(match[1]);
			current = null;
			return raw('');
		});
		route(
			'PUT',
			/^\/api\/v1\/promotions\/connections\/([^/]+)\/configs\/(apply|promote)$/,
			(request, match) => {
				check(`save ${match[2]}`);
				const found = connectionOf(match[1]);
				const body = request.data as { name?: string; settings: Record<string, unknown> };
				const configs = configsOf(found);
				const old = configs[match[2]];
				const same = old && JSON.stringify(old.settings) === JSON.stringify(body.settings);
				const saved = {
					id: old?.id ?? (match[2] === 'apply' ? 'cfgNewA' : 'cfgNewP'),
					name: body.name ?? (match[2] === 'apply' ? 'Apply' : 'Promote'),
					createdAt: old?.createdAt ?? LATER,
					updatedAt: LATER,
					checkout: old
						? {
								hasCheckout: (old.checkout as { hasCheckout: boolean }).hasCheckout,
								matchesConfig: same
									? (old.checkout as { matchesConfig: boolean }).matchesConfig
									: false,
							}
						: checkout(false),
					settings: body.settings,
				};
				configs[match[2]] = saved;
				return raw(saved);
			},
		);
		route(
			'DELETE',
			/^\/api\/v1\/promotions\/connections\/([^/]+)\/configs\/(apply|promote)$/,
			(_request, match) => {
				check(`delete ${match[2]}`);
				const configs = configsOf(connectionOf(match[1]));
				delete configs[match[2]];
				return raw('');
			},
		);
		route(
			'POST',
			/^\/api\/v1\/promotions\/connections\/([^/]+)\/(apply|promote)\/(clone|disconnect)$/,
			(_request, match) => {
				check(`${match[3]} ${match[2]}`);
				const config = configsOf(connectionOf(match[1]))[match[2]];
				if (!config) throw new ServerError(404, `No ${match[2]} configuration`);
				const connected = match[3] === 'clone';
				config.checkout = checkout(connected);
				const settings = config.settings as Record<string, unknown>;
				return raw({
					connectionId: match[1],
					configId: config.id,
					direction: match[2],
					branchName: settings.branchName ?? settings.baseBranchName,
					hasCheckout: connected,
				});
			},
		);
		route('GET', /^\/api\/v1\/promotions\/connections\/([^/]+)\/projects$/, () =>
			raw({ projectIds: [] }),
		);
		route('POST', /^\/api\/v1\/promotions\/connections\/([^/]+)\/promote$/, (_request, match) => {
			check('promote');
			const found = connectionOf(match[1]);
			const config = configsOf(found).promote;
			return raw({
				connectionId: found.id,
				configId: config?.id ?? 'cfgP',
				counts: { workflows: 3, folders: 1, credentials: 2, dataTables: 0, variables: 1, tags: 0 },
				git: {
					commitSha: SHA_PROMOTE,
					branchName: (config?.settings as { createBranchOnPromotion?: boolean } | undefined)
						?.createBranchOnPromotion
						? 'n8n/promotion-2026-03-01'
						: 'main',
				},
			});
		});
	};
}

// #endregion

// #region Flows

async function settingsSteps(
	scenario: Scenario,
	serve: () => void,
	actions: Step[] = [],
): Promise<unknown[]> {
	await prepare({ path: '/settings/promotions', ...scenario }, serve);
	const component = await load(subject.PromotionsModule.routes?.[0]?.component);
	await mountComponent(component);
	const result: unknown[] = [{ mounted: true, ...effects(), screen: screen() }];
	for (const action of actions) result.push(await act(action));
	return result;
}

// #endregion

beforeEach(() => {
	installRecorders();
	Object.defineProperty(document, 'execCommand', {
		configurable: true,
		value: (...args: unknown[]) => {
			record('document.execCommand', args[0]);
			return true;
		},
	});
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				record('clipboard.writeText', text);
			},
		},
	});
	vi.useFakeTimers({
		now: new Date('2026-03-01T12:00:00.000Z'),
		toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

afterAll(finishPages);

/** The buttons of a message box: its close button, then its own buttons. */
const box = (position: number) => `css:.el-message-box button#${position}`;

describe('the settings page of Git connections', () => {
	test('the provider dialog', async () => {
		const result: Record<string, unknown> = {};
		const serve = (options: SettingsOptions = {}) => settingsServer(options);
		result['add an SSH key provider'] = await settingsSteps({}, serve(), [
			'promotion-providers-add',
			['type', 'promotion-provider-name-input', 'Deploy bot'],
			'promotion-provider-save-button',
			'copy-input-button',
			'promotion-provider-done-button',
		]);
		result['add an RSA key provider'] = await settingsSteps({}, serve(), [
			'promotion-providers-add',
			'promotion-provider-key-type-select',
			'RSA',
			['type', 'promotion-provider-name-input', 'RSA bot'],
			'promotion-provider-save-button',
		]);
		result['add a token provider'] = await settingsSteps({}, serve(), [
			'promotion-providers-add',
			'promotion-provider-auth-type-select',
			'Username and password',
			['type', 'promotion-provider-name-input', 'Token bot'],
			['type', 'promotion-provider-username-input', 'ada'],
			['type', 'promotion-provider-password-input', 'secret'],
			'promotion-provider-save-button',
		]);
		result['a failed create'] = await settingsSteps(
			{},
			serve({ failures: { 'create provider': { status: 400, message: 'Name already in use' } } }),
			[
				'promotion-providers-add',
				['type', 'promotion-provider-name-input', 'Deploy bot'],
				'promotion-provider-save-button',
			],
		);
		result['cancel'] = await settingsSteps({}, serve(), [
			'promotion-providers-add',
			['type', 'promotion-provider-name-input', 'Deploy bot'],
			'promotion-provider-cancel-button',
		]);
		result['close'] = await settingsSteps({}, serve(), [
			'promotion-provider-row',
			'dialog-close-button',
		]);
		result['edit a token provider'] = await settingsSteps({}, serve(), [
			'promotion-provider-row',
			['type', 'promotion-provider-name-input', 'GitHub bot 2'],
			'promotion-provider-save-button',
			'promotion-provider-row',
			['type', 'promotion-provider-username-input', 'ada'],
			['type', 'promotion-provider-password-input', 'secret'],
			'promotion-provider-save-button',
		]);
		result['rotate an SSH key'] = await settingsSteps({}, serve(), [
			'promotion-provider-row#1',
			'promotion-provider-regenerate-key',
			'promotion-provider-save-button',
		]);
		result['copy the deploy key'] = await settingsSteps({}, serve(), [
			'promotion-provider-row#1',
			'copy-input-button',
		]);
		result['delete a provider'] = await settingsSteps({}, serve(), [
			'promotion-provider-row#1',
			'promotion-provider-delete-button',
			box(1),
			'promotion-provider-delete-button',
			box(0),
			'promotion-provider-delete-button',
			box(2),
		]);
		result['a failed delete'] = await settingsSteps(
			{},
			serve({ failures: { 'delete provider': { status: 500, message: 'Delete failed' } } }),
			['promotion-provider-row#1', 'promotion-provider-delete-button', box(2)],
		);
		result['a provider in use'] = await settingsSteps(
			{},
			serve({ connection: settingsConnection(undefined, SSH_PROVIDER) }),
			['promotion-provider-row#1', ['hover', 'promotion-provider-delete-button']],
		);
		result['a failed load'] = await settingsSteps(
			{},
			serve({ failures: { 'get provider': { status: 500, message: 'Load failed' } } }),
			['promotion-provider-row'],
		);
		result['the tooltips'] = await settingsSteps({}, serve(), [
			'promotion-provider-row',
			['hover', 'css:[data-icon="circle-help"]'],
			['wait', 1000],
			['hover', 'css:.el-dialog .el-tooltip__trigger'],
			['wait', 1000],
		]);
		result['a failed list of the connections of a provider'] = await settingsSteps(
			{},
			serve({ failures: { 'list provider connections': { status: 500, message: 'List failed' } } }),
			['promotion-provider-row'],
		);
		result['names and changes'] = await settingsSteps({}, serve(), [
			'promotion-providers-add',
			['type', 'promotion-provider-name-input', '   '],
			['type', 'promotion-provider-name-input', '  Spaced bot  '],
			'promotion-provider-auth-type-select',
			'Username and password',
			['type', 'promotion-provider-username-input', '  ada  '],
			'promotion-provider-auth-type-select',
			'SSH key',
			'promotion-provider-auth-type-select',
			'Username and password',
			['type', 'promotion-provider-password-input', ' secret '],
			'promotion-provider-save-button',
			'promotion-provider-row',
			['type', 'promotion-provider-name-input', 'Other'],
			['type', 'promotion-provider-name-input', 'GitHub bot'],
			['type', 'promotion-provider-name-input', ' GitHub bot '],
			['type', 'promotion-provider-name-input', ''],
			['type', 'promotion-provider-password-input', 'secret'],
		]);
		result['close the deploy key step'] = await settingsSteps({}, serve(), [
			'promotion-providers-add',
			['type', 'promotion-provider-name-input', 'Deploy bot'],
			'promotion-provider-save-button',
			'dialog-close-button',
			'promotion-providers-add',
		]);
		result['rename the provider of the connection'] = await settingsSteps({}, serve(), [
			'promotion-provider-row',
			['type', 'promotion-provider-name-input', 'GitHub bot 2'],
			'promotion-provider-save-button',
		]);
		expect(result).toMatchSnapshot();
	}, 120_000);

	test('the instance connection', async () => {
		const result: Record<string, unknown> = {};
		const serve = (options: SettingsOptions = {}) => settingsServer(options);
		const fillNew: Step[] = [
			'promotion-connection-provider-select',
			'GitHub bot',
			['type', 'promotion-connection-name-input', 'Deployments'],
			['type', 'promotion-connection-remote-url-input', 'https://github.com/acme/flows.git'],
		];
		result['create a connection'] = await settingsSteps({}, serve({ connection: null }), [
			...fillNew,
			'promotion-connection-apply-toggle',
			['type', 'promotion-connection-apply-branch-input', 'main'],
			'promotion-connection-promote-toggle',
			['type', 'promotion-connection-promote-branch-input', 'release'],
			'promotion-connection-create-branch-toggle',
			'settings-save-bar-save',
			'promotion-checkout-connect',
			'promotion-checkout-connect#1',
		]);
		result['create without directions'] = await settingsSteps({}, serve({ connection: null }), [
			...fillNew,
			'settings-save-bar-save',
		]);
		result['discard a new connection'] = await settingsSteps({}, serve({ connection: null }), [
			...fillNew,
			'settings-save-bar-discard',
		]);
		result['a failed create'] = await settingsSteps(
			{},
			serve({
				connection: null,
				failures: {
					'create connection': {
						status: 409,
						message: 'An instance promotion connection already exists',
					},
				},
			}),
			[...fillNew, 'settings-save-bar-save'],
		);
		result['remote URLs'] = await settingsSteps({}, serve({ connection: null }), [
			'promotion-connection-provider-select',
			'Deploy key',
			['type', 'promotion-connection-name-input', 'Deployments'],
			['type', 'promotion-connection-remote-url-input', 'https://github.com/acme/flows.git'],
			['type', 'promotion-connection-remote-url-input', 'git@github.com:acme/flows.git'],
			['type', 'promotion-connection-remote-url-input', 'ssh://git@github.com/acme/flows.git'],
			'promotion-connection-provider-select',
			'GitHub bot',
			[
				'type',
				'promotion-connection-remote-url-input',
				'https://user:pass@github.com/acme/flows.git',
			],
			['type', 'promotion-connection-remote-url-input', 'not a url'],
			['type', 'promotion-connection-remote-url-input', ''],
			['type', 'promotion-connection-name-input', ''],
		]);
		result['update the connection'] = await settingsSteps({}, serve(), [
			['type', 'promotion-connection-name-input', 'Deployments 2'],
			'settings-save-bar-save',
			['type', 'promotion-connection-apply-branch-input', 'develop'],
			'settings-save-bar-save',
			'promotion-connection-create-branch-toggle',
			'settings-save-bar-save',
			'promotion-connection-provider-select',
			'Deploy key',
			['type', 'promotion-connection-remote-url-input', 'git@github.com:acme/flows.git'],
			'settings-save-bar-save',
		]);
		result['turn off a direction'] = await settingsSteps({}, serve(), [
			'promotion-connection-promote-toggle',
			'settings-save-bar-save',
			'promotion-connection-apply-toggle',
			'settings-save-bar-save',
		]);
		result['discard changes'] = await settingsSteps({}, serve(), [
			['type', 'promotion-connection-name-input', 'Deployments 2'],
			'promotion-connection-apply-toggle',
			'settings-save-bar-discard',
		]);
		result['a failed save'] = await settingsSteps(
			{},
			serve({ failures: { 'save apply': { status: 400, message: 'Invalid branch name' } } }),
			[
				['type', 'promotion-connection-name-input', 'Deployments 2'],
				['type', 'promotion-connection-apply-branch-input', 'develop'],
				'settings-save-bar-save',
			],
		);
		result['add a provider from the form'] = await settingsSteps({}, serve({ connection: null }), [
			'promotion-connection-add-provider',
			['type', 'promotion-provider-name-input', 'Deploy bot'],
			'promotion-provider-save-button',
			'promotion-provider-done-button',
		]);
		result['connect and disconnect'] = await settingsSteps({}, serve(), [
			'promotion-checkout-connect',
			'promotion-checkout-disconnect',
		]);
		result['a failed connect'] = await settingsSteps(
			{},
			serve({
				failures: {
					'clone promote': { status: 400, message: 'Could not read from remote repository' },
				},
			}),
			['promotion-checkout-connect'],
		);
		result['a failed disconnect'] = await settingsSteps(
			{},
			serve({ failures: { 'disconnect apply': { status: 500, message: 'Disconnect failed' } } }),
			['promotion-checkout-disconnect'],
		);
		result['a stale checkout'] = await settingsSteps(
			{},
			serve({
				connection: settingsConnection({
					apply: applyConfig(checkout(true, false)),
					promote: promoteConfig(checkout(true, false), true),
				}),
			}),
			['promotion-checkout-connect'],
		);
		result['only apply'] = await settingsSteps(
			{},
			serve({ connection: settingsConnection({ apply: applyConfig() }) }),
		);
		result['only promote'] = await settingsSteps(
			{},
			serve({ connection: settingsConnection({ promote: promoteConfig(checkout(true)) }) }),
		);
		result['load errors'] = await settingsSteps(
			{},
			serve({
				failures: {
					'list providers': { status: 500, message: 'Providers failed', times: 1 },
					'list connections': { status: 500, message: 'Connections failed', times: 1 },
				},
			}),
			['Retry'],
		);
		result['a failed connection list'] = await settingsSteps(
			{},
			serve({
				failures: { 'list connections': { status: 500, message: 'Connections failed', times: 1 } },
			}),
			['Retry'],
		);
		result['a failed save and a retry'] = await settingsSteps(
			{},
			serve({
				failures: { 'save apply': { status: 400, message: 'Invalid branch name', times: 1 } },
			}),
			[
				['type', 'promotion-connection-name-input', 'Deployments 2'],
				['type', 'promotion-connection-apply-branch-input', 'develop'],
				'settings-save-bar-save',
				'settings-save-bar-save',
			],
		);
		result['turn on a direction'] = await settingsSteps(
			{},
			serve({ connection: settingsConnection({ promote: promoteConfig(checkout(true)) }) }),
			[
				'promotion-connection-apply-toggle',
				['type', 'promotion-connection-apply-branch-input', 'main'],
				'settings-save-bar-save',
			],
		);
		result['save everything at once'] = await settingsSteps({}, serve(), [
			['type', 'promotion-connection-name-input', 'Deployments 2'],
			'promotion-connection-provider-select',
			'Deploy key',
			['type', 'promotion-connection-remote-url-input', 'git@github.com:acme/flows.git'],
			['type', 'promotion-connection-apply-branch-input', 'develop'],
			'promotion-connection-create-branch-toggle',
			'settings-save-bar-save',
		]);
		result['save, then turn off and on'] = await settingsSteps({}, serve(), [
			'promotion-connection-promote-toggle',
			'promotion-connection-promote-toggle',
			['type', 'promotion-connection-name-input', 'Deployments 2'],
			['type', 'promotion-connection-name-input', 'Deployments'],
			['type', 'promotion-connection-apply-branch-input', 'main '],
			'settings-save-bar-save',
		]);
		result['trimmed values'] = await settingsSteps({}, serve({ connection: null }), [
			'promotion-connection-provider-select',
			'GitHub bot',
			['type', 'promotion-connection-name-input', '  Deployments  '],
			['type', 'promotion-connection-remote-url-input', '  https://github.com/acme/flows.git  '],
			'promotion-connection-apply-toggle',
			['type', 'promotion-connection-apply-branch-input', ' main '],
			'promotion-connection-promote-toggle',
			['type', 'promotion-connection-promote-branch-input', '   '],
			['type', 'promotion-connection-promote-branch-input', ' release '],
			'settings-save-bar-save',
		]);
		result['leave with unsaved changes'] = await settingsSteps({}, serve(), [
			['type', 'promotion-connection-name-input', 'Deployments 2'],
			['run', 'leave the page', async () => await router.push('/settings/personal')],
		]);
		result['a target change'] = await settingsSteps(
			{},
			serve({
				connection: settingsConnection({
					apply: applyConfig(),
					promote: promoteConfig(checkout(true)),
				}),
			}),
			[
				['type', 'promotion-connection-remote-url-input', 'https://github.com/acme/other.git'],
				'settings-save-bar-save',
				'promotion-checkout-disconnect',
			],
		);
		result['reload: name and apply branch'] = await settingsSteps({}, serve(), [
			['type', 'promotion-connection-name-input', 'Deployments 2'],
			['type', 'promotion-connection-apply-branch-input', 'develop'],
			'settings-save-bar-save',
		]);
		result['reload: two configurations'] = await settingsSteps({}, serve(), [
			['type', 'promotion-connection-apply-branch-input', 'develop'],
			'promotion-connection-create-branch-toggle',
			'settings-save-bar-save',
		]);
		result['reload: name and a removed direction'] = await settingsSteps({}, serve(), [
			['type', 'promotion-connection-name-input', 'Deployments 2'],
			'promotion-connection-promote-toggle',
			'settings-save-bar-save',
		]);
		result['reload: a removed direction and a branch'] = await settingsSteps({}, serve(), [
			'promotion-connection-promote-toggle',
			['type', 'promotion-connection-apply-branch-input', 'develop'],
			'settings-save-bar-save',
		]);
		result['reload: a retry of one configuration'] = await settingsSteps(
			{},
			serve({
				failures: { 'save apply': { status: 400, message: 'Invalid branch name', times: 1 } },
			}),
			[
				['type', 'promotion-connection-apply-branch-input', 'develop'],
				'settings-save-bar-save',
				'settings-save-bar-save',
			],
		);
		result['reload: a failed connection update'] = await settingsSteps(
			{},
			serve({
				failures: {
					'update connection': {
						status: 400,
						message: 'Remote URL must be a valid HTTP or HTTPS URL',
						times: 1,
					},
				},
			}),
			[
				['type', 'promotion-connection-name-input', 'Deployments 2'],
				['type', 'promotion-connection-apply-branch-input', 'develop'],
				'settings-save-bar-save',
				'settings-save-bar-save',
			],
		);
		result['reload: a new promote configuration'] = await settingsSteps(
			{},
			serve({ connection: settingsConnection({ apply: applyConfig() }) }),
			[
				'promotion-connection-promote-toggle',
				['type', 'promotion-connection-promote-branch-input', 'main'],
				'settings-save-bar-save',
			],
		);
		result['discard after a failed save'] = await settingsSteps(
			{},
			serve({ failures: { 'save apply': { status: 400, message: 'Invalid branch name' } } }),
			[
				['type', 'promotion-connection-name-input', 'Deployments 2'],
				['type', 'promotion-connection-apply-branch-input', 'develop'],
				'settings-save-bar-save',
				'settings-save-bar-discard',
			],
		);
		result['a failed delete of a configuration'] = await settingsSteps(
			{},
			serve({
				failures: { 'delete promote': { status: 500, message: 'Delete failed', times: 1 } },
			}),
			['promotion-connection-promote-toggle', 'settings-save-bar-save', 'settings-save-bar-save'],
		);
		result['two failures'] = await settingsSteps(
			{},
			serve({
				failures: {
					'update connection': { status: 400, message: 'First failure' },
					'save apply': { status: 400, message: 'Second failure' },
				},
			}),
			[
				['type', 'promotion-connection-name-input', 'Deployments 2'],
				['type', 'promotion-connection-apply-branch-input', 'develop'],
				'settings-save-bar-save',
			],
		);
		result['a failure, then an edit'] = await settingsSteps(
			{},
			serve({
				failures: { 'save apply': { status: 400, message: 'Invalid branch name', times: 1 } },
			}),
			[
				['type', 'promotion-connection-apply-branch-input', 'develop'],
				'settings-save-bar-save',
				['type', 'promotion-connection-name-input', 'Deployments 2'],
				'settings-save-bar-save',
			],
		);
		result['promote while the form changes'] = await settingsSteps(
			{},
			serve({
				connection: settingsConnection({
					apply: applyConfig(),
					promote: promoteConfig(checkout(true)),
				}),
			}),
			[['type', 'promotion-connection-name-input', 'Deployments 2']],
		);
		result['the provider options'] = await settingsSteps({}, serve(), [
			'promotion-connection-provider-select',
			[
				'run',
				'the options',
				() =>
					[...document.body.querySelectorAll('.el-select-dropdown__item')]
						.filter((element) => !element.closest('[role="dialog"]'))
						.map((element) => element.textContent?.replace(/\s+/g, ' ').trim()),
			],
		]);
		result['a failed connection detail'] = await settingsSteps(
			{},
			serve({
				failures: { 'get connection': { status: 500, message: 'Detail failed', times: 1 } },
			}),
			['Retry'],
		);
		expect(result).toMatchSnapshot();
	}, 120_000);

	test('the promote of the instance', async () => {
		const result: Record<string, unknown> = {};
		const connected = settingsConnection({
			apply: applyConfig(),
			promote: promoteConfig(checkout(true)),
		});
		const serve = (options: SettingsOptions = {}) =>
			settingsServer({ connection: connected, ...options });
		result['promote'] = await settingsSteps({}, serve(), [
			'promote-instance-button',
			['type', 'promote-commit-message', 'Release 1'],
			'promote-confirm-button',
		]);
		result['cancel'] = await settingsSteps({}, serve(), [
			'promote-instance-button',
			['type', 'promote-commit-message', 'Release 1'],
			'promote-cancel-button',
			'promote-instance-button',
		]);
		result['a failed promote'] = await settingsSteps(
			{},
			serve({
				failures: { promote: { status: 409, message: 'The remote branch has new commits' } },
			}),
			[
				'promote-instance-button',
				['type', 'promote-commit-message', 'Release 1'],
				'promote-confirm-button',
			],
		);
		result['close with the x'] = await settingsSteps({}, serve(), [
			'promote-instance-button',
			['type', 'promote-commit-message', 'Release 1'],
			'dialog-close-button',
			'promote-instance-button',
		]);
		result['a branch on promote'] = await settingsSteps(
			{},
			serve({
				connection: settingsConnection({
					apply: applyConfig(),
					promote: promoteConfig(checkout(true), true),
				}),
			}),
			[
				'promote-instance-button',
				['type', 'promote-commit-message', ' '],
				['type', 'promote-commit-message', 'x'.repeat(1001)],
				['type', 'promote-commit-message', '  Release 2  '],
				'promote-confirm-button',
			],
		);
		expect(result).toMatchSnapshot();
	}, 120_000);
});
