// Fork code (not in upstream n8n): the REST client of test runs and evaluation configs. It
// replaces the enterprise file of the same name. See `FORK.md` in this folder.
import type {
	AddDatasetRowDto,
	DatasetCandidateResponse,
	StartTestRunPayload,
	UpsertEvaluationConfigDto,
} from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest, request } from '@n8n/rest-api-client';

import type {
	EvaluationConfig,
	StartTestRunResponse,
	TestCaseExecutionRecord,
	TestRunRecord,
} from './evaluation.types';

const testRunsPath = (workflowId: string) => `/workflows/${workflowId}/test-runs`;
const configsPath = (workflowId: string) => `/workflows/${workflowId}/evaluation-configs`;

/** The routes that start and stop a run answer without the `data` wrapper of the REST API. */
async function requestUnwrapped<T>(
	context: IRestApiContext,
	endpoint: string,
	data?: StartTestRunPayload,
): Promise<T> {
	const response: T = await request({
		method: 'POST',
		baseURL: context.baseUrl,
		endpoint,
		headers: { 'push-ref': context.pushRef },
		data,
	});
	return response;
}

export async function getTestRuns(context: IRestApiContext, workflowId: string) {
	return await makeRestApiRequest<TestRunRecord[]>(context, 'GET', testRunsPath(workflowId));
}

export async function getTestRun(
	context: IRestApiContext,
	params: { workflowId: string; runId: string },
) {
	return await makeRestApiRequest<TestRunRecord>(
		context,
		'GET',
		`${testRunsPath(params.workflowId)}/${params.runId}`,
	);
}

export async function getTestCaseExecutions(
	context: IRestApiContext,
	workflowId: string,
	runId: string,
) {
	return await makeRestApiRequest<TestCaseExecutionRecord[]>(
		context,
		'GET',
		`${testRunsPath(workflowId)}/${runId}/test-cases`,
	);
}

/** Starts a run. Without a payload, the request has no body, and the backend runs one case at a time. */
export async function startTestRun(
	context: IRestApiContext,
	workflowId: string,
	payload?: StartTestRunPayload,
) {
	return await requestUnwrapped<StartTestRunResponse>(
		context,
		`${testRunsPath(workflowId)}/new`,
		payload,
	);
}

export async function cancelTestRun(context: IRestApiContext, workflowId: string, runId: string) {
	return await requestUnwrapped<{ success: boolean }>(
		context,
		`${testRunsPath(workflowId)}/${runId}/cancel`,
	);
}

export async function cancelTestCase(
	context: IRestApiContext,
	workflowId: string,
	runId: string,
	caseId: string,
) {
	return await makeRestApiRequest<{ success: boolean }>(
		context,
		'POST',
		`${testRunsPath(workflowId)}/${runId}/test-cases/${caseId}/cancel`,
	);
}

export async function deleteTestRun(
	context: IRestApiContext,
	params: { workflowId: string; runId: string },
) {
	return await makeRestApiRequest<{ success: boolean }>(
		context,
		'DELETE',
		`${testRunsPath(params.workflowId)}/${params.runId}`,
	);
}

export async function listEvaluationConfigs(context: IRestApiContext, workflowId: string) {
	return await makeRestApiRequest<EvaluationConfig[]>(context, 'GET', configsPath(workflowId));
}

export async function createEvaluationConfig(
	context: IRestApiContext,
	workflowId: string,
	payload: UpsertEvaluationConfigDto,
) {
	return await makeRestApiRequest<EvaluationConfig>(
		context,
		'POST',
		configsPath(workflowId),
		payload,
	);
}

export async function updateEvaluationConfig(
	context: IRestApiContext,
	workflowId: string,
	configId: string,
	payload: UpsertEvaluationConfigDto,
) {
	return await makeRestApiRequest<EvaluationConfig>(
		context,
		'PUT',
		`${configsPath(workflowId)}/${configId}`,
		payload,
	);
}

export async function deleteEvaluationConfig(
	context: IRestApiContext,
	workflowId: string,
	configId: string,
) {
	return await makeRestApiRequest<{ success: boolean }>(
		context,
		'DELETE',
		`${configsPath(workflowId)}/${configId}`,
	);
}

export async function getDatasetCandidate(
	context: IRestApiContext,
	workflowId: string,
	configId: string,
	executionId: string,
) {
	return await makeRestApiRequest<DatasetCandidateResponse>(
		context,
		'GET',
		`${configsPath(workflowId)}/${configId}/dataset-candidate`,
		{ executionId },
	);
}

export async function addDatasetRow(
	context: IRestApiContext,
	workflowId: string,
	configId: string,
	payload: AddDatasetRowDto,
) {
	return await makeRestApiRequest<{ success: boolean }>(
		context,
		'POST',
		`${configsPath(workflowId)}/${configId}/dataset-rows`,
		payload,
	);
}
