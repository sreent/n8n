// Fork test (not in upstream n8n): a golden test of `EvaluationConfigService`, as the ordinary
// adapter of the AI assistant calls it. It records the result or the error of each call, and the
// rows of `evaluation_config`. The snapshot was recorded against the enterprise files, and the fork
// files give the same snapshot. See `packages/cli/src/evaluation/FORK.md`.
import type { UpsertEvaluationConfigDto } from '@n8n/api-types';
import { createTeamProject, createWorkflow, testDb, testModules } from '@n8n/backend-test-utils';
import { LICENSE_QUOTAS } from '@n8n/constants';
import type { User, WorkflowEntity } from '@n8n/db';
import { GLOBAL_MEMBER_ROLE, GLOBAL_OWNER_ROLE, WorkflowRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { INode } from 'n8n-workflow';

import { EvaluationConfigService } from '@/evaluation/evaluation-config.service';
import { DataTableService } from '@/modules/data-table/data-table.service';
import { saveCredential } from '@test-integration/db/credentials';
import { createUserShell } from '@test-integration/db/users';
import { LicenseMocker } from '@test-integration/license';
import { License } from '@/license';
import { LicenseState } from '@n8n/backend-common';

/** A nano ID: 16 letters and digits, with a digit or mixed case, and not a camelCase or PascalCase word. */
const isGeneratedId = (text: string) =>
	!/^[a-z]*([A-Z][a-z]{2,})+$/.test(text) &&
	(/\d/.test(text) || (/[a-z]/.test(text) && /[A-Z]/.test(text)));

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;
const labels = new Map<string, string>();
const label = (id: string, name: string) => {
	labels.set(String(id), name);
	return id;
};

function normalize(value: unknown): unknown {
	if (value instanceof Date) return '<Date>';
	if (typeof value === 'string') {
		const known = labels.get(value);
		if (known) return `@${known}`;
		if (DATE_TEXT.test(value)) return '<date>';
		let text = value;
		for (const [id, name] of labels) text = text.replaceAll(id, `@${name}`);
		return (
			text
				// A 16-character id must not be a part of a longer id: a nano id can hold a hyphen.
				.replace(/(?<![\w-])[A-Za-z0-9]{16}(?![\w-])/g, (match) =>
					isGeneratedId(match) ? '<id>' : match,
				)
				.replace(/(?<![\w-])[\w-]{21}(?![\w-])/g, (match) =>
					/[A-Z]/.test(match) && /[a-z0-9]/.test(match) ? '<nano id>' : match,
				)
		);
	}
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === 'object') {
		const name = value.constructor?.name;
		const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
		const copy = Object.fromEntries(entries.map(([key, inner]) => [key, normalize(inner)]));
		return name && name !== 'Object' ? { '<class>': name, ...copy } : copy;
	}
	return value;
}

/** An error by its class chain, message, status and own fields (for example `code` and `details`). */
function describeError(error: unknown) {
	if (!(error instanceof Error)) return { thrown: normalize(error) };
	const chain: string[] = [];
	let proto: unknown = Object.getPrototypeOf(error);
	while (proto && proto !== Error.prototype) {
		chain.push((proto as { constructor: { name: string } }).constructor.name);
		proto = Object.getPrototypeOf(proto);
	}
	const own = Object.fromEntries(
		// The driver details of a database error (the query, its parameters) are not behaviour of the service.
		Object.entries(error).filter(
			([key]) =>
				![
					'stack',
					'cause',
					'level',
					'tags',
					'extra',
					'query',
					'parameters',
					'driverError',
				].includes(key),
		),
	);
	return normalize({ error: chain.join(' < '), message: error.message, ...own });
}

async function attempt(call: () => Promise<unknown>) {
	try {
		const result = await call();
		return { result: result === undefined ? '<undefined>' : normalize(result) };
	} catch (error) {
		return describeError(error);
	}
}

const license = new LicenseMocker();
let owner: User;
let member: User;
let workflow: WorkflowEntity;
let otherWorkflow: WorkflowEntity;
let tableId: string;
let foreignTableId: string;
let openAiCredentialId: string;
let otherCredentialId: string;

const node = (name: string, type = 'n8n-nodes-base.set'): INode => ({
	id: name,
	name,
	type,
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
});

