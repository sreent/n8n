import type {
	CreateEvaluationCollectionPayload,
	EvalVersionEntry,
	EvalVersionsResponse,
	EvaluationCollectionDetail,
	EvaluationCollectionRecord,
	EvaluationCollectionRunSummary,
	MetricScale,
	UpdateEvaluationCollectionPayload,
} from '@n8n/api-types';
import { averageNormalizedScore, metricScalesFromConfig } from '@n8n/api-types';
import type { EvaluationCollection, EvaluationConfig, TestRun, User } from '@n8n/db';
import {
	EvaluationCollectionRepository,
	EvaluationConfigRepository,
	TestRunRepository,
	WorkflowHistoryRepository,
	WorkflowRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import { BadRequestError, ConflictError, NotFoundError } from '@n8n/errors';
import { nanoid } from 'nanoid';

import { Telemetry } from '@/telemetry';

import { runMetricScales } from './metric-scales';
import { TestRunnerService } from './test-runner/test-runner.service';

/**
 * Fork code (not in upstream n8n): collections of test runs of one evaluation config, to compare
 * versions of a workflow. Each run of a collection runs the compiled config on one version from
 * the workflow history. It replaces the enterprise service. See `FORK.md` in this folder.
 */
@Service()
export class EvaluationCollectionService {
	/** The collections that start new runs now. A second rerun waits for nothing: it fails. */
	private readonly rerunning = new Set<string>();

	constructor(
		private readonly evaluationCollectionRepository: EvaluationCollectionRepository,
		private readonly evaluationConfigRepository: EvaluationConfigRepository,
		private readonly testRunRepository: TestRunRepository,
		private readonly workflowRepository: WorkflowRepository,
		private readonly workflowHistoryRepository: WorkflowHistoryRepository,
		private readonly testRunnerService: TestRunnerService,
		private readonly telemetry: Telemetry,
	) {}

	async listCollections(workflowId: string): Promise<EvaluationCollectionRecord[]> {
		const collections = await this.evaluationCollectionRepository.listByWorkflowId(workflowId);
		return collections.map((collection) => this.toRecord(collection, collection.runCount));
	}

	async getCollectionDetail(
		workflowId: string,
		collectionId: string,
	): Promise<EvaluationCollectionDetail> {
		const detail = await this.evaluationCollectionRepository.getDetailByIdAndWorkflowId(
			collectionId,
			workflowId,
		);
		if (!detail) throw new NotFoundError('Collection not found');

		const config = await this.evaluationConfigRepository.findByIdAndWorkflowId(
			detail.collection.evaluationConfigId,
			workflowId,
		);
		const metricScales = config ? metricScalesFromConfig(config.metrics) : undefined;
		return {
			...this.toRecord(detail.collection, detail.runs.length),
			...(metricScales ? { metricScales } : {}),
			runs: detail.runs.map((run) => this.toRunSummary(run, metricScales)),
		};
	}

	/**
	 * Creates a collection. A version with `existingTestRunId` reuses that run. Any other version
	 * starts a new compiled run of the config on that version; `null` is the current draft.
	 */
	async createCollection(
		workflowId: string,
		user: User,
		payload: CreateEvaluationCollectionPayload,
	): Promise<EvaluationCollectionRecord & { runsStartedIds: string[] }> {
		const config = await this.loadConfig(workflowId, payload.evaluationConfigId);

		const existingRunIds: string[] = [];
		for (const [index, version] of payload.versions.entries()) {
			if (version.existingTestRunId === undefined) continue;
			const run = await this.testRunRepository.findOneByIdAndWorkflowId(
				version.existingTestRunId,
				workflowId,
			);
			if (!run || run.evaluationConfigId !== config.id) {
				throw new BadRequestError(
					`versions[${index}]: test run "${version.existingTestRunId}" is not compatible with this collection`,
				);
			}
			if (!run.workflowVersionId) {
				throw new BadRequestError(
					`versions[${index}]: test run "${run.id}" has no pinned workflow version and cannot be reused in a collection`,
				);
			}
			existingRunIds.push(run.id);
		}

		const collection = await this.evaluationCollectionRepository.createCollection({
			id: nanoid(),
			name: payload.name,
			description: payload.description ?? null,
			workflowId,
			evaluationConfigId: config.id,
			createdById: user.id,
		});
		await this.evaluationCollectionRepository.addRunsToCollection(collection.id, existingRunIds);

		const newVersions = payload.versions
			.filter((version) => version.existingTestRunId === undefined)
			.map((version) => version.workflowVersionId);
		const runsStartedIds = await this.startCollectionRuns(
			workflowId,
			user,
			collection.id,
			config,
			newVersions,
			payload.concurrency,
		);

		this.telemetry.track('Eval collection created', {
			user_id: user.id,
			workflow_id: workflowId,
			collection_id: collection.id,
			evaluation_config_id: config.id,
			dataset_id: this.extractDatasetId(config),
			version_count: payload.versions.length,
			new_run_count: runsStartedIds.length,
			existing_run_count: existingRunIds.length,
		});

		return {
			...this.toRecord(collection, existingRunIds.length + runsStartedIds.length),
			runsStartedIds,
		};
	}

	/** Starts a new run for the version of each run of the collection, and swaps the runs. */
	async rerunCollection(
		workflowId: string,
		collectionId: string,
		user: User,
	): Promise<EvaluationCollectionRecord & { runsStartedIds: string[] }> {
		return await this.withRerunLock(collectionId, async () => {
			const detail = await this.evaluationCollectionRepository.getDetailByIdAndWorkflowId(
				collectionId,
				workflowId,
			);
			if (!detail) throw new NotFoundError('Collection not found');
			const config = await this.loadConfig(workflowId, detail.collection.evaluationConfigId);

			const versions = detail.runs.map((run) => run.workflowVersionId);
			const runsStartedIds = await this.startCollectionRuns(
				workflowId,
				user,
				collectionId,
				config,
				versions,
			);
			await this.evaluationCollectionRepository.removeRunsFromCollection(
				collectionId,
				detail.runs.map((run) => run.id),
			);
			return { ...this.toRecord(detail.collection, runsStartedIds.length), runsStartedIds };
		});
	}

	async updateCollectionMeta(
		workflowId: string,
		collectionId: string,
		payload: UpdateEvaluationCollectionPayload,
	): Promise<EvaluationCollectionRecord> {
		const collection = await this.evaluationCollectionRepository.updateMeta(
			collectionId,
			workflowId,
			payload,
		);
		if (!collection) throw new NotFoundError('Collection not found');
		return this.toRecord(collection, await this.countRuns(collectionId));
	}

	async deleteCollection(workflowId: string, collectionId: string, user: User) {
		const { deleted, runsUnlinked } =
			await this.evaluationCollectionRepository.deleteByIdAndWorkflowId(collectionId, workflowId);
		if (!deleted) throw new NotFoundError('Collection not found');

		this.telemetry.track('Eval collection deleted', {
			user_id: user.id,
			workflow_id: workflowId,
			collection_id: collectionId,
			runs_unlinked: runsUnlinked,
		});
		return { success: true, runsUnlinked };
	}

	async addRunToCollection(
		workflowId: string,
		collectionId: string,
		testRunId: string,
	): Promise<EvaluationCollectionDetail> {
		await this.loadCollection(workflowId, collectionId);
		const run = await this.testRunRepository.findOneByIdAndWorkflowId(testRunId, workflowId);
		if (!run) throw new NotFoundError('Test run not found for this workflow');
		if (!run.workflowVersionId) {
			throw new BadRequestError(
				'Test run has no pinned workflow version and cannot be added to a collection',
			);
		}
		await this.evaluationCollectionRepository.addRunsToCollection(collectionId, [run.id]);
		return await this.getCollectionDetail(workflowId, collectionId);
	}

	async removeRunFromCollection(
		workflowId: string,
		collectionId: string,
		testRunId: string,
	): Promise<EvaluationCollectionDetail> {
		await this.loadCollection(workflowId, collectionId);
		const removed = await this.evaluationCollectionRepository.removeRunFromCollection(
			collectionId,
			testRunId,
		);
		if (removed === 0) throw new NotFoundError('Test run is not part of this collection');
		return await this.getCollectionDetail(workflowId, collectionId);
	}

	/**
	 * The versions that a collection can compare: the current draft first, then the versions of
	 * the workflow history, newest first, each with its last run of the config.
	 */
	async getEvalVersions(
		workflowId: string,
		evaluationConfigId: string,
	): Promise<EvalVersionsResponse> {
		const config = await this.loadConfig(workflowId, evaluationConfigId);
		const history = await this.workflowHistoryRepository.find({
			where: { workflowId },
			order: { createdAt: 'DESC' },
		});
		const scales = metricScalesFromConfig(config.metrics);
		const runs = await this.testRunRepository.findByWorkflowAndConfig(workflowId, config.id);

		const lastRuns = new Map<string, TestRun>();
		for (const run of runs) {
			if (run.workflowVersionId && run.runAt && !lastRuns.has(run.workflowVersionId)) {
				lastRuns.set(run.workflowVersionId, run);
			}
		}
		const scores = new Map(
			[...lastRuns].map(([versionId, run]) => [versionId, this.computeAvgScore(run, scales)]),
		);
		const scored = [...scores.values()].filter((score): score is number => score !== null);
		const best = scored.length > 0 ? Math.max(...scored) : null;
		const worst = scored.length > 1 ? Math.min(...scored) : null;

		const versions: EvalVersionEntry[] = [
			{
				workflowVersionId: null,
				label: 'Current draft',
				sourceLabel: 'Live workflow',
				isCurrent: true,
				lastRun: null,
			},
			...history.map((version): EvalVersionEntry => {
				const run = lastRuns.get(version.versionId);
				const avgScore = scores.get(version.versionId) ?? null;
				return {
					workflowVersionId: version.versionId,
					label: version.name ?? this.shortVersionLabel(version.versionId),
					sourceLabel: this.formatSourceLabel(version.createdAt),
					isCurrent: false,
					lastRun: run?.runAt
						? {
								testRunId: run.id,
								runAt: run.runAt.toISOString(),
								status: run.status,
								avgScore,
								isBest: avgScore !== null && avgScore === best,
								isCritical:
									avgScore !== null && worst !== null && worst !== best && avgScore === worst,
							}
						: null,
				};
			}),
		];
		return { evaluationConfigId: config.id, versions };
	}

	shortVersionLabel(versionId: string) {
		return `v ${versionId.slice(0, 8)}`;
	}

	formatDateLabel(date: Date) {
		return date.toISOString().slice(0, 10);
	}

	formatSourceLabel(createdAt: Date) {
		return `Snapshot · ${this.formatDateLabel(createdAt)}`;
	}

	extractDatasetId(config: EvaluationConfig): string | null {
		return 'dataTableId' in config.datasetRef ? config.datasetRef.dataTableId : null;
	}

	computeAvgScore(run: TestRun, fallbackScales?: Record<string, MetricScale>) {
		return averageNormalizedScore(this.coerceMetrics(run), runMetricScales(run) ?? fallbackScales);
	}

	/** The metrics of a run as numbers: a boolean becomes 1 or 0. */
	coerceMetrics(run: Pick<TestRun, 'metrics'>): Record<string, number> | null {
		if (!run.metrics) return null;
		return Object.fromEntries(
			Object.entries(run.metrics).map(([key, value]) => [
				key,
				typeof value === 'boolean' ? Number(value) : value,
			]),
		);
	}

	toRecord(
		collection: Pick<
			EvaluationCollection,
			| 'id'
			| 'name'
			| 'description'
			| 'workflowId'
			| 'evaluationConfigId'
			| 'createdById'
			| 'createdAt'
			| 'updatedAt'
		>,
		runCount: number,
	): EvaluationCollectionRecord {
		return {
			id: collection.id,
			name: collection.name,
			description: collection.description,
			workflowId: collection.workflowId,
			evaluationConfigId: collection.evaluationConfigId,
			createdById: collection.createdById,
			createdAt: collection.createdAt.toISOString(),
			updatedAt: collection.updatedAt.toISOString(),
			runCount,
		};
	}

	toRunSummary(
		run: TestRun,
		collectionScales?: Record<string, MetricScale>,
	): EvaluationCollectionRunSummary {
		const metricScales = runMetricScales(run) ?? collectionScales;
		return {
			testRunId: run.id,
			workflowVersionId: run.workflowVersionId,
			status: run.status,
			runAt: run.runAt?.toISOString() ?? null,
			completedAt: run.completedAt?.toISOString() ?? null,
			avgScore: this.computeAvgScore(run, collectionScales),
			metrics: this.coerceMetrics(run),
			...(metricScales ? { metricScales } : {}),
		};
	}

	/** Starts one compiled run of the config for each version. `null` is the current draft. */
	private async startCollectionRuns(
		workflowId: string,
		user: User,
		collectionId: string,
		config: EvaluationConfig,
		versions: Array<string | null>,
		concurrency = 1,
	): Promise<string[]> {
		const workflow = await this.workflowRepository.findOneBy({ id: workflowId });
		if (!workflow) throw new NotFoundError('Workflow not found');

		const ids: string[] = [];
		for (const versionId of versions) {
			const { testRun, finished } = await this.testRunnerService.startTestRun(
				user,
				workflowId,
				concurrency,
				{
					evaluationConfigId: config.id,
					compileFromConfig: true,
					collectionId,
					// The current draft is pinned to the version of the saved workflow at the start.
					workflowVersionId: versionId ?? workflow.versionId,
				},
			);
			void finished;
			ids.push(testRun.id);
		}
		return ids;
	}

	private async withRerunLock<T>(collectionId: string, action: () => Promise<T>): Promise<T> {
		if (this.rerunning.has(collectionId)) {
			throw new ConflictError('The collection is already starting new runs');
		}
		this.rerunning.add(collectionId);
		try {
			return await action();
		} finally {
			this.rerunning.delete(collectionId);
		}
	}

	private async loadConfig(workflowId: string, configId: string) {
		const config = await this.evaluationConfigRepository.findByIdAndWorkflowId(
			configId,
			workflowId,
		);
		if (!config) throw new NotFoundError('EvaluationConfig not found for this workflow');
		return config;
	}

	private async loadCollection(workflowId: string, collectionId: string) {
		const collection = await this.evaluationCollectionRepository.findByIdAndWorkflowId(
			collectionId,
			workflowId,
		);
		if (!collection) throw new NotFoundError('Collection not found');
		return collection;
	}

	private async countRuns(collectionId: string) {
		return await this.testRunRepository.countByCollectionId(collectionId);
	}
}
