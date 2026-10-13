import { Service } from '@n8n/di';
import { DataSource, In, Repository } from '@n8n/typeorm';
import type { JsonObject } from 'n8n-workflow';

import { AgentEvalRating, AgentEvalResult } from '../entities';

/**
 * Fork repository (not in upstream n8n): the ratings of the results of agent eval runs. It
 * replaces the enterprise repository of the same name. See
 * `packages/@n8n/db/src/entities/FORK.md`.
 */
@Service()
export class AgentEvalRatingRepository extends Repository<AgentEvalRating> {
	constructor(dataSource: DataSource) {
		super(AgentEvalRating, dataSource.manager);
	}

	async createRating(input: {
		resultId: string;
		vote: AgentEvalRating['vote'];
		comment?: string | null;
		correction?: JsonObject | null;
		ratedById?: string | null;
	}): Promise<AgentEvalRating> {
		const rating = this.create({
			resultId: input.resultId,
			vote: input.vote,
			comment: input.comment ?? null,
			correction: input.correction ?? null,
			ratedById: input.ratedById ?? null,
		});
		return await this.save(rating);
	}

	/** All ratings of a result, the newest first. */
	async findByResultId(resultId: string): Promise<AgentEvalRating[]> {
		return await this.find({ where: { resultId }, order: { createdAt: 'DESC' } });
	}

	/**
	 * The newest rating of each rated result of a run. The first query finds the IDs of the ratings
	 * of the run, the newest first for each result. The second query loads only the newest ones.
	 */
	async findLatestByRunId(runId: string): Promise<AgentEvalRating[]> {
		const rows = await this.createQueryBuilder('rating')
			.select('rating.id', 'id')
			.addSelect('rating.resultId', 'resultId')
			.innerJoin(AgentEvalResult, 'result', 'result.id = rating.resultId')
			.where('result.runId = :runId', { runId })
			.orderBy('rating.resultId', 'ASC')
			.addOrderBy('rating.createdAt', 'DESC')
			.addOrderBy('rating.id', 'DESC')
			.getRawMany<{ id: string; resultId: string }>();

		const latestIds: string[] = [];
		const ratedResults = new Set<string>();
		for (const { id, resultId } of rows) {
			if (ratedResults.has(resultId)) continue;
			ratedResults.add(resultId);
			latestIds.push(id);
		}
		if (latestIds.length === 0) return [];

		const ratings = await this.find({ where: { id: In(latestIds) } });
		const byId = new Map(ratings.map((rating) => [rating.id, rating]));
		return latestIds.flatMap((id) => {
			const rating = byId.get(id);
			return rating ? [rating] : [];
		});
	}
}
