// Fork code (not in upstream n8n): the link from an execution to the dataset of an evaluation. It
// loads the evaluation configs of the workflow with a data table as dataset and opens the dataset
// modal. It replaces the enterprise composable of the same name. See `../FORK.md`.
import type { MaybeRefOrGetter } from 'vue';
import { computed, ref, toValue } from 'vue';

import { ADD_EXECUTION_TO_DATASET_MODAL_KEY } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';
import { useEvaluationsWizardSidepanelExperiment } from '@/experiments/evaluationsWizardSidepanel/useEvaluationsWizardSidepanelExperiment';

import { useEvaluationStore } from '../evaluation.store';
import type { EvaluationConfig } from '../evaluation.types';

export function useAddExecutionToDataset(workflowId: MaybeRefOrGetter<string>) {
	const uiStore = useUIStore();
	const evaluationStore = useEvaluationStore();
	const { isFeatureEnabled } = useEvaluationsWizardSidepanelExperiment();

	const dataTableConfigs = ref<EvaluationConfig[]>([]);
	const hasDataTableConfig = computed(() => dataTableConfigs.value.length > 0);

	async function fetchDataTableConfigs() {
		const id = toValue(workflowId);
		if (!isFeatureEnabled.value || !id) {
			dataTableConfigs.value = [];
			return;
		}
		try {
			const configs = await evaluationStore.fetchEvaluationConfigs(id);
			dataTableConfigs.value = configs.filter((config) => config.datasetSource === 'data_table');
		} catch {
			dataTableConfigs.value = [];
		}
	}

	function openModal(executionId: string) {
		uiStore.openModalWithData({
			name: ADD_EXECUTION_TO_DATASET_MODAL_KEY,
			data: { configs: dataTableConfigs.value, executionId, workflowId: toValue(workflowId) },
		});
	}

	return { isFeatureEnabled, hasDataTableConfig, fetchDataTableConfigs, openModal };
}
