import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { EvaluationConfig, TestCaseExecution, TestRun, User } from '@n8n/db';
import {
	EvaluationConfigRepository,
	TestCaseExecutionRepository,
	TestRunRepository,
	WorkflowHistoryRepository,
	WorkflowRepository,
} from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';
import type {
	IDataObject,
	INode,
	INodeExecutionData,
	IRun,
	IRunData,
	IWorkflowBase,
	IWorkflowExecutionDataProcess,
	IWorkflowSettings,
	JsonObject,
} from 'n8n-workflow';
import {
	createRunExecutionData,
	DEFAULT_EVALUATION_METRIC,
	EVALUATION_NODE_TYPE,
	EVALUATION_TRIGGER_NODE_TYPE,
	jsonParse,
	jsonStringify,
	ManualExecutionCancelledError,
	metricRequiresModelConnection,
	NodeConnectionTypes,
} from 'n8n-workflow';
import pLimit from 'p-limit';

import { ActiveExecutions } from '@/active-executions';
import { ConcurrencyControlService } from '@/concurrency/concurrency-control.service';
import {
	getEvaluationConcurrencyLimitSource,
	resolveEvaluationConcurrencyLimit,
} from '@/evaluation/evaluation-concurrency.helper';
import { License } from '@/license';
import { Publisher } from '@/scaling/pubsub/publisher.service';
import type { PubSub } from '@/scaling/pubsub/pubsub.types';
import { Telemetry } from '@/telemetry';
import { WorkflowRunner } from '@/workflow-runner';

import { TestCaseExecutionError, TestRunError } from './errors';
import type { CaseMetrics } from './evaluation-metrics';
import { EvaluationMetrics } from './evaluation-metrics';
import { checkNodeParameterNotEmpty, extractTokenUsage } from './utils';
import { WorkflowCompilerService } from './workflow-compiler.service';

/** Where a test run was started. Telemetry reports it as `via`. */
export type TestRunVia = 'ui' | 'public-api' | (string & {});

export interface StartTestRunOptions {
	/** The evaluation config of the run. The run keeps it as `evaluationConfigId`. */
	evaluationConfigId?: string;
	/** Run the workflow that the config compiles, not the saved workflow. */
	compileFromConfig?: boolean;
	/** Run only the dataset rows at these 0-based indices. Empty or not given: all rows. */
	rowIndices?: number[];
	via?: TestRunVia;
	/** The collection of the run, and the version of the workflow that it runs. */
	collectionId?: string;
	workflowVersionId?: string;
}

/** The settings of the execution that reads the dataset: it is not kept. */
const DATASET_READ_SETTINGS: IWorkflowSettings = {
	saveManualExecutions: false,
	saveDataErrorExecution: 'none',
	saveDataSuccessExecution: 'none',
	saveExecutionProgress: false,
};

/** The settings of the execution of a case: the user can open it from the results. */
const CASE_SETTINGS: IWorkflowSettings = {
	saveManualExecutions: true,
	saveDataErrorExecution: 'all',
	saveDataSuccessExecution: 'all',
	saveExecutionProgress: false,
};

type RunContext = {
	testRun: TestRun;
	user: User;
	workflow: IWorkflowBase;
	trigger: INode;
	/** The end node of a compiled run. Its output is the output of a case. */
	endNodeName?: string;
	signal: AbortSignal;
	metrics: EvaluationMetrics;
	stats: RunStats;
};

type RunStats = {
	testCaseCount: number;
	casesStarted: number;
	inFlight: number;
	peakInFlight: number;
	erroredCases: number;
	metricCount: number;
};

/** Gives a value that the JSON columns can keep: dates become text. */
function toJsonObject(value: IDataObject | undefined): JsonObject {
	if (!value) return {};
	return jsonParse<JsonObject>(jsonStringify(value));
}

