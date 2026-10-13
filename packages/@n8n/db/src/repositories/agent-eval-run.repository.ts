import { Service } from '@n8n/di';
import { DataSource, In, Repository } from '@n8n/typeorm';
import type { UpdateResult } from '@n8n/typeorm';
import type { IDataObject } from 'n8n-workflow';

import { AgentEvalRun } from '../entities';

/**
 * Fork repository (not in upstream n8n): the runs of agent evals. It replaces the enterprise
 * repository of the same name. See `packages/@n8n/db/src/entities/FORK.md`.
 */
@Service()
export class AgentEvalRunRepository extends Repository<AgentEvalRun> {
	constructor(dataSource: DataSource) {
		super(AgentEvalRun, dataSource.manager);
	}

	/** A new run, with the status `new`. */
	async createRun(input: {
		datasetId: string;
		agentVersionId?: string | null;
		createdById?: string | null;
	}): Promise<AgentEvalRun> {
		const run = this.create({
			datasetId: input.datasetId,
			agentVersionId: input.agentVersionId ?? null,
			createdById: input.createdById ?? null,
			status: 'new',
			runAt: null,
			completedAt: null,
			metrics: null,
			errorCode: null,
			errorDetails: null,
			runningInstanceId: null,
			cancelRequested: false,
		});
		return await this.save(run);
	}

	/** `instanceId` is the main instance that runs the run. A cancellation goes there. */
	async markAsRunning(id: string, instanceId?: string): Promise<UpdateResult> {
		return await this.update(id, {
			status: 'running',
			runAt: new Date(),
			runningInstanceId: instanceId ?? null,
		});
	}

	async markAsCompleted(id: string, metrics: IDataObject): Promise<UpdateResult> {
		return await this.update(id, {
			status: 'completed',
			completedAt: new Date(),
			metrics,
			runningInstanceId: null,
		});
	}

	/** `metrics` keeps the counts of a run that stopped part of the way. */
	async markAsError(
		id: string,
		errorCode: string,
		errorDetails: IDataObject,
		metrics?: IDataObject,
	): Promise<UpdateResult> {
		return await this.update(id, {
			status: 'error',
			completedAt: new Date(),
			errorCode,
			errorDetails,
			...(metrics ? { metrics } : {}),
			runningInstanceId: null,
		});
	}

	async markAsCancelled(id: string, metrics?: IDataObject): Promise<UpdateResult> {
		return await this.update(id, {
			status: 'cancelled',
			completedAt: new Date(),
			metrics: metrics ?? null,
			runningInstanceId: null,
		});
	}

	/** Sets the flag that the running instance reads, also when no message reaches it. */
	async requestCancellation(id: string): Promise<UpdateResult> {
		return await this.update(id, { cancelRequested: true });
	}

	async isCancellationRequested(id: string): Promise<boolean> {
		const run = await this.findOne({ where: { id }, select: ['id', 'cancelRequested'] });
		return run?.cancelRequested ?? false;
	}

	/** The runs of a dataset, the newest first. */
	async findByDatasetId(datasetId: string): Promise<AgentEvalRun[]> {
		return await this.find({ where: { datasetId }, order: { createdAt: 'DESC' } });
	}

	async findById(id: string): Promise<AgentEvalRun | null> {
		return await this.findOneBy({ id });
	}

	/** A run of the agent. A run has no agent of its own: the agent is the agent of its dataset. */
	async findByIdAndAgentId(id: string, agentId: string): Promise<AgentEvalRun | null> {
		return await this.findOne({ where: { id, dataset: { agentId } } });
	}

	/**
	 * One page of the runs of a dataset of the agent, the newest first, and the count of all of
	 * them. The ID breaks ties of `createdAt`, so that a page never skips or repeats a run.
	 */
	async findAndCountByDatasetIdAndAgentId(
		datasetId: string,
		agentId: string,
		page: { take?: number; skip?: number } = {},
	): Promise<[AgentEvalRun[], number]> {
		return await this.findAndCount({
			where: { datasetId, dataset: { agentId } },
			order: { createdAt: 'DESC', id: 'DESC' },
			...page,
		});
	}

	/** Marks the runs that a restart interrupted. */
	async markAllIncompleteAsError(): Promise<UpdateResult> {
		return await this.update(
			{ status: In(['new', 'running']) },
			{
				status: 'error',
				errorCode: 'interrupted',
				completedAt: new Date(),
				runningInstanceId: null,
			},
		);
	}
}
