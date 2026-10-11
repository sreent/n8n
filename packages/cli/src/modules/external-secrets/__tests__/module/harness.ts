// Fork test helper (not in upstream n8n): the shared parts of the golden tests of the external
// secrets module. The tests drive the module through its REST API and its services, and record
// what it does: the answers, the events, the commands to other instances, the calls to the
// providers, and the stored settings and connections.
// packages/cli/src/modules/external-secrets/FORK.md tells how the fork made the snapshots.
import { EventService } from '@n8n/backend-services';
import {
	ProjectSecretsProviderAccess,
	RoleRepository,
	SecretsProviderConnection,
	SettingsRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { sleep } from '@n8n/utils/sleep';
import { Cipher, ExternalSecretsProxy } from 'n8n-core';
import type { IDataObject, INodeProperties } from 'n8n-workflow';

import { Publisher } from '@/scaling/pubsub/publisher.service';

import { GoldenRecorder } from '@test-integration/golden-recorder';
import type { SuperAgentTest } from '@test-integration/types';

// The code under test. To record the snapshots against the original files, point these imports
// at the files of `@/modules/external-secrets.ee` (FORK.md lists the paths).
import { ExternalSecretsProviders } from '@/modules/external-secrets/external-secrets-providers';
import { SecretsProvider, type SecretsProviderSettings } from '@/modules/external-secrets/types';

export const recorder = new GoldenRecorder();

/** What a test provider type does. The tests change it between the steps. */
export interface ProviderBehaviour {
	secrets: Record<string, string>;
	/** The result of `test()`. */
	testResult: [boolean] | [boolean, string];
	initError?: string;
	connectError?: string;
	updateError?: string;
	connectDelayMs?: number;
	updateDelayMs?: number;
}

const defaultBehaviour = (): ProviderBehaviour => ({
	secrets: { first: 'one', second: 'two' },
	testResult: [true],
});

export const behaviours = new Map<string, ProviderBehaviour>();

/** One line for each call to a test provider: the step, the instance, the method and the input. */
export const providerLog: unknown[][] = [];

const step = { label: '' };
export const setStep = (label: string) => {
	step.label = label;
};

const instanceCounts = new Map<string, number>();

const PASSWORD_PROPERTIES: INodeProperties[] = [
	{ name: 'username', displayName: 'Username', type: 'string', default: '', required: true },
	{ name: 'other', displayName: 'Other', type: 'string', default: '' },
	{
		name: 'password',
		displayName: 'Password',
		type: 'string',
		default: '',
		typeOptions: { password: true },
	},
];

/** A provider type that logs each call and does what its behaviour says. */
export function providerType(type: string, displayName = `${type} display name`) {
	behaviours.set(type, defaultBehaviour());
	return class extends SecretsProvider {
		name = type;

		displayName = displayName;

		properties = PASSWORD_PROPERTIES;

		private instanceLabel: string | undefined;

		private secrets: Record<string, string> = {};

		/**
		 * The instances of a type are numbered at their first logged call. The module also makes
		 * instances only to read the form fields, and those do not count.
		 */
		private get label() {
			if (this.instanceLabel === undefined) {
				const count = (instanceCounts.get(type) ?? 0) + 1;
				instanceCounts.set(type, count);
				this.instanceLabel = `${type}#${count}`;
			}
			return this.instanceLabel;
		}

		private get behaviour() {
			return behaviours.get(type) ?? defaultBehaviour();
		}

		async init(settings: SecretsProviderSettings) {
			providerLog.push([step.label, this.label, 'init', settings]);
			if (this.behaviour.initError) throw new Error(this.behaviour.initError);
		}

		protected async doConnect() {
			providerLog.push([step.label, this.label, 'connect']);
			if (this.behaviour.connectDelayMs) await sleep(this.behaviour.connectDelayMs);
			if (this.behaviour.connectError) throw new Error(this.behaviour.connectError);
		}

		async disconnect() {
			providerLog.push([step.label, this.label, 'disconnect']);
		}

		async update() {
			providerLog.push([step.label, this.label, 'update']);
			if (this.behaviour.updateDelayMs) await sleep(this.behaviour.updateDelayMs);
			if (this.behaviour.updateError) throw new Error(this.behaviour.updateError);
			this.secrets = { ...this.behaviour.secrets };
		}

		async test(): Promise<[boolean] | [boolean, string]> {
			providerLog.push([step.label, this.label, 'test']);
			return this.behaviour.testResult;
		}

		getSecret(name: string) {
			return this.secrets[name];
		}

		hasSecret(name: string) {
			return name in this.secrets;
		}

		getSecretNames() {
			return Object.keys(this.secrets);
		}
	};
}

/** The provider registry of the tests. */
export class TestProviders extends ExternalSecretsProviders {
	setProviders(providers: Record<string, new () => SecretsProvider>) {
		this.providers = providers;
	}
}

export const testProviders = new TestProviders();

/** The events of the module, and the commands to other instances. */
export const eventLog: unknown[][] = [];

/** The events of the external secrets module (the relay event map). */
const EVENT_NAMES = [
	'external-secrets-provider-settings-saved',
	'external-secrets-provider-reloaded',
	'external-secrets-connection-created',
	'external-secrets-connection-updated',
	'external-secrets-connection-deleted',
	'external-secrets-connection-tested',
	'external-secrets-connection-reloaded',
	'external-secrets-system-roles-toggled',
] as const;

/**
 * Log the events of the module and the commands to other instances. The commands do not reach
 * Redis. This is not a spy of Vitest, because the config of Vitest restores the spies before each
 * test.
 */
export function captureEventsAndCommands() {
	const eventService = Container.get(EventService);
	for (const name of EVENT_NAMES) {
		eventService.on(name, (payload: unknown) =>
			eventLog.push([step.label, 'event', name, payload]),
		);
	}
	Publisher.prototype.publishCommand = async function (command) {
		eventLog.push([step.label, 'command', command]);
	};
}

/**
 * The answer of a request: the JSON body, `<no body>`, or for an HTML error page of Express only
 * the first line of the error (the page has a stack trace in tests).
 */
export function answerOf(response: {
	headers: Record<string, string>;
	text: string;
	body: unknown;
}) {
	if (String(response.headers['content-type'] ?? '').includes('json')) {
		return recorder.normalize(response.body);
	}
	if (response.text === '') return '<no body>';
	const pre = /<pre>([^<]*)/.exec(response.text)?.[1] ?? response.text.slice(0, 120);
	const firstLine = pre
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
	return `<html error page> ${recorder.labelString(firstLine)}`;
}

/** The project roles whose scopes the module can change. */
const PROJECT_ROLES = [
	'project:admin',
	'project:editor',
	'project:viewer',
	'project:personalOwner',
];

/** The scopes of external secrets that each project role has. */
async function roleScopes() {
	const roles: Record<string, string[]> = {};
	for (const slug of PROJECT_ROLES) {
		const role = await Container.get(RoleRepository).findBySlug(slug);
		roles[slug] = (role?.scopes ?? [])
			.map((scope) => scope.slug)
			.filter((scope) => /externalSecret|secretsProvider/.test(scope))
			.sort();
	}
	return roles;
}

/**
 * The stored settings of the module (with their `loadOnStartup` flag), the stored connections
 * with their settings decrypted, the access rows, and the scopes of external secrets of the
 * project roles.
 */
export async function storedState() {
	const cipher = Container.get(Cipher);
	const decrypt = async (value: string) => {
		try {
			return JSON.parse(await cipher.decryptV2(value)) as unknown;
		} catch {
			return `<not decryptable: ${value}>`;
		}
	};
	const settingsRows = await Container.get(SettingsRepository).find({ order: { key: 'ASC' } });
	const settings: IDataObject = {};
	for (const row of settingsRows) {
		if (!row.key.toLowerCase().includes('secret')) continue;
		settings[row.key] = {
			value:
				row.key === 'feature.externalSecrets'
					? ((await decrypt(row.value)) as IDataObject)
					: row.value,
			loadOnStartup: row.loadOnStartup,
		};
	}
	const manager = Container.get(SettingsRepository).manager;
	const connections = await manager.find(SecretsProviderConnection, {
		order: { providerKey: 'ASC' },
		loadEagerRelations: false,
	});
	const access = await manager.find(ProjectSecretsProviderAccess, {
		loadEagerRelations: false,
	});
	const keyOf = new Map(connections.map((connection) => [connection.id, connection.providerKey]));
	return recorder.normalize({
		settings,
		connections: await Promise.all(
			connections.map(async (connection) => ({
				providerKey: connection.providerKey,
				type: connection.type,
				isEnabled: connection.isEnabled,
				settings: await decrypt(connection.encryptedSettings),
			})),
		),
		access: (
			recorder.normalize(
				access.map((row) => ({
					connection: keyOf.get(row.secretsProviderConnectionId) ?? '<unknown>',
					projectId: row.projectId,
					role: row.role,
				})),
			) as unknown[]
		).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		roles: await roleScopes(),
	});
}

/** The numeric IDs of the connections (as text), mapped to their provider keys. */
const connectionKeys = new Map<string, string>();

/** Learn the IDs of the stored connections, so that answers show the key in place of the ID. */
export async function learnConnectionIds() {
	const connections = await Container.get(SettingsRepository).manager.find(
		SecretsProviderConnection,
		{ loadEagerRelations: false },
	);
	for (const connection of connections) {
		connectionKeys.set(String(connection.id), connection.providerKey);
	}
}

/** The text by which a list of projects sorts a project: its name and its ID. */
const projectSortKey = (project: unknown) =>
	project !== null && typeof project === 'object'
		? `${String((project as { name?: unknown }).name)} ${String((project as { id?: unknown }).id)}`
		: String(project);

/**
 * A copy in which each `id` of a known connection is `<id of KEY>`, and each list of `projects` is
 * sorted by name. The order of the projects of a connection comes from the random project IDs.
 */
export function withConnectionLabels(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withConnectionLabels);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => {
				const label =
					key === 'id' && (typeof entry === 'string' || typeof entry === 'number')
						? connectionKeys.get(String(entry))
						: undefined;
				if (label !== undefined) return [key, `<id of ${label}>`];
				if (key === 'projects' && Array.isArray(entry)) {
					const sorted = [...entry].sort((a, b) =>
						projectSortKey(a).localeCompare(projectSortKey(b)),
					);
					return [key, withConnectionLabels(sorted)];
				}
				return [key, withConnectionLabels(entry)];
			}),
		);
	}
	return value;
}

