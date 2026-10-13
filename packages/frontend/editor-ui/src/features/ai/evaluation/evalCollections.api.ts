// Fork code (not in upstream n8n): the REST client of evaluation collections, the versions that a
// collection can compare, and the insights of a collection. It replaces the enterprise file of the
// same name. See `FORK.md` in this folder.
import type {
	AiInsightsResponse,
	CreateEvaluationCollectionPayload,
	EvalVersionsResponse,
	EvaluationCollectionDetail,
	EvaluationCollectionRecord,
	UpdateEvaluationCollectionPayload,
} from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

const collectionsPath = (workflowId: string) => `/workflows/${workflowId}/eval-collections`;

export async function getCollections(context: IRestApiContext, workflowId: string) {
	return await makeRestApiRequest<EvaluationCollectionRecord[]>(
		context,
		'GET',
		collectionsPath(workflowId),
	);
}

export async function getCollection(
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
) {
	return await makeRestApiRequest<EvaluationCollectionDetail>(
		context,
		'GET',
		`${collectionsPath(workflowId)}/${collectionId}`,
	);
}

export async function createCollection(
	context: IRestApiContext,
	workflowId: string,
	payload: CreateEvaluationCollectionPayload,
) {
	return await makeRestApiRequest<EvaluationCollectionDetail>(
		context,
		'POST',
		collectionsPath(workflowId),
		payload,
	);
}

export async function updateCollection(
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
	payload: UpdateEvaluationCollectionPayload,
) {
	return await makeRestApiRequest<EvaluationCollectionRecord>(
		context,
		'PATCH',
		`${collectionsPath(workflowId)}/${collectionId}`,
		payload,
	);
}

export async function deleteCollection(
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
) {
	return await makeRestApiRequest<{ success: boolean }>(
		context,
		'DELETE',
		`${collectionsPath(workflowId)}/${collectionId}`,
	);
}

export async function rerunCollection(
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
) {
	return await makeRestApiRequest<EvaluationCollectionDetail>(
		context,
		'POST',
		`${collectionsPath(workflowId)}/${collectionId}/rerun`,
	);
}

export async function addRunToCollection(
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
	testRunId: string,
) {
	return await makeRestApiRequest<EvaluationCollectionDetail>(
		context,
		'POST',
		`${collectionsPath(workflowId)}/${collectionId}/runs`,
		{ testRunId },
	);
}

export async function removeRunFromCollection(
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
	runId: string,
) {
	return await makeRestApiRequest<EvaluationCollectionDetail>(
		context,
		'DELETE',
		`${collectionsPath(workflowId)}/${collectionId}/runs/${runId}`,
	);
}

export async function getEvalVersions(
	context: IRestApiContext,
	workflowId: string,
	evaluationConfigId: string,
) {
	return await makeRestApiRequest<EvalVersionsResponse>(
		context,
		'GET',
		`/workflows/${workflowId}/eval-versions`,
		{ evaluationConfigId },
	);
}

export async function generateInsights(
	context: IRestApiContext,
	workflowId: string,
	collectionId: string,
	forceRegenerate = false,
) {
	return await makeRestApiRequest<AiInsightsResponse>(
		context,
		'POST',
		`${collectionsPath(workflowId)}/${collectionId}/insights`,
		{ forceRegenerate },
	);
}
