import { createWorkflow, testDb } from '@n8n/backend-test-utils';
import type { User } from '@n8n/db';
import { Container } from '@n8n/di';

import { ExecutionService } from '@/executions/execution.service';

import { annotateExecution, createExecution } from './shared/db/executions';
import { createMember, createOwner } from './shared/db/users';
import type { SuperAgentTest } from './shared/types';
import * as utils from './shared/utils/';

/**
 * Fork test (not in upstream n8n): the REST API of the annotation tags, and the tags of an
 * annotated execution. The snapshots record the behaviour of the original code as a black box.
 * See `packages/cli/src/executions/FORK.md`.
 */
const testServer = utils.setupTestServer({ endpointGroups: ['annotationTags'] });

const FEATURE = 'feat:advancedExecutionFilters';

let owner: User;
let member: User;
let ownerAgent: SuperAgentTest;
let memberAgent: SuperAgentTest;

/** Replaces the generated ids and the timestamps, so that a snapshot is stable. */
function normalize(body: unknown, ids: Map<string, string> = new Map()): unknown {
	if (Array.isArray(body)) return body.map((item) => normalize(item, ids));
	if (body instanceof Date) return '<date>';
	if (body === null || typeof body !== 'object') return body;

	return Object.fromEntries(
		Object.entries(body).map(([key, value]) => {
			if (key === 'id' && typeof value === 'string') {
				if (!ids.has(value)) ids.set(value, `<id ${ids.size + 1} (${value.length} chars)>`);
				return [key, ids.get(value)];
			}
			if (key === 'id' && typeof value === 'number') return [key, '<number>'];
			// The order of the tags of an execution depends on their random ids.
			if (key === 'tags' && Array.isArray(value)) {
				return [key, normalize(sortByName(value), ids)];
			}
			if ((key === 'createdAt' || key === 'updatedAt') && typeof value === 'string') {
				return [key, Number.isNaN(Date.parse(value)) ? `<invalid date ${value}>` : '<date>'];
			}
			return [key, normalize(value, ids)];
		}),
	);
}

function sortByName(items: unknown[]): unknown[] {
	const name = (item: unknown) =>
		item !== null && typeof item === 'object' && 'name' in item ? String(item.name) : '';
	return [...items].sort((a, b) => name(a).localeCompare(name(b)));
}

function record(response: { status: number; body: unknown }, ids?: Map<string, string>) {
	return { status: response.status, body: normalize(response.body, ids) };
}

beforeAll(async () => {
	owner = await createOwner();
	member = await createMember();
	ownerAgent = testServer.authAgentFor(owner);
	memberAgent = testServer.authAgentFor(member);
});

beforeEach(async () => {
	testServer.license.reset();
	await testDb.truncate(['AnnotationTagEntity', 'ExecutionAnnotation', 'ExecutionEntity']);
});

describe('without the licence feature', () => {
	test('answers each route', async () => {
		const responses = {
			list: record(await ownerAgent.get('/annotation-tags')),
			create: record(await ownerAgent.post('/annotation-tags').send({ name: 'Good' })),
			update: record(await ownerAgent.patch('/annotation-tags/unknown').send({ name: 'Bad' })),
			delete: record(await ownerAgent.delete('/annotation-tags/unknown')),
		};

		expect(responses).toMatchSnapshot();
	});
});

