// Fork code (not in upstream n8n): the store of test runs, their cases and the evaluation configs
// of a workflow. It replaces the enterprise store of the same name and keeps its ID and members.
// See `FORK.md` in this folder.
import type { AddDatasetRowDto, StartTestRunPayload } from '@n8n/api-types';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { STORES } from '@n8n/stores';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import * as evaluationsApi from './evaluation.api';
import { POLLING_INTERVAL_MS } from './evaluation.constants';
import type { EvaluationConfig, TestCaseExecutionRecord, TestRunRecord } from './evaluation.types';
import { isActiveRun } from './evaluation.utils';

export const useEvaluationStore = defineStore(STORES.EVALUATION, () => {
	const rootStore = useRootStore();
	const settingsStore = useSettingsStore();

	const isLoading = ref(false);
	const testRunsById = ref<Record<string, TestRunRecord>>({});
	const testCaseExecutionsById = ref<Record<string, TestCaseExecutionRecord>>({});
	const evaluationConfigsByWorkflowId = ref<Record<string, EvaluationConfig[]>>({});

	// The timers of the runs that the store asks for again, and a counter for each run that ends
	// the older polling of the run. They are not state of the page.
	const pollingTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const pollingGenerations = new Map<string, number>();

	/** Evaluations are on unless the licence gives a quota of 0 workflows. */
	const isEvaluationEnabled = computed(() => settingsStore.settings.evaluation?.quota !== 0);

	const testRunsByWorkflowId = computed(() => {
		const byWorkflow: Record<string, TestRunRecord[]> = {};
		for (const testRun of Object.values(testRunsById.value)) {
			(byWorkflow[testRun.workflowId] ??= []).push(testRun);
		}
		return byWorkflow;
	});

	function upsertTestRun(testRun: TestRunRecord) {
		testRunsById.value[testRun.id] = testRun;
	}

	async function fetchTestRuns(workflowId: string) {
		isLoading.value = true;
		try {
			const testRuns = await evaluationsApi.getTestRuns(rootStore.restApiContext, workflowId);
			const ids = new Set(testRuns.map((testRun) => testRun.id));
			// Runs that are gone from the server leave the store. The other runs keep their place.
			for (const [id, testRun] of Object.entries(testRunsById.value)) {
				if (testRun.workflowId === workflowId && !ids.has(id)) delete testRunsById.value[id];
			}
			for (const testRun of testRuns) {
				upsertTestRun(testRun);
				if (isActiveRun(testRun)) startPolling(workflowId, testRun.id);
			}
			return testRuns;
		} finally {
			isLoading.value = false;
		}
	}

	async function getTestRun(params: { workflowId: string; runId: string }) {
		const testRun = await evaluationsApi.getTestRun(rootStore.restApiContext, params);
		upsertTestRun(testRun);
		return testRun;
	}

	async function fetchTestCaseExecutions(params: { workflowId: string; runId: string }) {
		const testCases = await evaluationsApi.getTestCaseExecutions(
			rootStore.restApiContext,
			params.workflowId,
			params.runId,
		);
		for (const testCase of testCases) {
			testCaseExecutionsById.value[testCase.id] = testCase;
		}
		return testCases;
	}

	async function startTestRun(workflowId: string, payload?: StartTestRunPayload) {
		return await evaluationsApi.startTestRun(rootStore.restApiContext, workflowId, payload);
	}

	async function cancelTestRun(workflowId: string, runId: string) {
		return await evaluationsApi.cancelTestRun(rootStore.restApiContext, workflowId, runId);
	}

	async function cancelTestCase(params: { workflowId: string; runId: string; caseId: string }) {
		const result = await evaluationsApi.cancelTestCase(
			rootStore.restApiContext,
			params.workflowId,
			params.runId,
			params.caseId,
		);
		const testCase = testCaseExecutionsById.value[params.caseId];
		if (testCase) {
			testCaseExecutionsById.value[params.caseId] = { ...testCase, status: 'cancelled' };
		}
		return result;
	}

	async function deleteTestRun(params: { workflowId: string; runId: string }) {
		const result = await evaluationsApi.deleteTestRun(rootStore.restApiContext, params);
		if (result.success) {
			stopPolling(params.runId);
			delete testRunsById.value[params.runId];
		}
		return result;
	}

	async function fetchEvaluationConfigs(workflowId: string) {
		const configs = await evaluationsApi.listEvaluationConfigs(
			rootStore.restApiContext,
			workflowId,
		);
		evaluationConfigsByWorkflowId.value[workflowId] = configs;
		return configs;
	}

	async function getDatasetCandidate(params: {
		workflowId: string;
		configId: string;
		executionId: string;
	}) {
		return await evaluationsApi.getDatasetCandidate(
			rootStore.restApiContext,
			params.workflowId,
			params.configId,
			params.executionId,
		);
	}

	async function addExecutionToDataset(params: {
		workflowId: string;
		configId: string;
		row: AddDatasetRowDto;
	}) {
		return await evaluationsApi.addDatasetRow(
			rootStore.restApiContext,
			params.workflowId,
			params.configId,
			params.row,
		);
	}

	/**
	 * Asks for a run and its cases now, and then each second while the run is active. A new start
	 * replaces the earlier polling of the run.
	 */
	function startPolling(workflowId: string, runId: string) {
		stopPolling(runId);
		const generation = (pollingGenerations.get(runId) ?? 0) + 1;
		pollingGenerations.set(runId, generation);
		const isCurrent = () => pollingGenerations.get(runId) === generation;

		const poll = async () => {
			try {
				const [testRun] = await Promise.all([
					getTestRun({ workflowId, runId }),
					fetchTestCaseExecutions({ workflowId, runId }),
				]);
				if (!isCurrent()) return;
				if (!isActiveRun(testRun)) {
					stopPolling(runId);
					return;
				}
				pollingTimers.set(
					runId,
					setTimeout(() => {
						void poll();
					}, POLLING_INTERVAL_MS),
				);
			} catch {
				if (isCurrent()) stopPolling(runId);
			}
		};
		void poll();
	}

	function stopPolling(runId: string) {
		clearTimeout(pollingTimers.get(runId));
		pollingTimers.delete(runId);
		pollingGenerations.set(runId, (pollingGenerations.get(runId) ?? 0) + 1);
	}

	function cleanupPolling() {
		for (const runId of [...pollingGenerations.keys()]) stopPolling(runId);
	}

	return {
		isLoading,
		isEvaluationEnabled,
		testRunsById,
		testRunsByWorkflowId,
		testCaseExecutionsById,
		evaluationConfigsByWorkflowId,
		fetchTestRuns,
		getTestRun,
		fetchTestCaseExecutions,
		startTestRun,
		cancelTestRun,
		cancelTestCase,
		deleteTestRun,
		fetchEvaluationConfigs,
		getDatasetCandidate,
		addExecutionToDataset,
		cleanupPolling,
	};
});