/** What expressions see through the secrets proxy of the core: each provider and its secrets. */
export function proxyView() {
	const proxy = Container.get(ExternalSecretsProxy);
	const view: Record<string, Record<string, unknown>> = {};
	for (const provider of proxy.listProviders()) {
		view[provider] = Object.fromEntries(
			proxy.listSecrets(provider).map((name) => [name, proxy.getSecret(provider, name)]),
		);
	}
	return recorder.normalize(view);
}

export type Method = 'get' | 'post' | 'patch' | 'delete';

/** Wait for the work that a request starts in the background. */
export const settle = async () => await new Promise((resolve) => setTimeout(resolve, 100));

/** One request: the answer, and what the module did. */
export async function request(
	agent: SuperAgentTest,
	label: string,
	method: Method,
	url: string,
	body?: unknown,
) {
	setStep(label);
	const pending = agent[method](url);
	const response = body === undefined ? await pending : await pending.send(body as object);
	await settle();
	await learnConnectionIds();
	const logs = takeLogs();
	return {
		request: recorder.labelString(`${method.toUpperCase()} ${url}`),
		...(body === undefined ? {} : { body: recorder.normalize(body) }),
		status: response.status,
		response: withConnectionLabels(answerOf(response)),
		providers: withConnectionLabels(logs.providers) as unknown[][],
		events: withConnectionLabels(logs.events) as unknown[][],
	};
}

/**
 * The lines of each instance together, in the order of the first line of each instance. The module
 * starts and reloads the providers in parallel, so the order of the lines of different instances
 * is not defined.
 */
export function byInstance(lines: unknown[][]) {
	const groups = new Map<unknown, unknown[][]>();
	for (const line of lines) {
		const group = groups.get(line[1]) ?? [];
		group.push(line);
		groups.set(line[1], group);
	}
	return [...groups.values()].flat();
}

/** The log lines since the last call, normalized. */
export function takeLogs() {
	return {
		providers: recorder.normalize(providerLog.splice(0)) as unknown[][],
		events: recorder.normalize(eventLog.splice(0)) as unknown[][],
	};
}

export function resetLogs() {
	providerLog.length = 0;
	eventLog.length = 0;
	instanceCounts.clear();
	connectionKeys.clear();
}
