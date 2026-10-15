// Fork test (not in upstream n8n): the context establishment hooks and the Slack resolver of
// dynamic credentials as a black box. The test reads the hooks from the ordinary hook registry,
// runs them directly and through the ordinary execution context service, injects their fields
// into trigger node descriptions with the ordinary node loader, and resolves and stores Slack
// credentials with signed requests. It records the hook descriptions, the context updates, the
// changed trigger items, the stored entries and the errors. The snapshot was recorded against the
// enterprise module, and the fork module gives the same snapshot. See
// `packages/cli/src/modules/dynamic-credentials/README.md`.
import { createHmac } from 'node:crypto';

import { Logger } from '@n8n/backend-common';
import { testDb } from '@n8n/backend-test-utils';
import type { CredentialsEntity, User } from '@n8n/db';
import { WorkflowRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { Cipher, ExecutionContextHookRegistry, ExecutionContextService } from 'n8n-core';
import { OAuth2Api } from 'n8n-nodes-base/credentials/OAuth2Api.credentials';
import { FormTrigger } from 'n8n-nodes-base/nodes/Form/FormTrigger.node';
import { Webhook } from 'n8n-nodes-base/nodes/Webhook/Webhook.node';
import type {
	ICredentialContext,
	ICredentialDataDecryptedObject,
	IExecuteData,
	INode,
	INodeExecutionData,
	INodeParameters,
	INodeTypeDescription,
	INodeTypes,
	PlaintextExecutionContext,
} from 'n8n-workflow';
import { deepCopy, Workflow } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { DynamicCredentialsProxy } from '@/credentials/dynamic-credentials-proxy';
import { LoadNodesAndCredentials } from '@/load-nodes-and-credentials';
import { saveCredential } from '@test-integration/db/credentials';
import { createOwner } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

vi.hoisted(() => {
	process.env.N8N_ENV_FEAT_DYNAMIC_CREDENTIALS = 'true';
});

const testServer = utils.setupTestServer({
	endpointGroups: ['credentials'],
	modules: ['dynamic-credentials'],
	enabledFeatures: ['feat:dynamicCredentials'],
});

const rec = new GoldenRecorder();
let owner: User;
let ownerAgent: SuperAgentTest;

const registry = () => Container.get(ExecutionContextHookRegistry);
const contexts = () => Container.get(ExecutionContextService);

const TRIGGERS = [
	'n8n-nodes-base.webhook',
	'n8n-nodes-base.formTrigger',
	'n8n-nodes-base.manualTrigger',
	'n8n-nodes-base.scheduleTrigger',
	'n8n-nodes-base.slackTrigger',
	'n8n-nodes-base.executeWorkflowTrigger',
	'@n8n/n8n-nodes-langchain.chatTrigger',
	'@n8n/n8n-nodes-langchain.mcpTrigger',
	'n8n-nodes-base.wait',
	'n8n-nodes-base.httpRequest',
	'webhook',
	'',
];

// #region Recording

type LogMock = { mock?: { calls: unknown[][] }; mockClear?: () => void };

function takeLogs() {
	const root = Container.get(Logger) as unknown as Record<string, LogMock> & {
		scoped?: () => Record<string, LogMock>;
	};
	const scoped = typeof root.scoped === 'function' ? root.scoped() : undefined;
	const result: unknown[] = [];
	for (const source of [root, scoped]) {
		if (!source) continue;
		for (const level of ['error', 'warn', 'info', 'debug']) {
			const method = source[level];
			if (!method?.mock) continue;
			for (const call of method.mock.calls) {
				result.push([level, rec.labelString(String(call[0]).split('\n')[0])]);
			}
			method.mockClear?.();
		}
	}
	return result;
}

function causes(error: unknown) {
	const result: string[] = [];
	let current: unknown = error instanceof Error ? error.cause : undefined;
	while (current instanceof Error && result.length < 5) {
		result.push(`${current.constructor.name}: ${rec.labelString(current.message.split('\n')[0])}`);
		current = current.cause;
	}
	return result;
}

async function decrypt(value: unknown) {
	if (typeof value !== 'string') return value;
	try {
		const plain = await Container.get(Cipher).decryptV2(value);
		try {
			return JSON.parse(plain) as unknown;
		} catch {
			return `<text ${plain}>`;
		}
	} catch {
		return `<unreadable ${value.slice(0, 12)}>`;
	}
}

async function entries() {
	const rows = await Container.get(WorkflowRepository).manager.query<
		Array<Record<string, unknown>>
	>('SELECT * FROM dynamic_credential_entry');
	return (
		await Promise.all(
			rows.map(async (row) =>
				JSON.stringify(
					rec.normalize({
						credential: row.credential_id,
						subject: row.subject_id,
						resolver: row.resolver_id,
						data: await decrypt(row.data),
					}),
				),
			),
		)
	).sort();
}

let transcript: unknown[] = [];

async function step(name: string, action: () => Promise<unknown>) {
	const before = await entries();
	takeLogs();
	let outcome: unknown;
	try {
		const value = await action();
		outcome = value === undefined ? 'done' : { value: rec.normalize(value) };
	} catch (error) {
		const cause = causes(error);
		outcome = { threw: rec.describeError(error), ...(cause.length ? { causes: cause } : {}) };
	}
	const after = await entries();
	const entry: Record<string, unknown> = { step: name, outcome };
	const logs = takeLogs();
	if (logs.length) entry.logs = logs;
	const removed = before.filter((line) => !after.includes(line));
	const added = after.filter((line) => !before.includes(line));
	if (removed.length || added.length) entry.entries = { removed, added };
	transcript.push(entry);
}

// #endregion

// #region Fixtures

const webhookNode = (parameters: INodeParameters = {}): INode => ({
	id: 'webhook-node',
	name: 'Webhook',
	type: 'n8n-nodes-base.webhook',
	typeVersion: 2,
	position: [0, 0],
	parameters,
});

const baseContext = (): PlaintextExecutionContext => ({
	version: 1,
	establishedAt: 1_700_000_000_000,
	source: 'webhook',
});

/** Runs one hook by name with trigger items and options. */
async function runHook(
	name: string,
	triggerItems: INodeExecutionData[] | null,
	options: Record<string, unknown> = {},
	context: PlaintextExecutionContext = baseContext(),
) {
	const hook = registry().getHookByName(name);
	if (!hook) throw new Error(`No hook ${name}`);
	const input = triggerItems === null ? null : deepCopy(triggerItems);
	const result = await hook.execute({
		triggerNode: webhookNode(),
		workflow: workflowWith(webhookNode()),
		triggerItems: input,
		context,
		options,
	});
	return { result, inputAfter: input };
}

function workflowWith(node: INode) {
	return new Workflow({
		id: 'workflow-1',
		name: 'Hooks',
		nodes: [node],
		connections: {},
		active: false,
		nodeTypes: mock<INodeTypes>(),
	});
}

/** Runs the hooks of a trigger node through the ordinary execution context service. */
async function establish(node: INode, items: INodeExecutionData[]) {
	const startItem: IExecuteData = {
		node,
		data: { main: [deepCopy(items)] },
		source: null,
	};
	const result = await contexts().augmentExecutionContextWithHooks(
		workflowWith(node),
		startItem,
		await contexts().encryptExecutionContext(baseContext()),
	);
	return {
		context: await contexts().decryptExecutionContext(result.context),
		triggerItems: result.triggerItems,
		startItemData: startItem.data,
	};
}

const SIGNING_SECRET = 'slack-signing-secret';

function slackSignature(timestamp: string, rawBody: string, secret = SIGNING_SECRET) {
	return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
}

/** A Slack request as the Webhook node gives it: the headers, the parsed body and the raw body. */
function slackItem(
	rawBody: string,
	body: Record<string, unknown>,
	options: { timestamp?: number; secret?: string; signature?: string; contentType?: string } = {},
): INodeExecutionData {
	const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
	const signature = options.signature ?? slackSignature(timestamp, rawBody, options.secret);
	rec.label(timestamp, 'timestamp');
	rec.label(signature, 'signature');
	return {
		json: {
			headers: {
				'x-slack-signature': signature,
				'x-slack-request-timestamp': timestamp,
				'content-type': options.contentType ?? 'application/x-www-form-urlencoded',
			},
			params: {},
			query: {},
			body,
		},
		binary: {
			data: {
				data: Buffer.from(rawBody).toString('base64'),
				mimeType: options.contentType ?? 'application/x-www-form-urlencoded',
			},
		},
	};
}

const STATIC_DATA = {
	grantType: 'authorizationCode',
	clientId: 'static-client',
	clientSecret: 'static-secret',
};

async function createResolver(name: string, config: Record<string, unknown>) {
	const response = await ownerAgent
		.post('/credential-resolvers')
		.send({ name, type: 'credential-resolver.slack-1.0', config });
	const id = (response.body as { data?: { id?: string } }).data?.id;
	if (!id)
		throw new Error(`Could not create the resolver ${name}: ${JSON.stringify(response.body)}`);
	rec.label(id, `resolver ${name}`);
	return id;
}

async function credential(name: string, resolverId: string) {
	const saved: CredentialsEntity = await saveCredential(
		{ name, type: 'oAuth2Api', data: STATIC_DATA, isResolvable: true, resolverId } as never,
		{ user: owner, role: 'credential:owner' },
	);
	rec.label(saved.id, `credential ${name}`);
	return saved;
}

async function slackContext(item: INodeExecutionData): Promise<ICredentialContext> {
	const { result } = await runHook('SlackSignatureExtractor', [item]);
	const credentials = result.contextUpdate?.credentials;
	if (!credentials) throw new Error('The Slack hook gave no credentials');
	return credentials;
}

const meta = (c: CredentialsEntity) => ({
	id: c.id,
	name: c.name,
	type: c.type,
	isResolvable: c.isResolvable,
	resolverId: c.resolverId ?? undefined,
});

async function resolveWith(c: CredentialsEntity, credentials: ICredentialContext) {
	return await Container.get(DynamicCredentialsProxy).resolveIfNeeded(
		meta(c),
		{ ...STATIC_DATA },
		await contexts().encryptExecutionContext({ ...baseContext(), credentials }),
	);
}

async function storeWith(
	c: CredentialsEntity,
	credentials: ICredentialContext,
	data: ICredentialDataDecryptedObject,
) {
	return await Container.get(DynamicCredentialsProxy).storeIfNeeded(meta(c), data, credentials, {
		...STATIC_DATA,
	});
}

// #endregion

beforeAll(async () => {
	await registry().init();
	Container.get(LoadNodesAndCredentials).loaded.credentials.oAuth2Api = {
		type: new OAuth2Api(),
		sourcePath: '',
	};
	owner = await createOwner();
	ownerAgent = testServer.authAgentFor(owner);
	rec.label(owner.id, 'owner');
});

beforeEach(async () => {
	transcript = [];
	await Container.get(WorkflowRepository).manager.query(
		"DELETE FROM dynamic_credential_resolver WHERE id != 'system-n8n'",
	);
	for (const entity of [
		'DynamicCredentialEntry',
		'SharedCredentials',
		'CredentialsEntity',
	] as const) {
		await testDb.truncate([entity]);
	}
});

describe('context establishment hooks', () => {
	test('the hooks and the trigger nodes', async () => {
		await step('the hooks of the registry', async () =>
			registry()
				.getAllHooks()
				.map((hook) => ({
					class: hook.constructor.name,
					description: hook.hookDescription,
					applicable: TRIGGERS.filter((type) => hook.isApplicableToTriggerNode(type)),
				})),
		);
		await step('the global and sub-execution hooks', async () => ({
			global: registry()
				.getGlobalHooks()
				.map((hook) => hook.hookDescription.name),
			subExecution: registry()
				.getSubExecutionHooks()
				.map((hook) => hook.hookDescription.name),
		}));
		await step('the hook fields of the trigger node descriptions', async () => {
			const loader = Container.get(LoadNodesAndCredentials);
			const webhook = deepCopy(new Webhook().description) as INodeTypeDescription;
			const form = deepCopy(
				new FormTrigger().nodeVersions[2.5].description,
			) as INodeTypeDescription;
			webhook.name = 'n8n-nodes-base.webhook';
			form.name = 'n8n-nodes-base.formTrigger';
			const before = { webhook: webhook.properties.length, form: form.properties.length };
			loader.types.nodes = [webhook, form];
			(
				loader as unknown as { injectContextEstablishmentHooks(): void }
			).injectContextEstablishmentHooks();
			(
				loader as unknown as { injectContextEstablishmentHooks(): void }
			).injectContextEstablishmentHooks();
			return {
				webhook: webhook.properties.slice(before.webhook),
				form: form.properties.slice(before.form),
			};
		});
		expect(transcript).toMatchSnapshot();
	});

	test('the bearer token and HTTP header hooks', async () => {
		const items = (headers: Record<string, unknown>, extra: Record<string, unknown> = {}) => [
			{ json: { headers, params: {}, query: {}, body: {}, ...extra } },
		];
		await step(
			'bearer: a bearer token',
			async () =>
				await runHook(
					'BearerTokenExtractor',
					items({ authorization: 'Bearer token-1', 'x-other': 'kept' }),
				),
		);
		await step(
			'bearer: a lower case scheme',
			async () => await runHook('BearerTokenExtractor', items({ authorization: 'bearer token-2' })),
		);
		await step(
			'bearer: extra spaces',
			async () =>
				await runHook('BearerTokenExtractor', items({ authorization: 'Bearer    token-3  ' })),
		);
		await step(
			'bearer: a basic scheme',
			async () =>
				await runHook('BearerTokenExtractor', items({ authorization: 'Basic dXNlcjpwYXNz' })),
		);
		await step(
			'bearer: no authorization header',
			async () => await runHook('BearerTokenExtractor', items({ 'x-other': 'value' })),
		);
		await step(
			'bearer: an upper case header name',
			async () => await runHook('BearerTokenExtractor', items({ Authorization: 'Bearer token-4' })),
		);
		await step(
			'bearer: no headers',
			async () => await runHook('BearerTokenExtractor', [{ json: { body: {} } }]),
		);
		await step('bearer: no trigger items', async () => await runHook('BearerTokenExtractor', null));
		await step('bearer: an empty item list', async () => await runHook('BearerTokenExtractor', []));
		await step(
			'bearer: two items',
			async () =>
				await runHook('BearerTokenExtractor', [
					...items({ authorization: 'Bearer first' }),
					...items({ authorization: 'Bearer second' }),
				]),
		);
		await step(
			'bearer: an array header',
			async () =>
				await runHook(
					'BearerTokenExtractor',
					items({ authorization: ['Bearer token-5', 'Bearer token-6'] }),
				),
		);
		await step(
			'bearer: an existing credential context',
			async () =>
				await runHook(
					'BearerTokenExtractor',
					items({ authorization: 'Bearer token-7' }),
					{},
					{
						...baseContext(),
						credentials: { version: 1, identity: 'old', metadata: { source: 'manual-execution' } },
					},
				),
		);
		await step(
			'header: the default options',
			async () => await runHook('HttpHeaderExtractor', items({ authorization: 'Bearer header-1' })),
		);
		await step(
			'header: a custom header and pattern',
			async () =>
				await runHook('HttpHeaderExtractor', items({ 'x-api-key': 'key-123' }), {
					headerName: 'X-Api-Key',
					headerValue: '(.+)',
				}),
		);
		await step(
			'header: a pattern without a group',
			async () =>
				await runHook('HttpHeaderExtractor', items({ 'x-api-key': 'key-123' }), {
					headerName: 'x-api-key',
					headerValue: 'key-\\d+',
				}),
		);
		await step(
			'header: a value that does not match',
			async () =>
				await runHook('HttpHeaderExtractor', items({ 'x-api-key': 'other' }), {
					headerName: 'x-api-key',
					headerValue: 'key-(\\d+)',
				}),
		);
		await step(
			'header: a missing header',
			async () =>
				await runHook('HttpHeaderExtractor', items({}), {
					headerName: 'x-api-key',
					headerValue: '(.+)',
				}),
		);
		await step(
			'header: an invalid pattern',
			async () =>
				await runHook('HttpHeaderExtractor', items({ 'x-api-key': 'key' }), {
					headerName: 'x-api-key',
					headerValue: '([',
				}),
		);
		await step(
			'header: two groups',
			async () =>
				await runHook('HttpHeaderExtractor', items({ 'x-api-key': 'a:b' }), {
					headerName: 'x-api-key',
					headerValue: '(\\w):(\\w)',
				}),
		);
		await step(
			'header: an empty header name',
			async () =>
				await runHook('HttpHeaderExtractor', items({ authorization: 'Bearer x' }), {
					headerName: '',
				}),
		);
		await step(
			'service: the bearer hook on a webhook node',
			async () =>
				await establish(
					webhookNode({
						executionsHooksVersion: 1,
						contextEstablishmentHooks: {
							hooks: [{ hookName: 'BearerTokenExtractor', isAllowedToFail: false }],
						},
					}),
					items({ authorization: 'Bearer pipeline-1' }),
				),
		);
		await step(
			'service: the bearer hook without the version',
			async () =>
				await establish(
					webhookNode({
						contextEstablishmentHooks: { hooks: [{ hookName: 'BearerTokenExtractor' }] },
					}),
					items({ authorization: 'Bearer pipeline-2' }),
				),
		);
		await step(
			'service: a failing hook that may fail',
			async () =>
				await establish(
					webhookNode({
						contextEstablishmentHooks: {
							hooks: [{ hookName: 'BearerTokenExtractor', isAllowedToFail: true }],
						},
					}),
					items({}),
				),
		);
		await step(
			'service: a failing hook that may not fail',
			async () =>
				await establish(
					webhookNode({
						contextEstablishmentHooks: {
							hooks: [{ hookName: 'BearerTokenExtractor', isAllowedToFail: false }],
						},
					}),
					items({}),
				),
		);
		await step(
			'service: the header hook with options',
			async () =>
				await establish(
					webhookNode({
						contextEstablishmentHooks: {
							hooks: [
								{ hookName: 'HttpHeaderExtractor', headerName: 'x-user', headerValue: '(.+)' },
							],
						},
					}),
					items({ 'x-user': 'alice' }),
				),
		);
		await step(
			'service: two hooks',
			async () =>
				await establish(
					webhookNode({
						contextEstablishmentHooks: {
							hooks: [
								{ hookName: 'HttpHeaderExtractor', headerName: 'x-user', headerValue: '(.+)' },
								{ hookName: 'BearerTokenExtractor' },
							],
						},
					}),
					items({ 'x-user': 'alice', authorization: 'Bearer bob' }),
				),
		);
		await step(
			'service: an unknown hook',
			async () =>
				await establish(
					webhookNode({ contextEstablishmentHooks: { hooks: [{ hookName: 'NoSuchHook' }] } }),
					items({ authorization: 'Bearer x' }),
				),
		);
		expect(transcript).toMatchSnapshot();
	});

	test('the Slack hook and the Slack resolver', async () => {
		const command = 'token=old&team_id=T1&user_id=U1&command=%2Fweather&text=today';
		const commandBody = {
			token: 'old',
			team_id: 'T1',
			user_id: 'U1',
			command: '/weather',
			text: 'today',
		};
		const interactive = `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', user: { id: 'U2', team_id: 'T2' }, team: { id: 'T2' } }))}`;
		const interactiveBody = {
			payload: JSON.stringify({
				type: 'block_actions',
				user: { id: 'U2', team_id: 'T2' },
				team: { id: 'T2' },
			}),
		};
		const event = JSON.stringify({
			type: 'event_callback',
			team_id: 'T3',
			event: { type: 'message', user: 'U3' },
		});
		const eventBody = JSON.parse(event) as Record<string, unknown>;

		await step(
			'slack hook: a slash command',
			async () => await runHook('SlackSignatureExtractor', [slackItem(command, commandBody)]),
		);
		await step(
			'slack hook: an interactive payload',
			async () =>
				await runHook('SlackSignatureExtractor', [slackItem(interactive, interactiveBody)]),
		);
		await step(
			'slack hook: an event',
			async () =>
				await runHook('SlackSignatureExtractor', [
					slackItem(event, eventBody, { contentType: 'application/json' }),
				]),
		);
		await step(
			'slack hook: without the signature headers',
			async () =>
				await runHook('SlackSignatureExtractor', [{ json: { headers: {}, body: commandBody } }]),
		);
		await step('slack hook: without the raw body', async () => {
			const item = slackItem(command, commandBody);
			delete item.binary;
			return await runHook('SlackSignatureExtractor', [item]);
		});
		await step(
			'slack hook: no trigger items',
			async () => await runHook('SlackSignatureExtractor', null),
		);
		const jsonItem = (extra: Record<string, unknown>, binary?: INodeExecutionData['binary']) => {
			const timestamp = String(Math.floor(Date.now() / 1000));
			rec.label(timestamp, 'timestamp');
			const signature = slackSignature(timestamp, event);
			rec.label(signature, 'signature');
			return {
				json: {
					headers: {
						'x-slack-signature': signature,
						'x-slack-request-timestamp': timestamp,
						'content-type': 'application/json',
					},
					params: {},
					query: {},
					body: eventBody,
					...extra,
				},
				...(binary ? { binary } : {}),
			} as INodeExecutionData;
		};
		await step(
			'slack hook: an event with a raw body field',
			async () => await runHook('SlackSignatureExtractor', [jsonItem({ rawBody: event })]),
		);
		await step(
			'slack hook: an event with a raw body buffer',
			async () =>
				await runHook('SlackSignatureExtractor', [jsonItem({ rawBody: Buffer.from(event) })]),
		);
		await step(
			'slack hook: an event with the body as text',
			async () => await runHook('SlackSignatureExtractor', [jsonItem({ body: event })]),
		);
		await step(
			'slack hook: an event with binary data and a file name',
			async () =>
				await runHook('SlackSignatureExtractor', [
					jsonItem(
						{},
						{
							data: {
								data: Buffer.from(event).toString('base64'),
								mimeType: 'application/json',
								fileName: 'body.json',
							},
						},
					),
				]),
		);
		await step('slack hook: a form with a header in another case', async () => {
			const item = slackItem(command, commandBody);
			const headers = item.json.headers as Record<string, string>;
			item.json.headers = {
				'X-Slack-Signature': headers['x-slack-signature'],
				'X-Slack-Request-Timestamp': headers['x-slack-request-timestamp'],
				'content-type': headers['content-type'],
			};
			return await runHook('SlackSignatureExtractor', [item]);
		});
		await step('slack hook: a form without a content type', async () => {
			const item = slackItem(command, commandBody);
			delete (item.json.headers as Record<string, string>)['content-type'];
			return await runHook('SlackSignatureExtractor', [item]);
		});

		const userResolver = await createResolver('Slack users', {
			signingSecret: SIGNING_SECRET,
			subjectClaim: 'user_id',
		});
		const teamResolver = await createResolver('Slack teams', {
			signingSecret: SIGNING_SECRET,
			subjectClaim: 'team_user',
		});
		const byUser = await credential('By user', userResolver);
		const byTeam = await credential('By team', teamResolver);

		await step(
			'slack: resolve a slash command before the store',
			async () => await resolveWith(byUser, await slackContext(slackItem(command, commandBody))),
		);
		await step(
			'slack: store for a slash command',
			async () =>
				await storeWith(byUser, await slackContext(slackItem(command, commandBody)), {
					oauthTokenData: { access_token: 'u1-token' },
				}),
		);
		await step(
			'slack: resolve a slash command after the store',
			async () => await resolveWith(byUser, await slackContext(slackItem(command, commandBody))),
		);
		await step(
			'slack: store with team and user',
			async () =>
				await storeWith(byTeam, await slackContext(slackItem(command, commandBody)), {
					oauthTokenData: { access_token: 't1-u1-token' },
				}),
		);
		await step(
			'slack: resolve an interactive payload',
			async () =>
				await resolveWith(byTeam, await slackContext(slackItem(interactive, interactiveBody))),
		);
		await step(
			'slack: store for an interactive payload',
			async () =>
				await storeWith(byTeam, await slackContext(slackItem(interactive, interactiveBody)), {
					oauthTokenData: { access_token: 't2-u2-token' },
				}),
		);
		const interactiveFlat = `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', user: { id: 'U4' }, team: { id: 'T4' } }))}`;
		const interactiveFlatBody = {
			payload: JSON.stringify({ type: 'block_actions', user: { id: 'U4' }, team: { id: 'T4' } }),
		};
		await step(
			'slack: store for an interactive payload with user and team ids',
			async () =>
				await storeWith(
					byTeam,
					await slackContext(slackItem(interactiveFlat, interactiveFlatBody)),
					{
						oauthTokenData: { access_token: 't4-u4-token' },
					},
				),
		);
		const interactiveTop = `payload=${encodeURIComponent(JSON.stringify({ user_id: 'U5', team_id: 'T5' }))}`;
		const interactiveTopBody = { payload: JSON.stringify({ user_id: 'U5', team_id: 'T5' }) };
		await step(
			'slack: store for a payload with top-level ids',
			async () =>
				await storeWith(byTeam, await slackContext(slackItem(interactiveTop, interactiveTopBody)), {
					oauthTokenData: { access_token: 't5-u5-token' },
				}),
		);
		await step(
			'slack: store for a user without a team',
			async () =>
				await storeWith(
					byTeam,
					await slackContext(slackItem('user_id=U6&text=hi', { user_id: 'U6', text: 'hi' })),
					{ oauthTokenData: { access_token: 'u6-token' } },
				),
		);
		await step(
			'slack: store for an event',
			async () =>
				await storeWith(
					byTeam,
					await slackContext(slackItem(event, eventBody, { contentType: 'application/json' })),
					{
						oauthTokenData: { access_token: 't3-u3-token' },
					},
				),
		);
		await step(
			'slack: resolve with a wrong signature',
			async () =>
				await resolveWith(
					byUser,
					await slackContext(slackItem(command, commandBody, { secret: 'other-secret' })),
				),
		);
		await step(
			'slack: resolve with an old timestamp',
			async () =>
				await resolveWith(
					byUser,
					await slackContext(
						slackItem(command, commandBody, { timestamp: Math.floor(Date.now() / 1000) - 600 }),
					),
				),
		);
		await step('slack: resolve with a changed body', async () => {
			const item = slackItem(command, commandBody);
			item.binary!.data.data = Buffer.from(command.replace('U1', 'U9')).toString('base64');
			return await resolveWith(byUser, await slackContext(item));
		});
		await step(
			'slack: resolve with a malformed signature',
			async () =>
				await resolveWith(
					byUser,
					await slackContext(slackItem(command, commandBody, { signature: 'v1=abc' })),
				),
		);
		await step(
			'slack: resolve a body without a user',
			async () =>
				await resolveWith(
					byUser,
					await slackContext(slackItem('team_id=T1&text=hi', { team_id: 'T1', text: 'hi' })),
				),
		);
		await step('slack: store for an event with a raw body field', async () => {
			const timestamp = String(Math.floor(Date.now() / 1000));
			rec.label(timestamp, 'timestamp');
			const signature = slackSignature(timestamp, event);
			rec.label(signature, 'signature');
			const item = {
				json: {
					headers: {
						'x-slack-signature': signature,
						'x-slack-request-timestamp': timestamp,
						'content-type': 'application/json',
					},
					body: eventBody,
					rawBody: event,
				},
			} as INodeExecutionData;
			return await storeWith(byTeam, await slackContext(item), {
				oauthTokenData: { access_token: 't3-u3-token' },
			});
		});
		const signedContext = (identity: string): ICredentialContext => {
			const timestamp = String(Math.floor(Date.now() / 1000));
			rec.label(timestamp, 'timestamp');
			const signature = slackSignature(timestamp, identity);
			rec.label(signature, 'signature');
			return {
				version: 1,
				identity,
				metadata: { source: 'slack-signature', timestamp, signature },
			};
		};
		const identities: Array<[string, string]> = [
			['an event as JSON', event],
			[
				'an interactive payload as JSON',
				JSON.stringify({
					type: 'block_actions',
					user: { id: 'U2', team_id: 'T2' },
					team: { id: 'T2' },
				}),
			],
			['top-level ids as JSON', JSON.stringify({ user_id: 'U5', team_id: 'T5' })],
			['an interactive payload as a form', interactive],
			[
				'a view submission as a form',
				`payload=${encodeURIComponent(JSON.stringify({ type: 'view_submission', user: { id: 'U7', team_id: 'T7' } }))}`,
			],
			[
				'a shortcut as a form',
				`payload=${encodeURIComponent(JSON.stringify({ type: 'shortcut', user: { id: 'U8' }, team: { id: 'T8' } }))}`,
			],
			[
				'an event without a user',
				JSON.stringify({ type: 'event_callback', team_id: 'T3', event: { type: 'message' } }),
			],
			['an url verification', JSON.stringify({ type: 'url_verification', challenge: 'c' })],
			['not JSON and not a form', '{not json'],
		];
		for (const [label, identity] of identities) {
			await step(
				`slack: resolve ${label} by user`,
				async () => await resolveWith(byUser, signedContext(identity)),
			);
			await step(
				`slack: resolve ${label} by team and user`,
				async () => await resolveWith(byTeam, signedContext(identity)),
			);
		}
		await step(
			'slack: resolve a context without a timestamp',
			async () =>
				await resolveWith(byUser, {
					version: 1,
					identity: command,
					metadata: { source: 'slack-signature', signature: 'v0=x' },
				}),
		);
		await step('slack: resolve a context with a future timestamp', async () => {
			const timestamp = String(Math.floor(Date.now() / 1000) + 600);
			rec.label(timestamp, 'future timestamp');
			const signature = slackSignature(timestamp, command);
			rec.label(signature, 'future signature');
			return await resolveWith(byUser, {
				version: 1,
				identity: command,
				metadata: { source: 'slack-signature', timestamp, signature },
			});
		});
		await step(
			'slack: resolve a context with a timestamp that is not a number',
			async () =>
				await resolveWith(byUser, {
					version: 1,
					identity: command,
					metadata: {
						source: 'slack-signature',
						timestamp: 'abc',
						signature: slackSignature('abc', command),
					},
				}),
		);
		await step(
			'slack: resolve a bearer context',
			async () =>
				await resolveWith(byUser, {
					version: 1,
					identity: 'Bearer x',
					metadata: { source: 'bearer-token' },
				}),
		);
		await step(
			'slack: the pipeline with the Slack hook',
			async () =>
				await establish(
					webhookNode({
						contextEstablishmentHooks: { hooks: [{ hookName: 'SlackSignatureExtractor' }] },
					}),
					[slackItem(command, commandBody)],
				),
		);
		// The store gets the context of an earlier request, for example after an OAuth flow.
		await step(
			'slack: store with a wrong signature',
			async () =>
				await storeWith(
					byUser,
					await slackContext(slackItem(command, commandBody, { secret: 'other-secret' })),
					{ oauthTokenData: { access_token: 'wrong-signature-token' } },
				),
		);
		await step(
			'slack: store with an old timestamp',
			async () =>
				await storeWith(
					byUser,
					await slackContext(
						slackItem(command, commandBody, { timestamp: Math.floor(Date.now() / 1000) - 600 }),
					),
					{ oauthTokenData: { access_token: 'old-timestamp-token' } },
				),
		);
		await step(
			'slack: store with the signature of another body',
			async () =>
				await storeWith(
					byUser,
					{ ...signedContext(command), identity: 'user_id=U9&team_id=T9' },
					{ oauthTokenData: { access_token: 'other-body-token' } },
				),
		);
		await step(
			'slack: store a context without a timestamp',
			async () =>
				await storeWith(
					byTeam,
					{
						version: 1,
						identity: 'user_id=U10&team_id=T10',
						metadata: { source: 'slack-signature', signature: 'v0=x' },
					},
					{ oauthTokenData: { access_token: 'no-timestamp-token' } },
				),
		);
		await step(
			'slack: store a bearer context',
			async () =>
				await storeWith(
					byUser,
					{ version: 1, identity: 'Bearer x', metadata: { source: 'bearer-token' } },
					{ oauthTokenData: { access_token: 'bearer-token' } },
				),
		);
		expect(transcript).toMatchSnapshot();
	});
});
