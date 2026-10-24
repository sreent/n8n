import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AgentEvalDataset } from '../entities';

type DatasetPatch = Partial<Pick<AgentEvalDataset, 'name' | 'description' | 'columnMapping'>>;

/**
 * Fork repository (not in upstream n8n): the datasets of agent evals. It replaces the enterprise
 * repository of the same name. See `packages/@n8n/db/src/entities/FORK.md`.
 */
@Service()
export class AgentEvalDatasetRepository extends Repository<AgentEvalDataset> {
	constructor(dataSource: DataSource) {
		super(AgentEvalDataset, dataSource.manager);
	}

	async createDataset(input: {
		name: string;
		agentId: string;
		datasetSource: AgentEvalDataset['datasetSource'];
		datasetRef: AgentEvalDataset['datasetRef'];
		description?: string | null;
		columnMapping?: AgentEvalDataset['columnMapping'];
		createdById?: string | null;
	}): Promise<AgentEvalDataset> {
		const dataset = this.create({
			name: input.name,
			agentId: input.agentId,
			datasetSource: input.datasetSource,
			datasetRef: input.datasetRef,
			description: input.description ?? null,
			columnMapping: input.columnMapping ?? null,
			createdById: input.createdById ?? null,
		});
		return await this.save(dataset);
	}

	/** The datasets of an agent, the newest first. */
	async findByAgentId(agentId: string): Promise<AgentEvalDataset[]> {
		return await this.find({ where: { agentId }, order: { createdAt: 'DESC' } });
	}

	async findById(id: string): Promise<AgentEvalDataset | null> {
		return await this.findOneBy({ id });
	}

	/** A dataset of the agent. A dataset of another agent gives `null`. */
	async findByIdAndAgentId(id: string, agentId: string): Promise<AgentEvalDataset | null> {
		return await this.findOneBy({ id, agentId });
	}

	/**
	 * Writes only the fields in the patch, so that a parallel update of another field stays. `null`
	 * clears a field. Gives the dataset after the update, or `null` when the agent has no such
	 * dataset.
	 */
	async updateDataset(
		id: string,
		agentId: string,
		patch: DatasetPatch,
	): Promise<AgentEvalDataset | null> {
		const changes: DatasetPatch = {};
		if (patch.name !== undefined) changes.name = patch.name;
		if (patch.description !== undefined) changes.description = patch.description;
		if (patch.columnMapping !== undefined) changes.columnMapping = patch.columnMapping;
		if (Object.keys(changes).length > 0) {
			await this.update({ id, agentId }, changes);
		}
		return await this.findOneBy({ id, agentId });
	}

	/** Whether a dataset of the agent was deleted. The database deletes its runs too. */
	async deleteDataset(id: string, agentId: string): Promise<boolean> {
		const result = await this.delete({ id, agentId });
		return (result.affected ?? 0) > 0;
	}

	/** Whether a dataset other than `datasetId`, of any agent, reads the Data Table. */
	async isDataTableReadByOtherDataset(dataTableId: string, datasetId: string): Promise<boolean> {
		const datasets = await this.find({ where: { datasetSource: 'data_table' } });
		return datasets.some(
			({ id, datasetRef }) =>
				id !== datasetId && 'dataTableId' in datasetRef && datasetRef.dataTableId === dataTableId,
		);
	}
}