const expressionMetric = (id = 'm1', name = 'Exact match') => ({
	id,
	name,
	type: 'expression' as const,
	config: { expression: '={{ $json.answer === $json.expected }}', outputType: 'boolean' as const },
});

const dto = (overrides: Partial<UpsertEvaluationConfigDto> = {}): UpsertEvaluationConfigDto =>
	({
		name: 'Config',
		datasetSource: 'data_table',
		datasetRef: { dataTableId: tableId },
		startNodeName: 'Start',
		endNodeName: 'Answer',
		metrics: [expressionMetric()],
		...overrides,
	}) as UpsertEvaluationConfigDto;

async function configRows() {
	return normalize(
		await Container.get(DataSource).query('SELECT * FROM evaluation_config ORDER BY name'),
	);
}

beforeAll(async () => {
	await testModules.loadModules(['data-table']);
	await testDb.init();
	license.mock(Container.get(License));
	license.mockLicenseState(Container.get(LicenseState));
	license.setDefaults({
		features: ['feat:sharing'],
		quotas: { [LICENSE_QUOTAS.WORKFLOWS_WITH_EVALUATION_LIMIT]: -1 },
	});
	license.reset();

	owner = await createUserShell(GLOBAL_OWNER_ROLE);
	member = await createUserShell(GLOBAL_MEMBER_ROLE);
	label(owner.id, 'owner');
	label(member.id, 'member');
	const project = await createTeamProject('Evals', owner);
	const otherProject = await createTeamProject('Other', owner);
	label(project.id, 'project');
	label(otherProject.id, 'other project');

	const nodes = [
		node('Start', 'n8n-nodes-base.manualTrigger'),
		node('Agent'),
		node('Answer'),
		node('Island'),
	];
	workflow = await createWorkflow(
		{
			name: 'evaluated',
			nodes,
			connections: {
				Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
				Agent: { main: [[{ node: 'Answer', type: 'main', index: 0 }]] },
			},
		},
		project,
	);
	label(workflow.id, 'workflow');
	otherWorkflow = await createWorkflow({ name: 'other', nodes, connections: {} }, project);
	label(otherWorkflow.id, 'other workflow');

	const tables = Container.get(DataTableService);
	tableId = label(
		(
			await tables.createDataTable(project.id, {
				name: 'cases',
				columns: [{ name: 'q', type: 'string' }],
			})
		).id,
		'table',
	);
	foreignTableId = label(
		(await tables.createDataTable(otherProject.id, { name: 'foreign', columns: [] })).id,
		'foreign table',
	);
	openAiCredentialId = label(
		(
			await saveCredential(
				{ name: 'OpenAI', type: 'openAiApi', data: { apiKey: 'sk-test' } },
				{ project, role: 'credential:owner' },
			)
		).id,
		'openai credential',
	);
	otherCredentialId = label(
		(
			await saveCredential(
				{ name: 'Slack', type: 'slackApi', data: { accessToken: 'x' } },
				{ project, role: 'credential:owner' },
			)
		).id,
		'slack credential',
	);
});

afterAll(async () => {
	await testDb.terminate();
});

const judgeMetric = (overrides: Record<string, unknown> = {}) => ({
	id: 'judge',
	name: 'Correctness',
	type: 'llm_judge' as const,
	config: {
		preset: 'correctness' as const,
		provider: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
		credentialId: openAiCredentialId,
		model: 'gpt-4o',
		outputType: 'numeric' as const,
		inputs: { actualAnswer: '={{ $json.answer }}', expectedAnswer: '={{ $json.expected }}' },
		...overrides,
	},
});

