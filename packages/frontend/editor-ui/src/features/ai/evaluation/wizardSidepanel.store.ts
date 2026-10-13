// Fork code (not in upstream n8n): the state of the Tests panel of the focus sidebar: the AI node
// under test, the checks, the case that the user edits, the rows of the dataset and the view of
// the panel. It replaces the enterprise store of the same name and keeps its ID and members. The
// canvas opens the panel with `open`, and the executions page hands over an execution with
// `setPendingSeedExecution`. See `FORK.md` in this folder.
import { defineStore } from 'pinia';
import { nanoid } from 'nanoid';
import { ref } from 'vue';

import type { IExecutionResponse } from '@/features/execution/executions/executions.types';
import { useFocusPanelStore } from '@/app/stores/focusPanel.store';

import { DEFAULT_SELECTED_METRIC_KEYS, type CannedMetricKey } from './wizard.constants';
import type { CustomCheck, JudgeSelection } from './wizard.utils';

export type TestsViewMode = 'list' | 'create' | 'detail';

export const useEvaluationsWizardSidepanelStore = defineStore('evaluationsWizardSidepanel', () => {
	const isOpen = ref(false);
	const activeStep = ref(0);
	const selectedMetricKeys = ref<CannedMetricKey[]>([...DEFAULT_SELECTED_METRIC_KEYS]);
	const judgeSelectionByMetric = ref<Partial<Record<CannedMetricKey, JudgeSelection>>>({});
	const aiNodeName = ref('');
	const isSliceMode = ref(false);
	const startNodeName = ref('');
	const endNodeName = ref('');
	/** The input fields of the case that the user edits. */
	const inputs = ref<Record<string, string>>({});
	/** The expected values of the case that the user edits. */
	const expectedValues = ref<Record<string, string>>({});
	const datasetExpectedByRow = ref<Array<Record<string, string>>>([]);
	const datasetInputsByRow = ref<Array<Record<string, string>>>([]);
	const datasetNamesByRow = ref<string[]>([]);
	const caseName = ref('');
	const prefillInputsFromExecution = ref(true);
	const viewMode = ref<TestsViewMode>('list');
	/** The row of the dataset that the user edits, or null for a new case. */
	const activeRowIndex = ref<number | null>(null);
	const activeRowId = ref<number | null>(null);
	/** The execution that a new case takes its input fields from. */
	const seedExecution = ref<IExecutionResponse | null>(null);
	/** An execution from the executions page that becomes a new case when the panel opens. */
	const pendingSeedExecution = ref<IExecutionResponse | null>(null);
	const customChecks = ref<CustomCheck[]>([]);
	const isCustomCheckModalOpen = ref(false);
	const activeRunId = ref<string | null>(null);
	const lastWorkflowId = ref('');
	const answerNodeName = ref('');
	/** Goes up with each change of the user to the case. The panel saves it after a pause. */
	const caseEditVersion = ref(0);
	/** Goes up with each change of the user to the checks. The panel saves it after a pause. */
	const configEditVersion = ref(0);

	const caseEdited = () => {
		caseEditVersion.value++;
	};
	const configEdited = () => {
		configEditVersion.value++;
	};

	function open(step = 0) {
		isOpen.value = true;
		activeStep.value = step;
		const focusPanelStore = useFocusPanelStore();
		focusPanelStore.setSelectedTab('evaluations');
		focusPanelStore.openFocusPanel();
	}

	function close() {
		isOpen.value = false;
	}

	function toggle() {
		if (isOpen.value) close();
		else open(activeStep.value);
	}

	function reset() {
		activeStep.value = 0;
		selectedMetricKeys.value = [...DEFAULT_SELECTED_METRIC_KEYS];
		judgeSelectionByMetric.value = {};
		aiNodeName.value = '';
		isSliceMode.value = false;
		startNodeName.value = '';
		endNodeName.value = '';
		inputs.value = {};
		expectedValues.value = {};
		datasetExpectedByRow.value = [];
		datasetInputsByRow.value = [];
		datasetNamesByRow.value = [];
		caseName.value = '';
		prefillInputsFromExecution.value = true;
		viewMode.value = 'list';
		activeRowIndex.value = null;
		activeRowId.value = null;
		seedExecution.value = null;
		customChecks.value = [];
		isCustomCheckModalOpen.value = false;
		activeRunId.value = null;
		answerNodeName.value = '';
	}

	function setStep(step: number) {
		activeStep.value = step;
	}

	function goNext() {
		activeStep.value++;
	}

	function goBack() {
		activeStep.value = Math.max(0, activeStep.value - 1);
	}

	function toggleMetric(key: CannedMetricKey) {
		selectedMetricKeys.value = selectedMetricKeys.value.includes(key)
			? selectedMetricKeys.value.filter((item) => item !== key)
			: [...selectedMetricKeys.value, key];
		configEdited();
	}

	function setJudgeSelection(key: CannedMetricKey, selection: JudgeSelection) {
		judgeSelectionByMetric.value = { ...judgeSelectionByMetric.value, [key]: selection };
	}

	function setAiNodeName(name: string) {
		aiNodeName.value = name;
		answerNodeName.value = name;
	}

	function enterSliceMode(start: string, end: string) {
		isSliceMode.value = true;
		startNodeName.value = start;
		endNodeName.value = end;
	}

	function exitSliceMode() {
		isSliceMode.value = false;
		startNodeName.value = '';
		endNodeName.value = '';
	}

	function setInputValue(field: string, value: string) {
		inputs.value = { ...inputs.value, [field]: value };
		caseEdited();
	}

	function setExpectedValue(field: string, value: string) {
		expectedValues.value = { ...expectedValues.value, [field]: value };
		caseEdited();
	}

	/** Sets the input fields of the case without a save. */
	function seedInputs(values: Record<string, string>) {
		inputs.value = { ...values };
	}

	function openCustomCheckModal() {
		isCustomCheckModalOpen.value = true;
	}

	function closeCustomCheckModal() {
		isCustomCheckModalOpen.value = false;
	}

	function addCustomCheck(check?: Partial<CustomCheck>) {
		customChecks.value = [
			...customChecks.value,
			{
				id: check?.id ?? nanoid(),
				name: check?.name ?? `Custom ${customChecks.value.length + 1}`,
				expression: check?.expression ?? '',
			},
		];
		configEdited();
	}

	function removeCustomCheck(id: string) {
		customChecks.value = customChecks.value.filter((check) => check.id !== id);
		configEdited();
	}

	function updateCustomCheck(id: string, expression: string) {
		customChecks.value = customChecks.value.map((check) =>
			check.id === id ? { ...check, expression } : check,
		);
		configEdited();
	}

	function setActiveRunId(id: string | null) {
		activeRunId.value = id;
	}

	function setLastWorkflowId(id: string) {
		lastWorkflowId.value = id;
	}

	function openList() {
		viewMode.value = 'list';
		activeRowIndex.value = null;
		activeRowId.value = null;
		seedExecution.value = null;
	}

	function openCreate() {
		viewMode.value = 'create';
	}

	/** Opens a row of the dataset, or a new case without a row. */
	function openDetail(rowIndex: number | null = null) {
		viewMode.value = 'detail';
		activeRowIndex.value = rowIndex;
		activeRowId.value = null;
		if (rowIndex === null) {
			caseName.value = '';
			expectedValues.value = {};
			activeRunId.value = null;
			return;
		}
		caseName.value = datasetNamesByRow.value[rowIndex] ?? '';
		inputs.value = { ...(datasetInputsByRow.value[rowIndex] ?? {}) };
		expectedValues.value = { ...(datasetExpectedByRow.value[rowIndex] ?? {}) };
	}

	function setCaseName(name: string) {
		caseName.value = name;
		caseEdited();
	}

	function setPrefillInputsFromExecution(value: boolean) {
		prefillInputsFromExecution.value = value;
	}

	function setSeedExecution(execution: IExecutionResponse | null) {
		seedExecution.value = execution;
	}

	function setPendingSeedExecution(execution: IExecutionResponse | null) {
		pendingSeedExecution.value = execution;
	}

	function setActiveRow(index: number | null, id: number | null) {
		activeRowIndex.value = index;
		activeRowId.value = id;
	}

	return {
		isOpen,
		activeStep,
		selectedMetricKeys,
		judgeSelectionByMetric,
		aiNodeName,
		isSliceMode,
		startNodeName,
		endNodeName,
		inputs,
		expectedValues,
		datasetExpectedByRow,
		datasetInputsByRow,
		datasetNamesByRow,
		caseName,
		prefillInputsFromExecution,
		viewMode,
		activeRowIndex,
		activeRowId,
		seedExecution,
		pendingSeedExecution,
		customChecks,
		isCustomCheckModalOpen,
		activeRunId,
		lastWorkflowId,
		answerNodeName,
		caseEditVersion,
		configEditVersion,
		open,
		close,
		toggle,
		reset,
		setStep,
		goNext,
		goBack,
		toggleMetric,
		setJudgeSelection,
		setAiNodeName,
		enterSliceMode,
		exitSliceMode,
		setInputValue,
		setExpectedValue,
		seedInputs,
		openCustomCheckModal,
		closeCustomCheckModal,
		addCustomCheck,
		removeCustomCheck,
		updateCustomCheck,
		setActiveRunId,
		setLastWorkflowId,
		openList,
		openCreate,
		openDetail,
		setCaseName,
		setPrefillInputsFromExecution,
		setSeedExecution,
		setPendingSeedExecution,
		setActiveRow,
	};
});
