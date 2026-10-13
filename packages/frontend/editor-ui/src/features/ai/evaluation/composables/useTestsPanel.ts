// Fork code (not in upstream n8n): the work of the Tests panel: it loads the recent executions and
// the saved setup of the workflow, keeps the dataset (a data table) and the evaluation config in
// step with the panel, runs cases and loads their results. The panel component calls it once. See
// `../FORK.md`.
import { useTelemetry } from '@n8n/composables/useTelemetry';
import { useToast } from '@n8n/composables/useToast';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import type { IConnections } from 'n8n-workflow';
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { injectWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';
import { injectWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import {
	addDataTableColumnApi,
	createDataTableApi,
	deleteDataTableRowsApi,
	fetchDataTablesApi,
	getDataTableRowsApi,
	insertDataTableRowApi,
	updateDataTableRowsApi,
} from '@/features/core/dataTable/dataTable.api';
import type { DataTable } from '@/features/core/dataTable/dataTable.types';
import { useExecutionsStore } from '@/features/execution/executions/executions.store';
import type {
	ExecutionSummaryWithScopes,
	IExecutionResponse,
} from '@/features/execution/executions/executions.types';

import { useEvaluationStore } from '../evaluation.store';
import type { EvaluationConfig, TestCaseExecutionRecord, TestRunRecord } from '../evaluation.types';
import { indexTestRuns, isActiveRun } from '../evaluation.utils';
import {
	AUTO_SAVE_DELAY_MS,
	LLM_JUDGE_METRIC_KEYS,
	LM_SUBNODE_TYPE_TO_CHATHUB_PROVIDER,
	TEST_CASE_NAME_COLUMN,
	getCanonicalEvaluationName,
	getExpectedFieldsForMetrics,
} from '../wizard.constants';
import {
	answerText,
	buildEvaluationConfig,
	fieldText,
	findTriggerAndStart,
	hydrateConfig,
	inputFieldNames,
	inputValues,
	readAiNodeInput,
	requiredColumns,
} from '../wizard.utils';
import { useEvaluationsWizardSidepanelStore } from '../wizardSidepanel.store';
import { useAiRootNodes } from './useAiRootNodes';

/** The columns of a data table row that are not fields of a case. */
const BOOKKEEPING_COLUMNS = ['id', 'createdAt', 'updatedAt'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The model of a chat model node: a plain value, or the value of a resource locator. */
function modelName(parameter: unknown): string | undefined {
	if (typeof parameter === 'string') return parameter;
	if (isRecord(parameter) && typeof parameter.value === 'string') return parameter.value;
	return undefined;
}

export function useTestsPanel() {
	const i18n = useI18n();
	const toast = useToast();
	const telemetry = useTelemetry();
	const rootStore = useRootStore();
	const projectsStore = useProjectsStore();
	const executionsStore = useExecutionsStore();
	const evaluationStore = useEvaluationStore();
	const wizard = useEvaluationsWizardSidepanelStore();
	const workflowDocumentStore = injectWorkflowDocumentStore();
	const executionState = injectWorkflowExecutionStateStore();
	const aiRootNodes = useAiRootNodes();

	/** The panel waits for its first load before it shows a view. */
	const probeComplete = ref(false);
	const executions = ref<ExecutionSummaryWithScopes[]>([]);
	/** The executions of the cases, by execution ID. */
	const caseExecutions = ref<Record<string, IExecutionResponse>>({});
	/** The rows of the dataset and the config that the panel saved or loaded. */
	const savedConfig = ref<EvaluationConfig | null>(null);
	/** A saved setup exists: the panel shows its cases even without executions. */
	const hasSavedSetup = ref(false);
	/** The newest successful execution. A new AI node takes its input fields from it. */
	const firstExecution = ref<IExecutionResponse>();

	const workflowId = computed(() => workflowDocumentStore.value.workflowId);
	const workflowName = computed(() => workflowDocumentStore.value.name);
	const hasNodes = computed(() => workflowDocumentStore.value.allNodes.length > 0);
	const connections = computed<IConnections>(
		() => workflowDocumentStore.value.connectionsBySourceNode,
	);
	const projectId = computed(
		() => workflowDocumentStore.value.homeProject?.id ?? projectsStore.currentProjectId,
	);

	// #region The AI node and its input fields

	/** The input item of the AI node in the seed execution, else in the last run of the editor. */
	const aiNodeInput = computed(() => {
		const seedRunData = wizard.seedExecution?.data?.resultData?.runData;
		if (seedRunData) return readAiNodeInput(seedRunData, connections.value, wizard.aiNodeName);
		const editorRunData = executionState.value.activeExecutionRunData ?? undefined;
		return readAiNodeInput(editorRunData, connections.value, wizard.aiNodeName);
	});

	const inputFields = computed(() => inputFieldNames(aiNodeInput.value));
	const expectedFields = computed(() => getExpectedFieldsForMetrics(wizard.selectedMetricKeys));
	const graph = computed(() => findTriggerAndStart(connections.value, wizard.aiNodeName));

	/** The AI node under test: the chosen node while it exists, else the first AI node. */
	function ensureAiNode() {
		const names = aiRootNodes.value.map((node) => node.name);
		if (names.includes(wizard.aiNodeName)) return;
		wizard.setAiNodeName(names[0] ?? '');
	}

	/** The model of the AI judge: the chat model of the AI node, its credential and its model. */
	function seedJudgeSelection() {
		const byDestination = connections.value;
		const modelNodeName = Object.entries(byDestination).find(([, outputs]) =>
			(outputs.ai_languageModel ?? []).some((targets) =>
				(targets ?? []).some((target) => target.node === wizard.aiNodeName),
			),
		)?.[0];
		const modelNode = modelNodeName
			? workflowDocumentStore.value.getNodeByName(modelNodeName)
			: null;
		if (!modelNode) return;
		const provider = LM_SUBNODE_TYPE_TO_CHATHUB_PROVIDER[modelNode.type] ?? modelNode.type;
		const credentialId = Object.values(modelNode.credentials ?? {})[0]?.id ?? undefined;
		const model = modelName(modelNode.parameters.model);
		for (const key of LLM_JUDGE_METRIC_KEYS) {
			if (wizard.judgeSelectionByMetric[key]) continue;
			wizard.setJudgeSelection(key, { provider, credentialId, model });
		}
	}

	// #endregion

	// #region Loads

	function pickConfig(configs: EvaluationConfig[]) {
		const dataTableConfigs = configs.filter((config) => config.datasetSource === 'data_table');
		const canonical = getCanonicalEvaluationName(workflowName.value);
		return dataTableConfigs.find((config) => config.name === canonical) ?? dataTableConfigs[0];
	}

	const dataTableIdOf = (config: EvaluationConfig) =>
		config.datasetSource === 'data_table' ? config.datasetRef.dataTableId : '';

	/** Keeps the rows of the dataset: the input fields, the expected values and the names. */
	function applyRows(rows: Array<Record<string, unknown>>, metricKeys = wizard.selectedMetricKeys) {
		const expected = getExpectedFieldsForMetrics(metricKeys);
		const skip = new Set([...BOOKKEEPING_COLUMNS, ...expected, TEST_CASE_NAME_COLUMN]);
		wizard.datasetInputsByRow = rows.map((row) =>
			Object.fromEntries(
				Object.entries(row)
					.filter(([key]) => !skip.has(key))
					.map(([key, value]) => [key, fieldText(value)]),
			),
		);
		wizard.datasetExpectedByRow = rows.map((row) =>
			Object.fromEntries(expected.map((key) => [key, fieldText(row[key] ?? '')])),
		);
		wizard.datasetNamesByRow = rows.map((row) => fieldText(row[TEST_CASE_NAME_COLUMN] ?? ''));
	}

	async function loadRows(config: EvaluationConfig) {
		if (!projectId.value) return [];
		const { data } = await getDataTableRowsApi(
			rootStore.restApiContext,
			dataTableIdOf(config),
			projectId.value,
			{ take: 1000 },
		);
		return data;
	}

	/** Takes the checks of a saved config, with the model of each AI judge. */
	function applyConfig(config: EvaluationConfig) {
		const hydrated = hydrateConfig(config.metrics);
		wizard.selectedMetricKeys = hydrated.metricKeys;
		wizard.judgeSelectionByMetric = {
			...wizard.judgeSelectionByMetric,
			...hydrated.judgeSelectionByMetric,
		};
		wizard.customChecks = hydrated.customChecks;
	}

	/** The newest run of the config. */
	function latestRunOf(runs: TestRunRecord[], config: EvaluationConfig) {
		return indexTestRuns(runs.filter((run) => run.evaluationConfigId === config.id)).at(-1);
	}

	/** Loads the saved setup: the config, its checks, the rows and the newest run. */
	async function hydrate(): Promise<boolean> {
		const config = pickConfig(await evaluationStore.fetchEvaluationConfigs(workflowId.value));
		if (!config) return false;
		const rows = await loadRows(config);
		applyConfig(config);
		applyRows(rows);
		savedConfig.value = config;
		const runs = await evaluationStore.fetchTestRuns(workflowId.value);
		const latest = latestRunOf(runs, config);
		if (latest) {
			wizard.setActiveRunId(latest.id);
			wizard.setStep(3);
		}
		scheduleSave();
		return true;
	}

	/**
	 * Loads the list of cases again: the config with its rows, and the runs, at the same time.
	 * Without an active run it looks for the newest run of the config. Then it loads the cases
	 * of the run and the executions of the failed cases.
	 */
	async function loadResults() {
		const [configResult, runsResult] = await Promise.allSettled([
			evaluationStore.fetchEvaluationConfigs(workflowId.value),
			evaluationStore.fetchTestRuns(workflowId.value),
		]);
		if (configResult.status === 'rejected') {
			toast.showError(
				configResult.reason,
				i18n.baseText('evaluations.wizardSidepanel.hydrate.error'),
			);
		}
		const config = configResult.status === 'fulfilled' ? pickConfig(configResult.value) : undefined;
		if (config) {
			const rows = await loadRows(config);
			applyConfig(config);
			applyRows(rows);
			savedConfig.value = config;
		}
		let runs = runsResult.status === 'fulfilled' ? runsResult.value : [];
		if (config && !wizard.activeRunId) {
			runs = await evaluationStore.fetchTestRuns(workflowId.value);
			const latest = latestRunOf(runs, config);
			if (latest) wizard.setActiveRunId(latest.id);
		}
		const run = runs.find((item) => item.id === wizard.activeRunId);
		if (run) {
			const cases = await evaluationStore.fetchTestCaseExecutions({
				workflowId: workflowId.value,
				runId: run.id,
			});
			await Promise.all(
				cases
					.filter((testCase) => testCase.status === 'error' && testCase.executionId)
					.map(async (testCase) => await loadCaseExecution(testCase.executionId ?? '', true)),
			);
		}
		if (config) scheduleSave();
	}

	async function fetchRecentExecutions() {
		const page = await executionsStore.fetchExecutionsPage({
			status: ['success'],
			workflowId: workflowId.value,
		});
		executions.value = page.results;
		return page.results;
	}

	/** The execution of a case, from the cache unless `force`. */
	async function loadCaseExecution(executionId: string, force = false) {
		if (!executionId) return undefined;
		if (!force && caseExecutions.value[executionId]) return caseExecutions.value[executionId];
		try {
			const execution = await executionsStore.fetchExecution(executionId);
			if (execution) caseExecutions.value[executionId] = execution;
			return execution;
		} catch {
			return undefined;
		}
	}

	/** The first load of the panel. */
	async function probe() {
		wizard.setLastWorkflowId(workflowId.value);
		ensureAiNode();
		seedJudgeSelection();
		let hydrated = false;
		const [recent] = await Promise.all([
			fetchRecentExecutions().catch(() => []),
			hydrate()
				.then((result) => {
					hydrated = result;
				})
				.catch((error: unknown) => {
					toast.showError(error, i18n.baseText('evaluations.wizardSidepanel.hydrate.error'));
				}),
		]);
		hasSavedSetup.value = hydrated;
		if (!hydrated && recent.length === 0) {
			probeComplete.value = true;
			return;
		}
		const first = recent[0] ? await loadExecution(recent[0].id) : undefined;
		firstExecution.value = first;
		if (first) wizard.seedInputs(inputValues(readAiNodeInputOf(first)));
		probeComplete.value = true;
		const pending = wizard.pendingSeedExecution;
		if (pending) {
			wizard.setPendingSeedExecution(null);
			createCaseFromExecution(pending);
			return;
		}
		await loadResults();
	}

	async function loadExecution(id: string) {
		try {
			return await executionsStore.fetchExecution(id);
		} catch {
			return undefined;
		}
	}

	const readAiNodeInputOf = (execution: IExecutionResponse) =>
		readAiNodeInput(execution.data?.resultData?.runData, connections.value, wizard.aiNodeName);

	// #endregion

	// #region New cases

	function createCaseFromExecution(execution: IExecutionResponse) {
		telemetry.track('User created evaluation test case', {
			execution_id: execution.id,
			source: 'execution',
			workflow_id: workflowId.value,
		});
		wizard.setPrefillInputsFromExecution(true);
		wizard.setSeedExecution(execution);
		wizard.openDetail(null);
		wizard.seedInputs(inputValues(readAiNodeInputOf(execution)));
		const output =
			execution.data?.resultData?.runData?.[wizard.aiNodeName]?.at(-1)?.data?.main?.[0]?.[0]?.json;
		const answer = isRecord(output) ? output : undefined;
		wizard.expectedValues = Object.fromEntries(
			expectedFields.value
				.filter((field) => field === 'expectedAnswer')
				.map((field) => [field, answer ? answerText(answer) : '']),
		);
	}

	/** Tests another AI node of the workflow. */
	function selectAiNode(name: string) {
		wizard.setAiNodeName(name);
		wizard.exitSliceMode();
		if (firstExecution.value) {
			wizard.seedInputs(inputValues(readAiNodeInputOf(firstExecution.value)));
		}
		scheduleSave();
	}

	async function useExecution(id: string) {
		const execution = await loadExecution(id);
		if (!execution) {
			toast.showError(new Error(id), i18n.baseText('evaluations.tests.seedFromExecution.error'));
			return;
		}
		createCaseFromExecution(execution);
	}

	async function createManually() {
		wizard.setPrefillInputsFromExecution(false);
		const recent = await fetchRecentExecutions().catch(() => []);
		const first = recent[0] ? await loadExecution(recent[0].id) : undefined;
		wizard.setSeedExecution(first ?? null);
		wizard.openDetail(null);
		wizard.seedInputs({});
		telemetry.track('User created evaluation test case', {
			source: 'manual',
			workflow_id: workflowId.value,
		});
	}

	async function openCreate() {
		wizard.openCreate();
		await fetchRecentExecutions().catch(() => []);
	}

	async function openList() {
		wizard.openList();
		await loadResults().catch(() => undefined);
	}

	// #endregion

	// #region Saves

	/** Edits since the user opened a new case. A new case without edits is not saved. */
	let draftEdits = 0;

	function configPayload(dataTableId: string) {
		return buildEvaluationConfig({
			workflowName: workflowName.value,
			dataTableId,
			aiNodeName: wizard.aiNodeName,
			triggerName: graph.value.trigger,
			startNodeName: wizard.isSliceMode ? wizard.startNodeName : graph.value.start,
			inputFields: inputFields.value,
			metricKeys: wizard.selectedMetricKeys,
			judgeSelectionByMetric: wizard.judgeSelectionByMetric,
			customChecks: wizard.customChecks,
		});
	}

	function requireContext() {
		if (!projectId.value || !workflowId.value) {
			throw new Error('Missing project or workflow context');
		}
		return projectId.value;
	}

	/** Finds the dataset of the workflow, or makes it, and adds the missing columns. */
	async function ensureTable(project: string): Promise<DataTable> {
		const columns = requiredColumns(inputFields.value, wizard.selectedMetricKeys);
		const name = getCanonicalEvaluationName(workflowName.value);
		const { data } = await fetchDataTablesApi(
			rootStore.restApiContext,
			project,
			{ skip: 0, take: 100 },
			{ name, projectId: project },
		);
		const table = data.find((item) => item.name === name);
		if (!table) {
			return await createDataTableApi(
				rootStore.restApiContext,
				name,
				project,
				columns.map((column) => ({ name: column, type: 'string' as const })),
			);
		}
		const existing = new Set(table.columns.map((column) => column.name));
		for (const column of columns.filter((item) => !existing.has(item))) {
			await addDataTableColumnApi(rootStore.restApiContext, table.id, project, {
				name: column,
				type: 'string',
			});
		}
		return table;
	}

	function rowData() {
		return {
			...Object.fromEntries(inputFields.value.map((field) => [field, wizard.inputs[field] ?? ''])),
			...Object.fromEntries(
				expectedFields.value.map((field) => [field, wizard.expectedValues[field] ?? '']),
			),
			[TEST_CASE_NAME_COLUMN]: wizard.caseName,
		};
	}

	/** Saves the case that the user edits: a new row, or the changes of its row. */
	async function saveRow(project: string, table: DataTable) {
		const index = wizard.activeRowIndex;
		if (index === null) {
			const { count } = await getDataTableRowsApi(rootStore.restApiContext, table.id, project, {
				take: 1,
			});
			const [row] = await insertDataTableRowApi(
				rootStore.restApiContext,
				table.id,
				rowData(),
				project,
			);
			const id = typeof row?.id === 'number' ? row.id : null;
			wizard.setActiveRow(count, id);
			return;
		}
		const { data } = await getDataTableRowsApi(rootStore.restApiContext, table.id, project, {
			skip: index,
			take: 1,
		});
		const id = data[0]?.id;
		if (typeof id !== 'number') return;
		wizard.setActiveRow(index, id);
		await updateDataTableRowsApi(rootStore.restApiContext, table.id, id, rowData(), project);
	}

	/** Saves the config of the dataset: a new config, or the changes of the config. */
	async function saveConfig(table: DataTable, payload = configPayload(table.id)) {
		const configs = await evaluationStore.fetchEvaluationConfigs(workflowId.value);
		const existing = configs.find(
			(config) => config.datasetSource === 'data_table' && dataTableIdOf(config) === table.id,
		);
		savedConfig.value = existing
			? await evaluationStore.updateEvaluationConfig(workflowId.value, existing.id, payload)
			: await evaluationStore.createEvaluationConfig(workflowId.value, payload);
		return savedConfig.value;
	}

	/** Saves the dataset, the case that the user edits and the config. */
	async function persist(withRow: boolean) {
		const project = requireContext();
		configPayload('');
		const table = await ensureTable(project);
		if (withRow) await saveRow(project, table);
		return await saveConfig(table);
	}

	// A change of a case and a change of the checks each wait for their own pause. A load of
	// the saved setup saves with the checks.
	let configSaveTimer: ReturnType<typeof setTimeout> | undefined;
	let caseSaveTimer: ReturnType<typeof setTimeout> | undefined;

	/** Saves the dataset and the config after a pause. */
	function scheduleSave() {
		clearTimeout(configSaveTimer);
		configSaveTimer = setTimeout(() => {
			void autoSave(false);
		}, AUTO_SAVE_DELAY_MS);
	}

	/** Saves the case that the user edits, the dataset and the config after a pause. */
	function scheduleCaseSave() {
		clearTimeout(caseSaveTimer);
		caseSaveTimer = setTimeout(() => {
			void autoSave(true);
		}, AUTO_SAVE_DELAY_MS);
	}

	async function autoSave(withCase: boolean) {
		if (!wizard.aiNodeName) return;
		const saveRow =
			withCase &&
			wizard.viewMode === 'detail' &&
			(wizard.activeRowIndex !== null || draftEdits > 0);
		try {
			await persist(saveRow);
		} catch {
			// The next change or run saves again and shows the error.
		}
	}

	watch(
		() => wizard.caseEditVersion,
		() => {
			if (wizard.viewMode !== 'detail') return;
			if (wizard.activeRowIndex === null) draftEdits++;
			scheduleCaseSave();
		},
	);

	watch(() => wizard.configEditVersion, scheduleSave);

	watch(
		() => [wizard.viewMode, wizard.activeRowIndex] as const,
		([mode, index]) => {
			if (mode !== 'detail' || index === null) draftEdits = 0;
		},
	);

	// #endregion

	// #region Runs

	async function run() {
		const isNewCase = wizard.activeRowIndex === null;
		let config: EvaluationConfig;
		try {
			config = await persist(true);
		} catch (error) {
			toast.showError(error, i18n.baseText('evaluations.tests.persistError'));
			return false;
		}
		const rowIndex = wizard.activeRowIndex ?? 0;
		try {
			const { testRunId } = await evaluationStore.startTestRun(workflowId.value, {
				compileFromConfig: true,
				evaluationConfigId: config.id,
				rowIndices: [rowIndex],
			});
			telemetry.track('User ran evaluation', {
				custom_check_count: wizard.customChecks.length,
				is_new_case: isNewCase,
				metric_count: wizard.selectedMetricKeys.length,
				row_index: rowIndex,
				run_id: testRunId,
				slice_mode: wizard.isSliceMode,
				trigger: isNewCase ? 'initial' : 'run_again',
				workflow_id: workflowId.value,
			});
			wizard.setActiveRunId(testRunId);
			await evaluationStore.fetchTestRuns(workflowId.value);
			return true;
		} catch (error) {
			toast.showError(error, i18n.baseText('evaluations.tests.dispatchError'));
			return false;
		}
	}

	async function runAll() {
		try {
			const project = requireContext();
			const table = await ensureTable(project);
			await saveConfig(table);
			const config = pickConfig(await evaluationStore.fetchEvaluationConfigs(workflowId.value));
			if (!config) return;
			const { testRunId } = await evaluationStore.startTestRun(workflowId.value, {
				compileFromConfig: true,
				evaluationConfigId: config.id,
			});
			telemetry.track('User ran evaluation', {
				run_id: testRunId,
				trigger: 'run_all',
				workflow_id: workflowId.value,
			});
			wizard.setActiveRunId(testRunId);
			await evaluationStore.fetchTestRuns(workflowId.value);
			await evaluationStore.fetchTestRuns(workflowId.value);
		} catch (error) {
			toast.showError(error, i18n.baseText('evaluations.tests.runAll.error'));
		}
	}

	async function deleteCase() {
		const index = wizard.activeRowIndex;
		if (index === null) {
			await openList();
			return;
		}
		try {
			const project = requireContext();
			const config = pickConfig(await evaluationStore.fetchEvaluationConfigs(workflowId.value));
			if (!config) return;
			const tableId = dataTableIdOf(config);
			const { data } = await getDataTableRowsApi(rootStore.restApiContext, tableId, project, {
				skip: index,
				take: 1,
			});
			const id = data[0]?.id;
			if (typeof id === 'number') {
				await deleteDataTableRowsApi(rootStore.restApiContext, tableId, [id], project);
			}
			telemetry.track('User deleted evaluation test case', {
				row_index: index,
				workflow_id: workflowId.value,
			});
		} catch (error) {
			toast.showError(error, i18n.baseText('evaluations.tests.persistError'));
			return;
		}
		await openList();
	}

	// #endregion

	// #region Results

	const runs = computed(() =>
		indexTestRuns(evaluationStore.testRunsByWorkflowId[workflowId.value] ?? []),
	);
	const activeRun = computed(() => runs.value.find((item) => item.id === wizard.activeRunId));
	const activeRunIsRunning = computed(() => !!activeRun.value && isActiveRun(activeRun.value));
	const activeRunCases = computed<TestCaseExecutionRecord[]>(() =>
		Object.values(evaluationStore.testCaseExecutionsById).filter(
			(testCase) => testCase.testRunId === wizard.activeRunId,
		),
	);

	/** The case of a row in the active run. */
	const caseOfRow = (rowIndex: number) =>
		activeRunCases.value.find((testCase) => (testCase.runIndex ?? 0) === rowIndex);

	// #endregion

	onBeforeUnmount(() => {
		clearTimeout(configSaveTimer);
		clearTimeout(caseSaveTimer);
	});

	return {
		probeComplete,
		executions,
		caseExecutions,
		savedConfig,
		hasSavedSetup,
		workflowId,
		hasNodes,
		inputFields,
		expectedFields,
		aiRootNodes,
		activeRun,
		activeRunIsRunning,
		caseOfRow,
		probe,
		ensureAiNode,
		selectAiNode,
		openCreate,
		openList,
		useExecution,
		createManually,
		loadCaseExecution,
		run,
		runAll,
		deleteCase,
		readAiNodeInputOf,
	};
}

export type TestsPanelContext = ReturnType<typeof useTestsPanel>;
