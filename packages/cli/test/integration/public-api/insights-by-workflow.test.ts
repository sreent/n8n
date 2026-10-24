// Fork test (not in upstream n8n): the insights of each workflow in the public API
// (`/api/v1/insights/by-workflow`). See
// packages/cli/src/public-api/v1/controllers/insights-by-workflow.public.controller.ts.
import { ModuleRegistry } from '@n8n/backend-common';
import { createCompactedInsightsEvent } from '@n8n/backend-module-insights/testing';
import {
	createTeamProject,
	createWorkflow,
	getPersonalProject,
	linkUserToProject,
	testDb,
} from '@n8n/backend-test-utils';
import { type Project, type User, WorkflowRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { DateTime } from 'luxon';

import { createMemberWithApiKey, createOwnerWithApiKey } from '../shared/db/users';
import * as utils from '../shared/utils';

const testServer = utils.setupTestServer({
	endpointGroups: ['publicApi'],
	enabledFeatures: ['feat:advancedPermissions', 'feat:insights:viewDashboard'],
	quotas: { 'quota:insights:maxHistoryDays': 365 },
	modules: ['insights'],
});

type Workflow = Awaited<ReturnType<typeof createWorkflow>>;

async function addMetrics(
	workflow: Workflow,
	values: { success?: number; failure?: number; runtimeMs?: number; timeSavedMin?: number },
) {
	const periodStart = DateTime.utc().minus({ days: 1 });
	const types = {
		success: values.success,
		failure: values.failure,
		runtime_ms: values.runtimeMs,
		time_saved_min: values.timeSavedMin,
	} as const;
	for (const [type, value] of Object.entries(types)) {
		if (value === undefined) continue;
		await createCompactedInsightsEvent(workflow, {
			type: type as keyof typeof types,
			value,
			periodStart,
			periodUnit: 'day',
		});
	}
}

const range = {
	startDate: DateTime.utc().minus({ days: 2 }).toISO(),
	endDate: DateTime.utc().plus({ days: 1 }).toISO(),
};

const names = (body: { data: Array<{ workflowName: string }> }) =>
	body.data.map((workflow) => workflow.workflowName);

let owner: User;
let ownerWithoutScope: User;
let member: User;
let finance: Project;
let marketing: Project;
let invoices: Workflow;
let reports: Workflow;
let newsletter: Workflow;

beforeAll(async () => {
	owner = await createOwnerWithApiKey({ scopes: ['insights:read'] });
	ownerWithoutScope = await createOwnerWithApiKey({ scopes: ['workflow:list'] });
	member = await createMemberWithApiKey({ scopes: ['insights:read'] });
});

beforeEach(async () => {
	await testDb.truncate([
		'InsightsByPeriod',
		'InsightsMetadata',
		'InsightsRaw',
		'SharedWorkflow',
		'WorkflowEntity',
	]);
	finance = await createTeamProject('Finance', owner);
	marketing = await createTeamProject('Marketing', owner);
	invoices = await createWorkflow({ name: 'Invoices' }, finance);
	reports = await createWorkflow({ name: 'Reports' }, finance);
	newsletter = await createWorkflow({ name: 'Newsletter' }, marketing);
	await addMetrics(invoices, { success: 3, failure: 1, runtimeMs: 400, timeSavedMin: 20 });
	await addMetrics(reports, { success: 1, runtimeMs: 100 });
	await addMetrics(newsletter, { success: 2, failure: 1, runtimeMs: 900, timeSavedMin: 5 });
	vi.restoreAllMocks();
});

describe('GET /insights/by-workflow', () => {
	test('returns 401 without an API key', async () => {
		await testServer.publicApiAgentWithoutApiKey().get('/insights/by-workflow').expect(401);
	});

	test('returns 403 for an API key without the scope insights:read', async () => {
		await testServer.publicApiAgentFor(ownerWithoutScope).get('/insights/by-workflow').expect(403);
	});

	test('returns 403 when the insights dashboard is not licensed', async () => {
		testServer.license.disable('feat:insights:viewDashboard');

		await testServer.publicApiAgentFor(owner).get('/insights/by-workflow').expect(403);
	});

	test('lists the workflows with their insights, most executions first', async () => {
		const response = await testServer
			.publicApiAgentFor(owner)
			.get('/insights/by-workflow')
			.query(range)
			.expect(200);

		expect(names(response.body)).toEqual(['Invoices', 'Newsletter', 'Reports']);
		expect(response.body.nextCursor).toBeNull();
		expect(response.body.data[0]).toEqual({
			workflowId: invoices.id,
			workflowName: 'Invoices',
			projectId: finance.id,
			projectName: 'Finance',
			total: 4,
			succeeded: 3,
			failed: 1,
			failureRate: 0.25,
			runTime: 400,
			averageRunTime: 100,
			timeSaved: 20,
		});
	});

	test('works with the session cookie of the owner', async () => {
		const response = await testServer
			.publicApiAgentWithCookie(owner)
			.get('/insights/by-workflow')
			.query(range)
			.expect(200);

		expect(names(response.body)).toHaveLength(3);
	});

	test('sorts and filters by project', async () => {
		const agent = testServer.publicApiAgentFor(owner);

		const byFailureRate = await agent
			.get('/insights/by-workflow')
			.query({ ...range, sortBy: 'failureRate:desc' })
			.expect(200);
		expect(names(byFailureRate.body)).toEqual(['Newsletter', 'Invoices', 'Reports']);

		const byName = await agent
			.get('/insights/by-workflow')
			.query({ ...range, sortBy: 'workflowName:asc' })
			.expect(200);
		expect(names(byName.body)).toEqual(['Invoices', 'Newsletter', 'Reports']);

		const finances = await agent
			.get('/insights/by-workflow')
			.query({ ...range, projectId: finance.id })
			.expect(200);
		expect(names(finances.body)).toEqual(['Invoices', 'Reports']);

		await agent
			.get('/insights/by-workflow')
			.query({ ...range, sortBy: 'colour:asc' })
			.expect(400);
	});

	test('pages with limit and cursor', async () => {
		const agent = testServer.publicApiAgentFor(owner);

		const first = await agent
			.get('/insights/by-workflow')
			.query({ ...range, limit: 2 })
			.expect(200);
		expect(names(first.body)).toEqual(['Invoices', 'Newsletter']);
		expect(first.body.nextCursor).toEqual(expect.any(String));

		const second = await agent
			.get('/insights/by-workflow')
			.query({ ...range, cursor: first.body.nextCursor })
			.expect(200);
		expect(names(second.body)).toEqual(['Reports']);
		expect(second.body.nextCursor).toBeNull();

		// Since n8n 2.45, a limit of 0 gives the default page, as in the other public API routes.
		const defaultPage = await agent
			.get('/insights/by-workflow')
			.query({ ...range, limit: 0 })
			.expect(200);
		expect(names(defaultPage.body)).toEqual(['Invoices', 'Newsletter', 'Reports']);
		expect(defaultPage.body.nextCursor).toBeNull();
	});

	test('gives a member only the workflows that the member can read', async () => {
		const own = await createWorkflow({ name: 'My flow' }, member);
		await addMetrics(own, { success: 1 });
		const agent = testServer.publicApiAgentFor(member);

		const response = await agent.get('/insights/by-workflow').query(range).expect(200);
		expect(names(response.body)).toEqual(['My flow']);
		expect(response.body.data[0].projectId).toBe((await getPersonalProject(member)).id);

		await agent
			.get('/insights/by-workflow')
			.query({ ...range, projectId: finance.id })
			.expect(403);

		await linkUserToProject(member, marketing, 'project:viewer');
		const withMarketing = await agent.get('/insights/by-workflow').query(range).expect(200);
		expect(names(withMarketing.body)).toEqual(['Newsletter', 'My flow']);
	});

	test('keeps the insights of a deleted workflow, without its id', async () => {
		await Container.get(WorkflowRepository).delete(reports.id);

		const response = await testServer
			.publicApiAgentFor(owner)
			.get('/insights/by-workflow')
			.query(range)
			.expect(200);

		const deleted = response.body.data.find(
			(workflow: { workflowName: string }) => workflow.workflowName === 'Reports',
		);
		expect(deleted).toMatchObject({ workflowId: null, total: 1 });
	});

	test('returns 400 for dates that are not ISO 8601 or in the wrong order', async () => {
		const agent = testServer.publicApiAgentFor(owner);

		await agent.get('/insights/by-workflow').query({ startDate: 'yesterday' }).expect(400);
		const response = await agent
			.get('/insights/by-workflow')
			.query({ startDate: range.endDate, endDate: range.startDate })
			.expect(400);
		expect(response.body.message).toBe('endDate must be the same as or after startDate');
	});

	test('returns 403 when startDate is older than the licensed history', async () => {
		await testServer
			.publicApiAgentFor(owner)
			.get('/insights/by-workflow')
			.query({ startDate: DateTime.utc().minus({ days: 366 }).toISO() })
			.expect(403);
	});

	test('returns 503 when the insights module is off', async () => {
		vi.spyOn(Container.get(ModuleRegistry), 'isActive').mockReturnValue(false);

		await testServer.publicApiAgentFor(owner).get('/insights/by-workflow').expect(503);
	});
});
