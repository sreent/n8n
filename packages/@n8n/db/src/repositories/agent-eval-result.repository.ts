import { Service } from '@n8n/di';
import { DataSource, In, Repository } from '@n8n/typeorm';
import type { UpdateResult } from '@n8n/typeorm';
import type { IDataObject, JsonObject } from 'n8n-workflow';

import { AgentEvalResult, type AgentEvalResultStatus } from '../entities';

/** A case with one of these statuses has finished, so a rerun can claim it. */
const SETTLED_STATUSES: AgentEvalResultStatus[] = ['success', 'error', 'cancelled'];

/** The fields that an attempt of a case writes. A new attempt clears them, because it reuses the row. */
const clearedAttempt = () => ({
	completedAt: null,
	output: null,
	toolCalls: null,
	metrics: null,
	verdict: null,
	errorCode: null,
	errorDetails: null,
});

/**
 * Fork repository (not in upstream n8n): the results of the cases of agent eval runs. It replaces
 * the enterprise repository of the same name. See `packages/@n8n/db/src/entities/FORK.md`.
 */
@Service()
export class AgentEvalResultRepository extends Repository<AgentEvalResult> {
	constructor(dataSource: DataSource) {
		super(AgentEvalResult, dataSource.manager);
	}

	/**
	 * One result with the status `new` for each case. Without `runIndex`, a case gets its position
	 * in the list, so that the order is the same on each database.
	 */
	async seedResults(
		cases: Array<{
			runId: string;
			sourceRowId?: string | null;
			runIndex?: number;
			input?: JsonObject | null;
		}>,
	): Promise<AgentEvalResult[]> {
		const results = cases.map((evalCase, index) =>
			this.create({
				runId: evalCase.runId,
				sourceRowId: evalCase.sourceRowId ?? null,
				runIndex: evalCase.runIndex ?? index,
				input: evalCase.input ?? null,
				status: 'new',
				output: null,
				toolCalls: null,
				metrics: null,
				verdict: null,
				runAt: null,
				completedAt: null,
				errorCode: null,
				errorDetails: null,
			}),
		);
		return await this.save(results);
	}

	/** The number of results of a run for each status. The database counts them. */
	async countByStatus(runId: string): Promise<Record<AgentEvalResultStatus, number>> {
		const rows = await this.createQueryBuilder('result')
			.select('result.status', 'status')
			.addSelect('COUNT(*)', 'count')
			.where('result.runId = :runId', { runId })
			.groupBy('result.status')
			.getRawMany<{ status: AgentEvalResultStatus; count: string | number }>();

		const counts: Record<AgentEvalResultStatus, number> = {
			new: 0,
			running: 0,
			success: 0,
			error: 0,
			cancelled: 0,
		};
		for (const { status, count } of rows) {
			if (status in counts) counts[status] = Number(count);
		}
		return counts;
	}

	async markAsRunning(id: string): Promise<UpdateResult> {
		return await this.update(id, { status: 'running', runAt: new Date(), ...clearedAttempt() });
	}

	/**
	 * Starts a rerun of a finished case. Of two requests for the same case, only one claims it.
	 * Returns false when the case is new or running.
	 */
	async claimForRerun(id: string): Promise<boolean> {
		const result = await this.update(
			{ id, status: In(SETTLED_STATUSES) },
			{ status: 'running', runAt: new Date(), ...clearedAttempt() },
		);
		return (result.affected ?? 0) > 0;
	}

	async markAsCancelled(id: string): Promise<UpdateResult> {
		return await this.update(id, { status: 'cancelled', completedAt: new Date() });
	}

	/** The verdict of the judge is in the same write, so a finished case never shows without it. */
	async markAsCompleted(
		id: string,
		outcome: {
			output: JsonObject;
			toolCalls?: JsonObject | null;
			metrics?: IDataObject | null;
			verdict?: JsonObject | null;
		},
	): Promise<UpdateResult> {
		return await this.update(id, {
			status: 'success',
			completedAt: new Date(),
			output: outcome.output,
			toolCalls: outcome.toolCalls ?? null,
			metrics: outcome.metrics ?? null,
			verdict: outcome.verdict ?? null,
		});
	}

	/** Sets the verdict and keeps the status. `null` records that no judge ran. */
	async updateVerdict(id: string, verdict: JsonObject | null): Promise<UpdateResult> {
		return await this.update(id, { verdict });
	}

	/** Replaces the copy of the input of the case. */
	async updateInput(id: string, input: JsonObject): Promise<UpdateResult> {
		return await this.update(id, { input });
	}

	/** Whether the result of the run was deleted. */
	async deleteById(id: string, runId: string): Promise<boolean> {
		const result = await this.delete({ id, runId });
		return (result.affected ?? 0) > 0;
	}

	async markAsError(
		id: string,
		errorCode: string,
		errorDetails: IDataObject,
	): Promise<UpdateResult> {
		return await this.update(id, {
			status: 'error',
			completedAt: new Date(),
			errorCode,
			errorDetails,
		});
	}

	/**
	 * One page of the results of a run, in the order of the cases, and the count of all of them.
	 * The database reads the page only, not the large JSON of all results.
	 */
	async findAndCountByRunId(
		runId: string,
		page: { take?: number; skip?: number } = {},
	): Promise<[AgentEvalResult[], number]> {
		return await this.findAndCount({ where: { runId }, order: { runIndex: 'ASC' }, ...page });
	}

	async findById(id: string): Promise<AgentEvalResult | null> {
		return await this.findOneBy({ id });
	}
}
