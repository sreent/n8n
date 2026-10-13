// Fork code (not in upstream n8n): the number of test cases that a new run runs at the same time.
// It replaces the enterprise store of the same name and keeps its ID and members. See `FORK.md`
// in this folder.
import { useSettingsStore } from '@n8n/stores/settings.store';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export const DEFAULT_PARALLEL_CONCURRENCY = 3;

/** The highest concurrency that the REST API takes. A limit of -1 means no licence limit. */
const MAX_CONCURRENCY = 10;

export const useParallelEvalStore = defineStore('parallelEval', () => {
	const settingsStore = useSettingsStore();

	const maxConcurrency = computed(() => {
		const limit = settingsStore.settings.evaluationConcurrencyLimit;
		return limit === -1 || limit === undefined ? MAX_CONCURRENCY : Math.min(limit, MAX_CONCURRENCY);
	});

	/** A limit of 1 leaves nothing to choose. */
	const isConcurrencyAvailable = computed(() => maxConcurrency.value > 1);

	const chosenConcurrency = ref(DEFAULT_PARALLEL_CONCURRENCY);
	const parallel = ref(true);

	const concurrencyValue = computed(() =>
		Math.max(1, Math.min(chosenConcurrency.value, maxConcurrency.value)),
	);
	const isParallel = computed(() => parallel.value && concurrencyValue.value > 1);

	/** The concurrency of a new run, or undefined when the run takes one case at a time. */
	const effectiveConcurrency = computed(() =>
		isConcurrencyAvailable.value ? (isParallel.value ? concurrencyValue.value : 1) : undefined,
	);

	function setConcurrencyValue(value: number) {
		chosenConcurrency.value = value;
	}

	function setParallel(value: boolean) {
		parallel.value = value;
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
