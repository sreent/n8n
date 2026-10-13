// Fork code (not in upstream n8n): the number of test cases that a new run of a workflow runs at
// the same time. The browser keeps the choice of each workflow. It replaces the enterprise store of
// the same name and keeps its ID, its members and its storage key. See `FORK.md` in this folder.
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useLocalStorage } from '@vueuse/core';
import { defineStore } from 'pinia';
import { computed } from 'vue';

export const DEFAULT_PARALLEL_CONCURRENCY = 3;

/** The highest concurrency that the REST API takes. A limit of -1 means no licence limit. */
const MAX_CONCURRENCY = 10;

const STORAGE_KEY = 'N8N_PARALLEL_EVAL_BY_WORKFLOW';

type WorkflowParallelSettings = { parallelEnabled: boolean; concurrencyValue: number };

export const useParallelEvalStore = defineStore('parallelEval', () => {
	const settingsStore = useSettingsStore();

	const settingsByWorkflow = useLocalStorage<Record<string, WorkflowParallelSettings>>(
		STORAGE_KEY,
		{},
	);

	const maxConcurrency = computed(() => {
		const limit = settingsStore.settings.evaluationConcurrencyLimit;
		return limit === -1 || limit === undefined ? MAX_CONCURRENCY : Math.min(limit, MAX_CONCURRENCY);
	});

	/** A limit of 1 leaves nothing to choose. */
	const isConcurrencyAvailable = computed(() => maxConcurrency.value > 1);

	const clamp = (value: number) => Math.max(1, Math.min(value, maxConcurrency.value));

	function concurrencyValue(workflowId: string) {
		return clamp(
			settingsByWorkflow.value[workflowId]?.concurrencyValue ?? DEFAULT_PARALLEL_CONCURRENCY,
		);
	}

	/** A workflow without a choice runs its cases in parallel. */
	function isParallel(workflowId: string) {
		return settingsByWorkflow.value[workflowId]?.parallelEnabled ?? true;
	}

	/** The concurrency of a new run, or undefined when the licence leaves nothing to choose. */
	function effectiveConcurrency(workflowId: string) {
		if (!isConcurrencyAvailable.value) return undefined;
		return isParallel(workflowId) ? concurrencyValue(workflowId) : 1;
	}

	function setConcurrencyValue(workflowId: string, value: number) {
		settingsByWorkflow.value = {
			...settingsByWorkflow.value,
			[workflowId]: { parallelEnabled: isParallel(workflowId), concurrencyValue: clamp(value) },
		};
	}

	function setParallel(workflowId: string, value: boolean) {
		settingsByWorkflow.value = {
			...settingsByWorkflow.value,
			[workflowId]: { parallelEnabled: value, concurrencyValue: concurrencyValue(workflowId) },
		};
	}

	return {
		isConcurrencyAvailable,
		maxConcurrency,
		concurrencyValue,
		effectiveConcurrency,
		isParallel,
		setConcurrencyValue,
		setParallel,
	};
});