describe('with the licence feature', () => {
	beforeEach(() => {
		testServer.license.enable(FEATURE);
	});

	test('creates, lists, renames and deletes tags', async () => {
		const ids = new Map<string, string>();
		const responses: Record<string, unknown> = {};

		responses.emptyList = record(await ownerAgent.get('/annotation-tags'), ids);
		const good = await ownerAgent.post('/annotation-tags').send({ name: '  Good  ' });
		responses.create = record(good, ids);
		const bad = await ownerAgent.post('/annotation-tags').send({ name: 'Bad' });
		responses.createSecond = record(bad, ids);
		responses.list = record(await ownerAgent.get('/annotation-tags'), ids);
		responses.rename = record(
			await ownerAgent.patch(`/annotation-tags/${good.body.data.id}`).send({ name: 'Great' }),
			ids,
		);
		responses.listAfterRename = record(await ownerAgent.get('/annotation-tags'), ids);
		responses.delete = record(await ownerAgent.delete(`/annotation-tags/${bad.body.data.id}`), ids);
		responses.listAfterDelete = record(await ownerAgent.get('/annotation-tags'), ids);

		expect(responses).toMatchSnapshot();
	});

	test('rejects names that are not valid, and duplicate names', async () => {
		await ownerAgent.post('/annotation-tags').send({ name: 'Good' });

		const responses = {
			duplicate: record(await ownerAgent.post('/annotation-tags').send({ name: 'Good' })),
			empty: record(await ownerAgent.post('/annotation-tags').send({ name: '' })),
			blank: record(await ownerAgent.post('/annotation-tags').send({ name: '   ' })),
			tooLong: record(await ownerAgent.post('/annotation-tags').send({ name: 'x'.repeat(25) })),
			maxLength: record(await ownerAgent.post('/annotation-tags').send({ name: 'y'.repeat(24) })),
			missing: record(await ownerAgent.post('/annotation-tags').send({})),
			notString: record(await ownerAgent.post('/annotation-tags').send({ name: 42 })),
		};

		expect(responses).toMatchSnapshot();
	});

	test('answers for tags that do not exist, and renames to a used name', async () => {
		const good = await ownerAgent.post('/annotation-tags').send({ name: 'Good' });
		await ownerAgent.post('/annotation-tags').send({ name: 'Bad' });

		const responses = {
			renameUnknown: record(
				await ownerAgent.patch('/annotation-tags/unknown').send({ name: 'Other' }),
			),
			renameToUsedName: record(
				await ownerAgent.patch(`/annotation-tags/${good.body.data.id}`).send({ name: 'Bad' }),
			),
			renameToEmpty: record(
				await ownerAgent.patch(`/annotation-tags/${good.body.data.id}`).send({ name: '' }),
			),
			deleteUnknown: record(await ownerAgent.delete('/annotation-tags/unknown')),
		};

		expect(responses).toMatchSnapshot();
	});

	test('counts the executions of each tag', async () => {
		const ids = new Map<string, string>();
		const good = await ownerAgent.post('/annotation-tags').send({ name: 'Good' });
		const bad = await ownerAgent.post('/annotation-tags').send({ name: 'Bad' });
		await ownerAgent.post('/annotation-tags').send({ name: 'Unused' });
		const workflow = await createWorkflow({}, owner);
		const first = await createExecution({ status: 'success' }, workflow);
		const second = await createExecution({ status: 'error' }, workflow);
		await annotateExecution(first.id, { vote: 'up', tags: [good.body.data.id] }, [workflow.id]);
		await annotateExecution(
			second.id,
			{ vote: 'down', tags: [good.body.data.id, bad.body.data.id] },
			[workflow.id],
		);

		const responses = {
			withCount: record(await ownerAgent.get('/annotation-tags?withUsageCount=true'), ids),
			withoutCount: record(await ownerAgent.get('/annotation-tags?withUsageCount=false'), ids),
		};

		expect(responses).toMatchSnapshot();
	});

	test('lets a member manage the tags', async () => {
		const created = await memberAgent.post('/annotation-tags').send({ name: 'Member tag' });

		const responses = {
			create: record(created),
			list: record(await memberAgent.get('/annotation-tags')),
			rename: record(
				await memberAgent
					.patch(`/annotation-tags/${created.body.data.id}`)
					.send({ name: 'Renamed' }),
			),
			delete: record(await memberAgent.delete(`/annotation-tags/${created.body.data.id}`)),
		};

		expect(responses).toMatchSnapshot();
	});

	test('removes a deleted tag from the annotated executions', async () => {
		const good = await ownerAgent.post('/annotation-tags').send({ name: 'Good' });
		const bad = await ownerAgent.post('/annotation-tags').send({ name: 'Bad' });
		const workflow = await createWorkflow({}, owner);
		const execution = await createExecution({ status: 'success' }, workflow);
		await annotateExecution(
			execution.id,
			{ vote: 'up', tags: [good.body.data.id, bad.body.data.id] },
			[workflow.id],
		);

		await ownerAgent.delete(`/annotation-tags/${good.body.data.id}`);

		const ids = new Map<string, string>();
		expect(
			record(await ownerAgent.get('/annotation-tags?withUsageCount=true'), ids),
		).toMatchSnapshot();
	});
});