test('creates, reads, updates and deletes configs, and validates them', async () => {
	const service = Container.get(EvaluationConfigService);
	const fresh = async () =>
		await Container.get(WorkflowRepository).findOneByOrFail({ id: workflow.id });
	const record: Record<string, unknown> = {};
	const create = async (name: string, body: UpsertEvaluationConfigDto, user = owner) =>
		(record[`create: ${name}`] = await attempt(async () => {
			const config = await service.create(workflow.id, await fresh(), user, body);
			label((config as { id: string }).id, `config ${name}`);
			return config;
		}));

	await create('valid', dto());
	await create('the same name again', dto());
	await create('an unknown start node', dto({ name: 'A', startNodeName: 'Missing' }));
	await create('an unknown end node', dto({ name: 'B', endNodeName: 'Missing' }));
	await create(
		'an end node that the start does not reach',
		dto({ name: 'C', endNodeName: 'Island' }),
	);
	await create(
		'two metrics with one id',
		dto({ name: 'D', metrics: [expressionMetric('x', 'One'), expressionMetric('x', 'Two')] }),
	);
	await create(
		'two metrics with one name',
		dto({ name: 'E', metrics: [expressionMetric('x', 'Same'), expressionMetric('y', 'Same')] }),
	);
	await create(
		'an unknown table',
		dto({ name: 'F', datasetRef: { dataTableId: 'missing' } } as never),
	);
	await create(
		'a table of another project',
		dto({ name: 'G', datasetRef: { dataTableId: foreignTableId } } as never),
	);
	await create(
		'a Google Sheet',
		dto({
			name: 'H',
			datasetSource: 'google_sheets',
			datasetRef: { credentialId: 'c', spreadsheetId: 's', sheetName: 'Sheet1' },
		} as never),
	);
	await create('a judge', dto({ name: 'I', metrics: [judgeMetric()] as never }));
	await create(
		'a judge with an unknown credential',
		dto({ name: 'J', metrics: [judgeMetric({ credentialId: 'missing' })] as never }),
	);
	await create(
		'a judge with a credential of another type',
		dto({ name: 'K', metrics: [judgeMetric({ credentialId: otherCredentialId })] as never }),
	);
	await create(
		'a judge with an input of spaces',
		dto({
			name: 'L',
			metrics: [
				judgeMetric({ inputs: { actualAnswer: '   ', expectedAnswer: '={{ 1 }}' } }),
			] as never,
		}),
	);
	await create('a member without access', dto({ name: 'M' }), member);

	const valid = [...labels].find(([, name]) => name === 'config valid')?.[0] ?? 'missing';
	record.list = await attempt(async () => await service.list(workflow.id));
	record['list of another workflow'] = await attempt(
		async () => await service.list(otherWorkflow.id),
	);
	record.get = await attempt(async () => await service.get(workflow.id, valid));
	record['get from another workflow'] = await attempt(
		async () => await service.get(otherWorkflow.id, valid),
	);
	record['get unknown'] = await attempt(async () => await service.get(workflow.id, 'missing'));
	record.update = await attempt(
		async () =>
			await service.update(
				workflow.id,
				valid,
				await fresh(),
				owner,
				dto({ name: 'Renamed', endNodeName: 'Agent' }),
			),
	);
	record['update to an unknown node'] = await attempt(
		async () =>
			await service.update(
				workflow.id,
				valid,
				await fresh(),
				owner,
				dto({ name: 'Renamed', startNodeName: 'Missing' }),
			),
	);
	record['update unknown'] = await attempt(
		async () => await service.update(workflow.id, 'missing', await fresh(), owner, dto()),
	);
	record.rows = await configRows();
	record.delete = await attempt(async () => await service.delete(workflow.id, valid));
	record['delete unknown'] = await attempt(
		async () => await service.delete(workflow.id, 'missing'),
	);
	record['rows after the delete'] = await configRows();
	expect(record).toMatchSnapshot();
});

test('the quota of workflows with evaluations', async () => {
	const service = Container.get(EvaluationConfigService);
	await Container.get(DataSource).query('DELETE FROM evaluation_config');
	const record: Record<string, unknown> = {};
	for (const quota of [0, 1]) {
		license.setQuota(LICENSE_QUOTAS.WORKFLOWS_WITH_EVALUATION_LIMIT, quota);
		record[`quota ${quota}, first workflow`] = await attempt(
			async () => await service.create(workflow.id, workflow, owner, dto({ name: `q${quota}` })),
		);
		record[`quota ${quota}, second workflow`] = await attempt(
			async () =>
				await service.create(
					otherWorkflow.id,
					otherWorkflow,
					owner,
					dto({ name: `q${quota}`, endNodeName: 'Agent' }),
				),
		);
	}
	license.reset();
	expect(record).toMatchSnapshot();
});
