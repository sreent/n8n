import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import type { UsageState } from '@n8n/api-types';
import * as usageApi from '@n8n/rest-api-client/api/usage';
import { useRootStore } from '@n8n/stores/useRootStore';

// Fork: the store reads the licence data only. The fork has no registration of the Community
// Edition, no licence key entry and no plan links (packages/cli/src/license/FORK.md).

const DEFAULT_PLAN_NAME = 'Community';
const DEFAULT_STATE: UsageState = {
	loading: true,
	data: {
		usage: {
			activeWorkflowTriggers: {
				limit: -1,
				value: 0,
				warningThreshold: 0.8,
			},
			workflowsHavingEvaluations: {
				value: 0,
				limit: 0,
			},
		},
		license: {
			planId: '',
			planName: DEFAULT_PLAN_NAME,
		},
	},
};

export const useUsageStore = defineStore('usage', () => {
	const rootStore = useRootStore();

	const state = reactive<UsageState>({ ...DEFAULT_STATE });
	const hasLoadedLicense = ref(false);

	const planName = computed(() => state.data.license.planName || DEFAULT_PLAN_NAME);
	const planId = computed(() => state.data.license.planId);
	const activeWorkflowTriggersLimit = computed(() => state.data.usage.activeWorkflowTriggers.limit);
	const activeWorkflowTriggersCount = computed(() => state.data.usage.activeWorkflowTriggers.value);
	const workflowsWithEvaluationsLimit = computed(
		() => state.data.usage.workflowsHavingEvaluations.limit,
	);
	const workflowsWithEvaluationsCount = computed(
		() => state.data.usage.workflowsHavingEvaluations.value,
	);
	const executionPercentage = computed(
		() => (activeWorkflowTriggersCount.value / activeWorkflowTriggersLimit.value) * 100,
	);

	const setLoading = (loading: boolean) => {
		state.loading = loading;
	};

	const setData = (data: UsageState['data']) => {
		state.data = data;
		hasLoadedLicense.value = true;
	};

	const getLicenseInfo = async () => {
		const data = await usageApi.getLicense(rootStore.restApiContext);
		setData(data);
	};

	return {
		setLoading,
		getLicenseInfo,
		setData,
		hasLoadedLicense,
		planName,
		planId,
		activeWorkflowTriggersLimit,
		activeWorkflowTriggersCount,
		workflowsWithEvaluationsLimit,
		workflowsWithEvaluationsCount,
		executionPercentage,
		isCloseToLimit: computed(() =>
			state.data.usage.activeWorkflowTriggers.limit < 0
				? false
				: activeWorkflowTriggersCount.value / activeWorkflowTriggersLimit.value >=
					state.data.usage.activeWorkflowTriggers.warningThreshold,
		),
		isLoading: computed(() => state.loading),
	};
});
