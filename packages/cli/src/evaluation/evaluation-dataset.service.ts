import type {
	AddDatasetRowDto,
	DatasetCandidateField,
	DatasetCandidateResponse,
	DatasetColumnMapping,
} from '@n8n/api-types';
import type { EvaluationConfig, IExecutionResponse, User } from '@n8n/db';
import { Service } from '@n8n/di';
import { BadRequestError, ForbiddenError, NotFoundError } from '@n8n/errors';
import type { Scope } from '@n8n/permissions';
import type { IDataObject, IRunData } from 'n8n-workflow';
import { jsonStringify } from 'n8n-workflow';

import { ExecutionPersistence } from '@/executions/execution-persistence';
import { DataTableService } from '@/modules/data-table/data-table.service';
import { userHasScopes } from '@/permissions/check-access';

import { EvaluationConfigService } from './evaluation-config.service';

type DatasetSource = 'input' | 'output';

/**
 * Fork code (not in upstream n8n): turns a past execution into a row of the dataset of an
 * evaluation config. The inputs are the data that came into the start node, and the outputs are
 * the data of the end node. It replaces the enterprise service. See `FORK.md` in this folder.
 */
@Service()
export class EvaluationDatasetService {
	constructor(
		private readonly evaluationConfigService: EvaluationConfigService,
		private readonly executionPersistence: ExecutionPersistence,
		private readonly dataTableService: DataTableService,
	) {}

	/** The columns of the dataset, the fields of the execution and a mapping of them. */
	async getCandidate(
		workflowId: string,
		configId: string,
		executionId: string,
		user: User,
	): Promise<DatasetCandidateResponse> {
		const config = await this.loadConfig(workflowId, configId);
		const dataTableId = this.dataTableId(config);
		const { columns } = await this.loadDataTableConfig(dataTableId, user, 'dataTable:readColumn');
		const execution = await this.loadSuccessfulExecution(workflowId, executionId);
		const { inputs, outputs } = this.extractFields(execution, config);

		const fields = {
			inputs: Object.entries(inputs).map(
				([key, sample]): DatasetCandidateField => ({ key, sample }),
			),
			outputs: Object.entries(outputs).map(
				([key, sample]): DatasetCandidateField => ({ key, sample }),
			),
		};
		return {
			dataTableId,
			columns,
			fields,
			suggestedMapping: this.suggestMapping(
				columns.map((column) => column.name),
				inputs,
				outputs,
			),
		};
	}

	/** Adds the execution as a row of the dataset, with the values that the mapping picks. */
	async addRow(workflowId: string, configId: string, dto: AddDatasetRowDto, user: User) {
		const config = await this.loadConfig(workflowId, configId);
		const dataTableId = this.dataTableId(config);
		const { projectId, columns } = await this.loadDataTableConfig(
			dataTableId,
			user,
			'dataTable:writeRow',
		);
		const execution = await this.loadSuccessfulExecution(workflowId, dto.executionId);
		const fields = this.extractFields(execution, config);

		const row: Record<string, string | number | boolean | Date | null> = {};
		for (const column of columns) {
			const mapping = dto.mapping[column.name];
			if (!mapping) continue;
			const value = fields[mapping.source === 'input' ? 'inputs' : 'outputs'][mapping.field];
			row[column.name] = this.toCellValue(value);
		}
		return await this.dataTableService.insertRows(dataTableId, projectId, [row], 'id');
	}

	dataTableId(config: EvaluationConfig): string {
		if (!('dataTableId' in config.datasetRef)) {
			throw new BadRequestError('The dataset of this evaluation config is not a data table');
		}
		return config.datasetRef.dataTableId;
	}

	/** The project and the columns of the data table, when the user holds the scope there. */
	async loadDataTableConfig(dataTableId: string, user: User, scope: Scope) {
		const projectId = await this.assertDataTableAccess(dataTableId, user, scope);
		const columns = (await this.dataTableService.getColumns(dataTableId, projectId)).map(
			(column) => ({ name: column.name, type: column.type }),
		);
		return { projectId, columns };
	}

	async assertDataTableAccess(dataTableId: string, user: User, scope: Scope): Promise<string> {
		let projectId: string;
		try {
			projectId = await this.dataTableService.getProjectIdForDataTable(dataTableId);
		} catch {
			throw new NotFoundError(`Data table "${dataTableId}" was not found`);
		}
		if (!(await userHasScopes(user, [scope], false, { projectId }))) {
			throw new ForbiddenError('You do not have access to the data table of this evaluation');
		}
		return projectId;
	}

	/** A finished execution of the workflow with its data. */
	async loadSuccessfulExecution(workflowId: string, executionId: string) {
		const execution = await this.executionPersistence.findSingleExecution(executionId, {
			includeData: true,
			unflattenData: true,
			where: { workflowId },
		});
		if (!execution) throw new NotFoundError('Execution not found');
		if (execution.status !== 'success') {
			throw new BadRequestError('Only a successful execution can become a dataset row');
		}
		return execution;
	}

	/** The fields that came into the start node, and the fields of the end node. */
	extractFields(execution: IExecutionResponse, config: EvaluationConfig) {
		const runData = execution.data.resultData.runData;
		return {
			inputs: this.extractInputFields(runData, config.startNodeName),
			outputs: this.extractOutputFields(runData, config.endNodeName),
		};
	}

	/** The first item that the node before the start node gave to it. */
	extractInputFields(runData: IRunData, startNodeName: string): IDataObject {
		const source = runData[startNodeName]?.[0]?.source?.[0];
		if (!source) return {};
		const previous = runData[source.previousNode]?.[source.previousNodeRun ?? 0];
		return previous?.data?.main?.[source.previousNodeOutput ?? 0]?.[0]?.json ?? {};
	}

	/** The first item of the last run of the end node. */
	extractOutputFields(runData: IRunData, endNodeName: string): IDataObject {
		const runs = runData[endNodeName] ?? [];
		return runs[runs.length - 1]?.data?.main?.[0]?.[0]?.json ?? {};
	}

	/** A column takes the input field of the same name, else the output field, else nothing. */
	suggestMapping(
		columnNames: string[],
		inputs: IDataObject,
		outputs: IDataObject,
	): Record<string, DatasetColumnMapping> {
		const mapping: Record<string, DatasetColumnMapping> = {};
		const pick = (source: DatasetSource, field: string) => ({ source, field });
		for (const name of columnNames) {
			if (name in inputs) mapping[name] = pick('input', name);
			else if (name in outputs) mapping[name] = pick('output', name);
			else mapping[name] = null;
		}
		return mapping;
	}

	private toCellValue(value: unknown): string | number | boolean | Date | null {
		if (value === undefined || value === null) return null;
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean' ||
			value instanceof Date
		) {
			return value;
		}
		return jsonStringify(value);
	}

	private async loadConfig(workflowId: string, configId: string) {
		const config = await this.evaluationConfigService.get(workflowId, configId);
		if (!config) throw new NotFoundError('Evaluation config not found');
		return config;
	}
}