describe('the tags of an annotated execution', () => {
	/** Runs a call, and records its result or the class and the message of its error. */
	async function outcome(call: () => Promise<unknown>, ids: Map<string, string>) {
		try {
			const result = await call();
			return { result: normalize(Array.isArray(result) ? sortByName(result) : result, ids) };
		} catch (error) {
			return error instanceof Error
				? { error: error.constructor.name, message: error.message }
				: { error: String(error) };
		}
	}

	test('replaces, empties and keeps the tags, and rejects unknown tags', async () => {
		const ids = new Map<string, string>();
		const good = await ownerAgent.post('/annotation-tags').send({ name: 'Good' });
		const bad = await ownerAgent.post('/annotation-tags').send({ name: 'Bad' });
		const goodId: string = good.body.data.id;
		const badId: string = bad.body.data.id;
		const workflow = await createWorkflow({}, owner);
		const execution = await createExecution({ status: 'success' }, workflow);
		const executionService = Container.get(ExecutionService);
		const tags = async () => await executionService.getExecutionTags(execution.id, [workflow.id]);
		const annotation = async () => {
			const found = await executionService.findOneInWorkflows(execution.id, [workflow.id], {
				includeData: false,
				includeAnnotation: true,
			});
			return found && 'annotation' in found ? found.annotation : undefined;
		};

		const results: Record<string, unknown> = {};
		results.beforeAnnotation = await outcome(tags, ids);
		results.setBoth = await outcome(
			async () =>
				await annotateExecution(execution.id, { vote: 'up', tags: [goodId, badId] }, [workflow.id]),
			ids,
		);
		results.afterSetBoth = await outcome(annotation, ids);
		results.voteOnly = await outcome(
			async () => await annotateExecution(execution.id, { vote: 'down' }, [workflow.id]),
			ids,
		);
		results.afterVoteOnly = await outcome(annotation, ids);
		results.clearVote = await outcome(
			async () => await annotateExecution(execution.id, { vote: null }, [workflow.id]),
			ids,
		);
		results.afterClearVote = await outcome(annotation, ids);
		results.replaceTags = await outcome(
			async () => await executionService.updateExecutionTags(execution.id, [badId], [workflow.id]),
			ids,
		);
		results.duplicateTags = await outcome(
			async () =>
				await executionService.updateExecutionTags(execution.id, [goodId, goodId], [workflow.id]),
			ids,
		);
		results.afterDuplicateTags = await outcome(tags, ids);
		results.unknownTag = await outcome(
			async () =>
				await executionService.updateExecutionTags(execution.id, ['unknown'], [workflow.id]),
			ids,
		);
		results.afterUnknownTag = await outcome(tags, ids);
		results.emptyTags = await outcome(
			async () => await executionService.updateExecutionTags(execution.id, [], [workflow.id]),
			ids,
		);
		results.afterEmptyTags = await outcome(annotation, ids);
		results.otherWorkflow = await outcome(
			async () => await executionService.updateExecutionTags(execution.id, [goodId], ['other']),
			ids,
		);

		expect(results).toMatchSnapshot();
	});
});