function isMetricValue(value: unknown): value is number | boolean {
	return (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean';
}

/** The first output item of each run of a node. */
function firstItems(runData: IRunData, nodeName: string): INodeExecutionData[] {
	return (runData[nodeName] ?? []).flatMap((task) => {
		const item = task.data?.main?.[0]?.[0];
		return item ? [item] : [];
	});
}

/**
 * Fork code (not in upstream n8n): runs the evaluation of a workflow over the rows of its dataset.
 * It reads all rows with the Evaluation Trigger, then runs the workflow once for each row with
 * the row as the pinned output of the trigger, and keeps the metrics of the Evaluation nodes. It
 * replaces the enterprise test runner. See `../FORK.md`.
 */
@Service()
export class TestRunnerService {
	/** The runs of this instance that are not finished, by run ID. */
	private readonly abortControllers = new Map<string, AbortController>();

	/** The executions of the cases that run now, by run ID. */
	private readonly runningExecutions = new Map<string, Set<string>>();

	/** The collection of each run of this instance that is not finished. */
	private readonly collectionOfRun = new Map<string, string>();

	constructor(
		private readonly logger: Logger,
		private readonly telemetry: Telemetry,
		private readonly workflowRepository: WorkflowRepository,
		private readonly workflowHistoryRepository: WorkflowHistoryRepository,
		private readonly workflowRunner: WorkflowRunner,
		private readonly activeExecutions: ActiveExecutions,
		private readonly testRunRepository: TestRunRepository,
		private readonly testCaseExecutionRepository: TestCaseExecutionRepository,
		private readonly evaluationConfigRepository: EvaluationConfigRepository,
		private readonly workflowCompiler: WorkflowCompilerService,
		private readonly concurrencyControl: ConcurrencyControlService,
		private readonly globalConfig: GlobalConfig,
		private readonly license: License,
		private readonly instanceSettings: InstanceSettings,
		private readonly publisher: Publisher,
	) {}

	static getEvaluationNodes(workflow: IWorkflowBase): INode[] {
		return workflow.nodes.filter((node) => node.type === EVALUATION_NODE_TYPE && !node.disabled);
	}

	static getEvaluationMetricsNodes(workflow: IWorkflowBase): INode[] {
		return TestRunnerService.getEvaluationNodes(workflow).filter(
			(node) => node.parameters.operation === 'setMetrics',
		);
	}

	static getEvaluationSetOutputsNodes(workflow: IWorkflowBase): INode[] {
		return TestRunnerService.getEvaluationNodes(workflow).filter(
			(node) => (node.parameters.operation ?? 'setOutputs') === 'setOutputs',
		);
	}

	static getEvaluationSetInputsNodes(workflow: IWorkflowBase): INode[] {
		return TestRunnerService.getEvaluationNodes(workflow).filter(
			(node) => node.parameters.operation === 'setInputs',
		);
	}

	/**
	 * Creates a run and starts it in the background. `finished` settles when the run ends, and
	 * it never rejects: an error ends the run with an error code.
	 */
	async startTestRun(
		user: User,
		workflowId: string,
		concurrency = 1,
		options: StartTestRunOptions = {},
	): Promise<{ testRun: TestRun; finished: Promise<void> }> {
		const compile = options.compileFromConfig === true && options.evaluationConfigId !== undefined;
		const config =
			compile && options.evaluationConfigId !== undefined
				? await this.evaluationConfigRepository.findByIdAndWorkflowId(
						options.evaluationConfigId,
						workflowId,
					)
				: null;

		const testRun = await this.testRunRepository.createTestRun(workflowId, {
			evaluationConfigId: options.evaluationConfigId ?? null,
			evaluationConfigSnapshot: config ? this.toConfigSnapshot(config) : null,
			workflowVersionId: options.workflowVersionId ?? null,
			collectionId: options.collectionId ?? null,
		});

		const finished = this.runTest(
			user,
			testRun,
			concurrency,
			options,
			compile ? config : undefined,
		);
		return { testRun, finished };
	}

	/** `true` when the run can NOT be cancelled: it has ended. Uses no state of the service. */
	canBeCancelled(testRun: Pick<TestRun, 'status'>): boolean {
		return testRun.status !== 'new' && testRun.status !== 'running';
	}

	/**
	 * Cancels a run. A run of this instance stops its cases, and ends as `cancelled`. Any other
	 * run gets the cancellation flag and ends as `cancelled` at once, with its pending cases. In
	 * multi-main mode, the main instance that runs it gets the command `cancel-test-run`, and
	 * stops its cases at once.
	 */
	async cancelTestRun(testRunId: string) {
		if (this.cancelTestRunLocally(testRunId)) return;

		await this.markAsCancelled(testRunId);
		await this.publishToOtherMains({ command: 'cancel-test-run', payload: { testRunId } });
	}

	/**
	 * Cancels the runs of a collection. The runs of this instance stop, and the other runs end at
	 * once. In multi-main mode, the other main instances get the command `cancel-collection`.
	 */
	async cancelCollection(collectionId: string, testRunIds: string[]) {
		this.cancelCollectionLocally(collectionId);
		for (const testRunId of testRunIds) {
			if (this.abortControllers.has(testRunId)) continue;
			const testRun = await this.testRunRepository.findOneBy({ id: testRunId });
			if (testRun && !this.canBeCancelled(testRun)) await this.markAsCancelled(testRunId);
		}
		await this.publishToOtherMains({ command: 'cancel-collection', payload: { collectionId } });
	}

	/** Ends a run of another instance as `cancelled`, with its pending cases. */
	private async markAsCancelled(testRunId: string) {
		await this.testRunRepository.requestCancellation(testRunId);
		await this.testRunRepository.markAsCancelled(testRunId);
		await this.testCaseExecutionRepository.markAllPendingAsCancelled(testRunId);
	}

	private async publishToOtherMains(command: PubSub.Command) {
		if (!this.instanceSettings.isMultiMain) return;
		await this.publisher.publishCommand(command);
	}

	/** Gives `true` when this instance runs the run, and stops it. */
	cancelTestRunLocally(testRunId: string): boolean {
		const abortController = this.abortControllers.get(testRunId);
		if (!abortController) return false;

		abortController.abort();
		for (const executionId of this.runningExecutions.get(testRunId) ?? []) {
			this.activeExecutions.stopExecution(
				executionId,
				new ManualExecutionCancelledError(executionId),
			);
		}
		return true;
	}

	cancelCollectionLocally(collectionId: string) {
		for (const [testRunId, runCollectionId] of this.collectionOfRun) {
			if (runCollectionId === collectionId) this.cancelTestRunLocally(testRunId);
		}
	}

	@OnPubSubEvent('cancel-test-run', { instanceType: 'main' })
	handleCancelTestRunCommand({ testRunId }: { testRunId: string }) {
		this.cancelTestRunLocally(testRunId);
	}

	@OnPubSubEvent('cancel-collection', { instanceType: 'main' })
	handleCancelCollectionCommand({ collectionId }: { collectionId: string }) {
		this.cancelCollectionLocally(collectionId);
	}

	private toConfigSnapshot(config: EvaluationConfig): IDataObject {
		return {
			id: config.id,
			workflowId: config.workflowId,
			name: config.name,
			status: config.status,
			invalidReason: config.invalidReason,
			datasetSource: config.datasetSource,
			datasetRef: config.datasetRef,
			startNodeName: config.startNodeName,
			endNodeName: config.endNodeName,
			metrics: config.metrics,
			createdAt: config.createdAt,
			updatedAt: config.updatedAt,
		};
	}

	private async runTest(
		user: User,
		testRun: TestRun,
		concurrency: number,
		options: StartTestRunOptions,
		config: EvaluationConfig | null | undefined,
	): Promise<void> {
		const startedAt = Date.now();
		const abortController = new AbortController();
		this.abortControllers.set(testRun.id, abortController);
		if (testRun.collectionId) this.collectionOfRun.set(testRun.id, testRun.collectionId);

		const executionsConfig = this.globalConfig.executions;
		const limit = resolveEvaluationConcurrencyLimit(executionsConfig, this.license);
		const requested = Math.max(1, concurrency);
		const effective = limit > 0 ? Math.min(requested, limit) : requested;
		const runType = config !== undefined || testRun.collectionId ? 'config' : 'direct';
		const via = options.via ?? 'ui';
		const stats: RunStats = {
			testCaseCount: 0,
			casesStarted: 0,
			inFlight: 0,
			peakInFlight: 0,
			erroredCases: 0,
			metricCount: 0,
		};
		let status: 'success' | 'fail' | 'cancelled' = 'success';
		let errorMessage = '';

		try {
			await this.testRunRepository.markAsRunning(testRun.id, this.instanceSettings.hostId);

			const saved = await this.loadWorkflow(testRun.workflowId, options.workflowVersionId);
			let workflow = saved;
			let endNodeName: string | undefined;
			if (config !== undefined) {
				if (config === null) throw new TestRunError('EVALUATION_CONFIG_NOT_FOUND');
				workflow = await this.workflowCompiler.compile(saved, config);
				endNodeName = config.endNodeName;
			}
			const trigger = this.validateWorkflowConfiguration(workflow);

			this.telemetry.track('User ran test', {
				user_id: user.id,
				run_id: testRun.id,
				workflow_id: testRun.workflowId,
				run_type: runType,
				via,
			});

			const rows = await this.runDatasetTrigger(workflow, trigger, user);
			if (rows.length === 0) throw new TestRunError('TEST_CASES_NOT_FOUND');
			const selected = this.selectRows(rows, options.rowIndices);
			stats.testCaseCount = selected.length;

			const cases = await this.testCaseExecutionRepository.createPendingBatch(
				testRun.id,
				selected.map(({ index, row }) => ({ runIndex: index, inputs: toJsonObject(row.json) })),
			);

			const context: RunContext = {
				testRun,
				user,
				workflow,
				trigger,
				endNodeName,
				signal: abortController.signal,
				metrics: new EvaluationMetrics(),
				stats,
			};
			const limitCases = pLimit(effective);
			await Promise.allSettled(
				cases.map(
					async (testCase, position) =>
						await limitCases(
							async () => await this.runCase(context, testCase, selected[position].row),
						),
				),
			);

			if (abortController.signal.aborted) {
				await this.testCaseExecutionRepository.markAllPendingAsCancelled(testRun.id);
				await this.testRunRepository.markAsCancelled(testRun.id);
				status = 'cancelled';
			} else {
				const aggregated = context.metrics.getAggregatedMetrics();
				stats.metricCount = Object.keys(aggregated).length;
				await this.testRunRepository.markAsCompleted(testRun.id, aggregated);
			}
		} catch (error) {
			status = 'fail';
			errorMessage = await this.failRun(testRun.id, error);
		} finally {
			this.abortControllers.delete(testRun.id);
			this.runningExecutions.delete(testRun.id);
			this.collectionOfRun.delete(testRun.id);
			try {
				await this.testRunRepository.clearInstanceTracking(testRun.id);
			} catch (error) {
				this.logger.error('Could not clear the instance of a test run', {
					testRunId: testRun.id,
					error,
				});
			}
			this.telemetry.track('Test run finished', {
				run_id: testRun.id,
				workflow_id: testRun.workflowId,
				run_type: runType,
				via,
				test_type: 'evaluation',
				status,
				error_message: errorMessage,
				start: startedAt,
				duration: Date.now() - startedAt,
				test_case_count: stats.testCaseCount,
				cases_started: stats.casesStarted,
				errored_test_case_count: stats.erroredCases,
				metric_count: stats.metricCount,
				concurrency: effective,
				parallel_enabled: effective > 1,
				peak_in_flight: stats.peakInFlight,
				concurrency_limit_source: getEvaluationConcurrencyLimitSource(executionsConfig),
				concurrency_limited_by_config: limit > 0 && requested > limit,
				collection_id: testRun.collectionId ?? null,
				is_part_of_collection: Boolean(testRun.collectionId),
			});
		}
	}

	/** Marks the run as failed. Gives the message for telemetry. */
	private async failRun(testRunId: string, error: unknown): Promise<string> {
		const known = error instanceof TestRunError;
		try {
			if (known) await this.testRunRepository.markAsError(testRunId, error.code, error.extra);
			else await this.testRunRepository.markAsError(testRunId, 'UNKNOWN_ERROR');
		} catch (markError) {
			this.logger.error('Could not mark a test run as failed', { testRunId, error: markError });
		}
		if (known) {
			const message = error.extra.message;
			return typeof message === 'string' ? `${error.code}: ${message}` : error.code;
		}
		this.logger.error('A test run failed', { testRunId, error });
		return error instanceof Error ? error.message : String(error);
	}

	/**
	 * The saved workflow, or the version of the history that a collection run pins. A pin to the
	 * version of the saved workflow runs the saved workflow.
	 */
	private async loadWorkflow(workflowId: string, versionId?: string): Promise<IWorkflowBase> {
		const workflow = await this.workflowRepository.findOneBy({ id: workflowId });
		if (!workflow) throw new TestRunError('UNKNOWN_ERROR', { message: 'Workflow not found' });
		if (!versionId || versionId === workflow.versionId) return workflow;

		const version = await this.workflowHistoryRepository.findOneBy({ workflowId, versionId });
		if (!version) {
			throw new TestRunError('UNKNOWN_ERROR', {
				message: `Workflow version ${versionId} not found`,
			});
		}
		return { ...workflow, nodes: version.nodes, connections: version.connections };
	}

	/** The checks before a run. Gives the Evaluation Trigger. */
	validateWorkflowConfiguration(workflow: IWorkflowBase): INode {
		const trigger = this.findEvaluationTriggerNode(workflow);
		if (!trigger) throw new TestRunError('EVALUATION_TRIGGER_NOT_FOUND');
		this.validateEvaluationTriggerNode(trigger);
		this.validateSetMetricsNodes(workflow);
		this.validateSetOutputsNodes(workflow);
		return trigger;
	}

	findEvaluationTriggerNode(workflow: IWorkflowBase): INode | undefined {
		return workflow.nodes.find((node) => node.type === EVALUATION_TRIGGER_NODE_TYPE);
	}

	validateEvaluationTriggerNode(trigger: INode) {
		if (trigger.disabled) throw new TestRunError('EVALUATION_TRIGGER_DISABLED');
		const source =
			trigger.parameters.source ?? (trigger.typeVersion >= 4.7 ? 'dataTable' : 'googleSheets');
		if (source !== 'googleSheets') return;
		const sheet = trigger.parameters.sheetName;
		const document = trigger.parameters.documentId;
		const value = (locator: unknown) =>
			typeof locator === 'object' && locator !== null && 'value' in locator
				? locator.value
				: locator;
		if (!checkNodeParameterNotEmpty(value(document)) || !checkNodeParameterNotEmpty(value(sheet))) {
			throw new TestRunError('EVALUATION_TRIGGER_NOT_CONFIGURED', { node_name: trigger.name });
		}
	}

	validateSetMetricsNodes(workflow: IWorkflowBase) {
		const metricsNodes = TestRunnerService.getEvaluationMetricsNodes(workflow);
		if (metricsNodes.length === 0) throw new TestRunError('SET_METRICS_NODE_NOT_FOUND');

		for (const node of metricsNodes) {
			const metric =
				typeof node.parameters.metric === 'string'
					? node.parameters.metric
					: node.typeVersion < 4.7
						? 'customMetrics'
						: DEFAULT_EVALUATION_METRIC;
			const configured =
				metric === 'customMetrics'
					? this.hasCustomMetrics(node)
					: !metricRequiresModelConnection(metric) ||
						this.hasModelNodeConnected(workflow, node.name);
			if (!configured) {
				throw new TestRunError('SET_METRICS_NODE_NOT_CONFIGURED', { node_name: node.name });
			}
		}
	}

	validateSetOutputsNodes(workflow: IWorkflowBase) {
		for (const node of TestRunnerService.getEvaluationSetOutputsNodes(workflow)) {
			if (!checkNodeParameterNotEmpty(node.parameters.outputs)) {
				throw new TestRunError('SET_OUTPUTS_NODE_NOT_CONFIGURED', { node_name: node.name });
			}
		}
	}

	private hasCustomMetrics(node: INode): boolean {
		const metrics = node.parameters.metrics;
		if (typeof metrics !== 'object' || metrics === null || !('assignments' in metrics))
			return false;
		const { assignments } = metrics;
		return (
			Array.isArray(assignments) &&
			assignments.length > 0 &&
			assignments.every(
				(assignment: unknown) =>
					typeof assignment === 'object' &&
					assignment !== null &&
					'name' in assignment &&
					checkNodeParameterNotEmpty(assignment.name) &&
					'value' in assignment &&
					checkNodeParameterNotEmpty(assignment.value),
			)
		);
	}

	/** `true` when a chat model sub-node is connected to the node. */
	hasModelNodeConnected(workflow: IWorkflowBase, nodeName: string): boolean {
		return Object.values(workflow.connections).some((outputs) =>
			(outputs[NodeConnectionTypes.AiLanguageModel] ?? []).some((branch) =>
				(branch ?? []).some((connection) => connection.node === nodeName),
			),
		);
	}

	/**
	 * Reads all rows of the dataset: the Evaluation Trigger runs its `getRows` operation in a
	 * manual execution that n8n does not keep.
	 */
	private async runDatasetTrigger(
		workflow: IWorkflowBase,
		trigger: INode,
		user: User,
	): Promise<INodeExecutionData[]> {
		const datasetTrigger: INode = {
			...trigger,
			forceCustomOperation: { resource: 'dataset', operation: 'getRows' },
		};
		const data: IWorkflowExecutionDataProcess = {
			executionMode: 'manual',
			workflowData: {
				...workflow,
				nodes: workflow.nodes.map((node) => (node.name === trigger.name ? datasetTrigger : node)),
				settings: { ...workflow.settings, ...DATASET_READ_SETTINGS },
			},
			userId: user.id,
			executionData: createRunExecutionData({
				startData: { destinationNode: { nodeName: trigger.name, mode: 'inclusive' } },
				resultData: { runData: {} },
				executionData: {
					nodeExecutionStack: [
						{ node: datasetTrigger, data: { main: [[{ json: {} }]] }, source: null },
					],
				},
			}),
		};

		const executionId = await this.workflowRunner.run(data);
		const run = await this.activeExecutions.getPostExecutePromise(executionId);
		// Only the run of the trigger counts. A workflow that cannot start, for example because a
		// node has issues, gives the trigger no run.
		const triggerRun = run?.data.resultData.runData[trigger.name]?.[0];
		if (triggerRun?.error) {
			throw new TestRunError('CANT_FETCH_TEST_CASES', { message: triggerRun.error.message });
		}
		const rows = triggerRun?.data?.main?.[0];
		if (!rows) {
			throw new TestRunError('CANT_FETCH_TEST_CASES', {
				message: 'Evaluation trigger node did not produce any output',
			});
		}
		return rows;
	}

	private selectRows(rows: INodeExecutionData[], rowIndices: number[] | undefined) {
		const all = rows.map((row, index) => ({ index, row }));
		if (!rowIndices || rowIndices.length === 0) return all;
		const wanted = new Set(rowIndices);
		return all.filter(({ index }) => wanted.has(index));
	}

	/** Runs one case: waits for a slot of the evaluation queue, runs the workflow, keeps the result. */
	private async runCase(context: RunContext, testCase: TestCaseExecution, row: INodeExecutionData) {
		const { testRun, signal, stats } = context;
		if (signal.aborted) return;
		if (await this.testRunRepository.isCancellationRequested(testRun.id)) {
			this.cancelTestRunLocally(testRun.id);
			return;
		}

		const slotId = `evaluation:${testRun.id}-case-${testCase.runIndex ?? 0}`;
		if (!(await this.acquireEvaluationSlot(slotId, signal))) return;

		try {
			if (signal.aborted) return;
			// A user can cancel a case before it starts.
			if (!(await this.testCaseExecutionRepository.tryMarkCaseAsRunning(testCase.id))) return;

			stats.casesStarted++;
			stats.inFlight++;
			stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
			try {
				await this.executeCase(context, testCase, row);
			} finally {
				stats.inFlight--;
			}
		} finally {
			this.concurrencyControl.release({ mode: 'evaluation' });
		}
	}

	private async executeCase(
		context: RunContext,
		testCase: TestCaseExecution,
		row: INodeExecutionData,
	) {
		const { testRun, user, workflow, trigger, metrics, stats } = context;
		let executionId: string | undefined;
		try {
			executionId = await this.workflowRunner.run({
				executionMode: 'evaluation',
				workflowData: { ...workflow, settings: { ...workflow.settings, ...CASE_SETTINGS } },
				userId: user.id,
				pinData: { [trigger.name]: [{ json: row.json, pairedItem: { item: 0 } }] },
				triggerToStartFrom: { name: trigger.name },
				evaluationRunId: testRun.id,
			});
			this.trackExecution(testRun.id, executionId);
			const run = await this.activeExecutions.getPostExecutePromise(executionId);
			this.untrackExecution(testRun.id, executionId);

			if (!run || run.data.resultData.error) {
				stats.erroredCases++;
				await this.testCaseExecutionRepository.markAsFailed({
					id: testCase.id,
					errorCode: 'FAILED_TO_EXECUTE_WORKFLOW',
					executionId,
					metrics: {},
				});
				return;
			}

			const runData = run.data.resultData.runData;
			const predefined = metrics.addResults(this.extractPredefinedMetrics(run));
			try {
				const userDefined = metrics.addResults(this.extractUserDefinedMetrics(runData, workflow));
				await this.testCaseExecutionRepository.markAsCompleted({
					id: testCase.id,
					executionId,
					metrics: { ...userDefined, ...predefined },
					inputs: this.resolveCaseInputs(context, runData, row),
					outputs: this.resolveCaseOutputs(context, runData),
				});
			} catch (error) {
				if (!(error instanceof TestCaseExecutionError)) throw error;
				stats.erroredCases++;
				await this.testCaseExecutionRepository.markAsFailed({
					id: testCase.id,
					errorCode: error.code,
					executionId,
				});
			}
		} catch (error) {
			if (executionId) this.untrackExecution(testRun.id, executionId);
			this.logger.debug('A case of a test run failed', { testRunId: testRun.id, error });
			stats.erroredCases++;
			// The execution of the case is not kept on the case: it was stopped, or it never ran.
			await this.testCaseExecutionRepository.markAsFailed({
				id: testCase.id,
				errorCode: 'UNKNOWN_ERROR',
			});
		}
	}

	/**
	 * The metrics of the Set Metrics nodes that ran. A later node comes first, and on a metric name
	 * that two nodes give, the earlier node wins.
	 */
	extractUserDefinedMetrics(runData: IRunData, workflow: IWorkflowBase): CaseMetrics {
		const metricsNodes = new Set(
			TestRunnerService.getEvaluationMetricsNodes(workflow).map((node) => node.name),
		);
		let result: CaseMetrics = {};
		let collected = false;
		for (const nodeName of Object.keys(runData)) {
			if (!metricsNodes.has(nodeName)) continue;
			for (const item of firstItems(runData, nodeName)) {
				collected = true;
				const values: CaseMetrics = {};
				for (const [name, value] of Object.entries(item.json)) {
					if (!isMetricValue(value)) {
						throw new TestCaseExecutionError('INVALID_METRICS', { metricName: name });
					}
					values[name] = value;
				}
				result = { ...values, ...result };
			}
		}
		if (!collected) throw new TestCaseExecutionError('NO_METRICS_COLLECTED');
		return result;
	}

	/** The token usage of the language models and the execution time in milliseconds. */
	extractPredefinedMetrics(run: IRun): CaseMetrics {
		const usage = extractTokenUsage(run.data.resultData.runData);
		return {
			completionTokens: usage.completionTokens,
			promptTokens: usage.promptTokens,
			totalTokens: usage.totalTokens,
			executionTime: run.stoppedAt ? run.stoppedAt.getTime() - run.startedAt.getTime() : 0,
		};
	}

	/** A compiled run takes the dataset row. Any other run takes the data of Set Inputs. */
	private resolveCaseInputs(context: RunContext, runData: IRunData, row: INodeExecutionData) {
		if (context.endNodeName !== undefined) return toJsonObject(row.json);
		return this.getEvaluationData(
			runData,
			TestRunnerService.getEvaluationSetInputsNodes(context.workflow),
		);
	}

	/** A compiled run takes the output of the end node. Any other run takes the data of Set Outputs. */
	private resolveCaseOutputs(context: RunContext, runData: IRunData) {
		if (context.endNodeName !== undefined) {
			return toJsonObject(firstItems(runData, context.endNodeName)[0]?.json);
		}
		return this.getEvaluationData(
			runData,
			TestRunnerService.getEvaluationSetOutputsNodes(context.workflow),
		);
	}

	/** The `evaluationData` that Set Inputs or Set Outputs nodes put on their first item. */
	private getEvaluationData(runData: IRunData, nodes: INode[]): JsonObject {
		const data: JsonObject = {};
		for (const node of nodes) {
			for (const item of firstItems(runData, node.name)) {
				if (item.evaluationData) Object.assign(data, toJsonObject(item.evaluationData));
			}
		}
		return data;
	}

	/**
	 * Waits for a slot of the shared evaluation queue. Gives `false` when the run stops while the
	 * case waits. The caller releases a slot that it got.
	 */
	private async acquireEvaluationSlot(slotId: string, signal: AbortSignal): Promise<boolean> {
		if (signal.aborted) return false;

		let onAbort: (() => void) | undefined;
		const aborted = new Promise<'aborted'>((resolve) => {
			onAbort = () => resolve('aborted');
			signal.addEventListener('abort', onAbort, { once: true });
		});
		const acquire = this.concurrencyControl.throttle({ mode: 'evaluation', executionId: slotId });
		const outcome = await Promise.race([acquire.then((): 'acquired' => 'acquired'), aborted]);
		if (onAbort) signal.removeEventListener('abort', onAbort);

		if (outcome === 'aborted') {
			// Leave the queue, or give back a slot that came at the same time as the abort.
			this.concurrencyControl.remove({ mode: 'evaluation', executionId: slotId });
			void acquire.then(() => this.concurrencyControl.release({ mode: 'evaluation' }));
			return false;
		}
		return true;
	}

	private trackExecution(testRunId: string, executionId: string) {
		const executions = this.runningExecutions.get(testRunId) ?? new Set<string>();
		executions.add(executionId);
		this.runningExecutions.set(testRunId, executions);
	}

	private untrackExecution(testRunId: string, executionId: string) {
		this.runningExecutions.get(testRunId)?.delete(executionId);
	}
}
