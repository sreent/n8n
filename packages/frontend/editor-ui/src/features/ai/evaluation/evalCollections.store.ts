// Fork code (not in upstream n8n): the store of evaluation collections, their details, the versions
// that a new collection can compare, and the insights of a collection. It replaces the enterprise
// store of the same name and keeps its ID and members. See `FORK.md` in this folder.
import type {
	AiInsightsResponse,
	CreateEvaluationCollectionPayload,
	EvalVersionsResponse,
	EvaluationCollectionDetail,
	EvaluationCollectionRecord,
	UpdateEvaluationCollectionPayload,
} from '@n8n/api-types';
import { STORES } from '@n8n/stores';
import { useRootStore } from '@n8n/stores/useRootStore';
import { defineStore } from 'pinia';
import { ref } from 'vue';

import * as collectionsApi from './evalCollections.api';
import { POLLING_INTERVAL_MS } from './evaluation.constants';

const isActiveStatus = (status: string) => status === 'running' || status === 'new';

/** A collection is active while one of its runs has not finished. */
export const isActiveCollection = (detail: EvaluationCollectionDetail) =>
	detail.runs.some((run) => isActiveStatus(run.status));

export const useEvalCollectionsStore = defineStore(STORES.EVAL_COLLECTIONS, () => {
	const rootStore = useRootStore();

	const isLoading = ref(false);
	const loadingDetail = ref(false);
	const loadingVersions = ref(false);
	const loadingInsights = ref(false);
	const collectionsByWorkflowId = ref<Record<string, EvaluationCollectionRecord[]>>({});
	const collectionDetailById = ref<Record<string, EvaluationCollectionDetail>>({});
	const versionsByConfigId = ref<Record<string, EvalVersionsResponse>>({});
	const insightsByCollectionId = ref<Record<string, AiInsightsResponse>>({});

	// The timers of the collections that the store asks for again. They are not state of the page.
	const pollingTimers = new Map<string, ReturnType<typeof setTimeout>>();

	const getCollections = (workflowId: string) => collectionsByWorkflowId.value[workflowId] ?? [];
	const getDetail = (collectionId: string) => collectionDetailById.value[collectionId];
	const getVersions = (configId: string) => versionsByConfigId.value[configId];
	const getInsights = (collectionId: string) => insightsByCollectionId.value[collectionId];

	async function fetchCollections(workflowId: string) {
		isLoading.value = true;
		try {
			const collections = await collectionsApi.getCollections(rootStore.restApiContext, workflowId);
			collectionsByWorkflowId.value[workflowId] = collections;
			return collections;
		} finally {
			isLoading.value = false;
		}
	}

	async function fetchCollectionDetail(workflowId: string, collectionId: string) {
		loadingDetail.value = true;
		try {
			const detail = await collectionsApi.getCollection(
				rootStore.restApiContext,
				workflowId,
				collectionId,
			);
			collectionDetailById.value[collectionId] = detail;
			return detail;
		} finally {
			loadingDetail.value = false;
		}
	}

	async function fetchEvalVersions(workflowId: string, configId: string) {
		loadingVersions.value = true;
		try {
			const versions = await collectionsApi.getEvalVersions(
				rootStore.restApiContext,
				workflowId,
				configId,
			);
			versionsByConfigId.value[configId] = versions;
			return versions;
		} finally {
			loadingVersions.value = false;
		}
	}

	async function createCollection(workflowId: string, payload: CreateEvaluationCollectionPayload) {
		const detail = await collectionsApi.createCollection(
			rootStore.restApiContext,
			workflowId,
			payload,
		);
		collectionDetailById.value[detail.id] = detail;
		collectionsByWorkflowId.value[workflowId] = [
			detail,
			...getCollections(workflowId).filter((collection) => collection.id !== detail.id),
		];
		return detail;
	}

	async function updateCollection(
		workflowId: string,
		collectionId: string,
		payload: UpdateEvaluationCollectionPayload,
	) {
		const record = await collectionsApi.updateCollection(
			rootStore.restApiContext,
			workflowId,
			collectionId,
			payload,
		);
		collectionsByWorkflowId.value[workflowId] = getCollections(workflowId).map((collection) =>
			collection.id === collectionId ? record : collection,
		);
		const detail = getDetail(collectionId);
		if (detail) collectionDetailById.value[collectionId] = { ...detail, ...record };
		return record;
	}

	async function deleteCollection(workflowId: string, collectionId: string) {
		const result = await collectionsApi.deleteCollection(
			rootStore.restApiContext,
			workflowId,
			collectionId,
		);
		stopPolling(collectionId);
		collectionsByWorkflowId.value[workflowId] = getCollections(workflowId).filter(
			(collection) => collection.id !== collectionId,
		);
		delete collectionDetailById.value[collectionId];
		delete insightsByCollectionId.value[collectionId];
		return result;
	}

	async function rerunCollection(workflowId: string, collectionId: string) {
		const detail = await collectionsApi.rerunCollection(
			rootStore.restApiContext,
			workflowId,
			collectionId,
		);
		collectionDetailById.value[collectionId] = detail;
		delete insightsByCollectionId.value[collectionId];
		return detail;
	}

	async function addExistingRun(workflowId: string, collectionId: string, testRunId: string) {
		const detail = await collectionsApi.addRunToCollection(
			rootStore.restApiContext,
			workflowId,
			collectionId,
			testRunId,
		);
		collectionDetailById.value[collectionId] = detail;
		return detail;
	}

	async function removeRun(workflowId: string, collectionId: string, runId: string) {
		const detail = await collectionsApi.removeRunFromCollection(
			rootStore.restApiContext,
			workflowId,
			collectionId,
			runId,
		);
		collectionDetailById.value[collectionId] = detail;
		return detail;
	}

	async function generateInsights(
		workflowId: string,
		collectionId: string,
		forceRegenerate = false,
	) {
		loadingInsights.value = true;
		try {
			const insights = await collectionsApi.generateInsights(
				rootStore.restApiContext,
				workflowId,
				collectionId,
				forceRegenerate,
			);
			insightsByCollectionId.value[collectionId] = insights;
			return insights;
		} finally {
			loadingInsights.value = false;
		}
	}

	/** Asks for the detail of a collection each second while one of its runs is active. */
	function startPolling(workflowId: string, collectionId: string) {
		stopPolling(collectionId);
		const poll = async () => {
			try {
				const detail = await fetchCollectionDetail(workflowId, collectionId);
				if (!pollingTimers.has(collectionId)) return;
				if (!isActiveCollection(detail)) {
					stopPolling(collectionId);
					return;
				}
				pollingTimers.set(
					collectionId,
					setTimeout(() => {
						void poll();
					}, POLLING_INTERVAL_MS),
				);
			} catch {
				stopPolling(collectionId);
			}
		};
		pollingTimers.set(
			collectionId,
			setTimeout(() => {
				void poll();
			}, POLLING_INTERVAL_MS),
		);
	}

	function stopPolling(collectionId: string) {
		clearTimeout(pollingTimers.get(collectionId));
		pollingTimers.delete(collectionId);
	}

	function cleanupPolling() {
		for (const collectionId of [...pollingTimers.keys()]) stopPolling(collectionId);
	}

	return {
		isLoading,
		loadingDetail,
		loadingVersions,
		loadingInsights,
		collectionsByWorkflowId,
		collectionDetailById,
		versionsByConfigId,
		insightsByCollectionId,
		getCollections,
		getDetail,
		getVersions,
		getInsights,
		fetchCollections,
		fetchCollectionDetail,
		fetchEvalVersions,
		createCollection,
		updateCollection,
		deleteCollection,
		rerunCollection,
		addExistingRun,
		removeRun,
		generateInsights,
		startPolling,
		stopPolling,
		cleanupPolling,
	};
});
