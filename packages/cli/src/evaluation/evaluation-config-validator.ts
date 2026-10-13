import type { EvaluationMetric, UpsertEvaluationConfigDto } from '@n8n/api-types';
import { CredentialsFinderService } from '@n8n/backend-services';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import type { INode, IWorkflowBase } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { DataTableService } from '@/modules/data-table/data-table.service';

import { EvaluationApiError } from './evaluation-api-error';
import { LlmJudgeProviderRegistry } from './llm-judge-provider-registry';
import { EVAL_NODE_PREFIX, singleExpressionBody } from './test-runner/workflow-compiler.service';

type LlmJudgeMetric = Extract<EvaluationMetric, { type: 'llm_judge' }>;

type ValidationInput = {
	workflow: Pick<IWorkflowBase, 'nodes' | 'connections'>;
	user: User;
	config: UpsertEvaluationConfigDto;
};

/**
 * `true` when a boolean metric can become a number: a plain value, or one `={{ … }}` expression
 * with no other text.
 */
export function isCoercibleBooleanExpression(expression: string): boolean {
	if (!expression.startsWith('=')) return true;
	return singleExpressionBody(expression) !== undefined;
}

/**
 * Fork code (not in upstream n8n): the checks of an evaluation config before it is saved. The
 * first check that fails throws an `EvaluationApiError`. It replaces the enterprise validator.
 * See `FORK.md` in this folder.
 */
@Service()
export class EvaluationConfigValidator {
	constructor(
		private readonly dataTableService: DataTableService,
		private readonly credentialsFinderService: CredentialsFinderService,
		private readonly llmJudgeProviderRegistry: LlmJudgeProviderRegistry,
	) {}

	async validate({ workflow, user, config }: ValidationInput): Promise<void> {
		this.checkNodeReferences(workflow, config);
		this.checkReservedPrefix(workflow, config);
		this.checkReachability(workflow, config);
		this.checkEntryAmbiguity(workflow, config);
		this.checkDatasetSource(workflow, config);
		this.checkMetricUniqueness(workflow, config);
		this.checkMetricInputsNonEmpty(workflow, config);
		this.checkBooleanCoercion(workflow, config);
		await this.checkLlmJudgeProvidersAndCredentials(user, config);
		await this.checkDataTableAccess(user, config);
	}

	getNodeByName(workflow: Pick<IWorkflowBase, 'nodes'>, name: string): INode | undefined {
		return workflow.nodes.find((node) => node.name === name);
	}

	checkNodeReferences(workflow: Pick<IWorkflowBase, 'nodes'>, config: UpsertEvaluationConfigDto) {
		const { startNodeName, endNodeName } = config;
		if (!this.getNodeByName(workflow, startNodeName)) {
			throw new EvaluationApiError(
				'START_NODE_NOT_FOUND',
				`Start node "${startNodeName}" was not found on the workflow`,
				{ field: 'startNodeName', nodeName: startNodeName },
			);
		}
		if (!this.getNodeByName(workflow, endNodeName)) {
			throw new EvaluationApiError(
				'END_NODE_NOT_FOUND',
				`End node "${endNodeName}" was not found on the workflow`,
				{ field: 'endNodeName', nodeName: endNodeName },
			);
		}
	}

	/** The compiler names its nodes with the prefix `__eval_`. The workflow may not use it. */
	checkReservedPrefix(workflow: Pick<IWorkflowBase, 'nodes'>, _config: UpsertEvaluationConfigDto) {
		const node = workflow.nodes.find((candidate) => candidate.name.startsWith(EVAL_NODE_PREFIX));
		if (node) {
			throw new EvaluationApiError(
				'RESERVED_PREFIX_IN_USE',
				`Node "${node.name}" uses the reserved "${EVAL_NODE_PREFIX}" prefix`,
				{ nodeName: node.name },
			);
		}
	}

	/** The end node is the start node, or a node after it on the main connections. */
	checkReachability(
		workflow: Pick<IWorkflowBase, 'connections'>,
		config: UpsertEvaluationConfigDto,
	) {
		const { startNodeName, endNodeName } = config;
		const reached = new Set([startNodeName]);
		const queue = [startNodeName];
		while (queue.length > 0) {
			const current = queue.shift();
			if (current === undefined) break;
			for (const branch of workflow.connections[current]?.[NodeConnectionTypes.Main] ?? []) {
				for (const connection of branch ?? []) {
					if (reached.has(connection.node)) continue;
					reached.add(connection.node);
					queue.push(connection.node);
				}
			}
		}
		if (!reached.has(endNodeName)) {
			throw new EvaluationApiError(
				'END_NODE_UNREACHABLE',
				`End node "${endNodeName}" is not reachable from start node "${startNodeName}"`,
				{ field: 'endNodeName', nodeName: endNodeName },
			);
		}
	}

	/** The dataset row replaces the input of the start node, so the input must be one node. */
	checkEntryAmbiguity(
		workflow: Pick<IWorkflowBase, 'connections'>,
		config: UpsertEvaluationConfigDto,
	) {
		const { startNodeName } = config;
		const parents = new Set<string>();
		for (const [source, outputs] of Object.entries(workflow.connections)) {
			for (const branch of outputs[NodeConnectionTypes.Main] ?? []) {
				if ((branch ?? []).some((connection) => connection.node === startNodeName)) {
					parents.add(source);
				}
			}
		}
		if (parents.size > 1) {
			throw new EvaluationApiError(
				'AMBIGUOUS_ENTRY_NODE',
				`Entry node "${startNodeName}" has multiple upstream parents (${[...parents].sort().join(', ')})`,
				{ field: 'startNodeName', nodeName: startNodeName },
			);
		}
	}

	checkDatasetSource(_workflow: unknown, config: UpsertEvaluationConfigDto) {
		if (config.datasetSource === 'google_sheets') {
			throw new EvaluationApiError(
				'UNSUPPORTED_DATASET_SOURCE',
				'Google Sheets datasets are accepted by the schema but not yet runnable',
				{ field: 'datasetSource' },
			);
		}
	}

	checkMetricUniqueness(_workflow: unknown, config: UpsertEvaluationConfigDto) {
		const count = (values: string[]) => {
			const counts = new Map<string, number>();
			for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
			return [...counts].find(([, times]) => times > 1);
		};
		const id = count(config.metrics.map((metric) => metric.id));
		if (id) {
			throw new EvaluationApiError(
				'DUPLICATE_METRIC_ID',
				`Metric id "${id[0]}" appears ${id[1]} times`,
				{
					metricId: id[0],
				},
			);
		}
		const name = count(config.metrics.map((metric) => metric.name));
		if (name) {
			throw new EvaluationApiError(
				'DUPLICATE_METRIC_NAME',
				`Metric name "${name[0]}" appears ${name[1]} times`,
				{ metricName: name[0] },
			);
		}
	}

	/** Text that is only spaces passes the schema, but resolves to nothing in a run. */
	checkMetricInputsNonEmpty(_workflow: unknown, config: UpsertEvaluationConfigDto) {
		for (const metric of config.metrics) {
			const inputs: Array<[string, string | undefined, string]> =
				metric.type === 'expression'
					? [['expression', metric.config.expression, 'config.expression']]
					: Object.entries(metric.config.inputs).map(
							([key, value]): [string, string | undefined, string] => [
								key,
								value,
								`config.inputs.${key}`,
							],
						);
			for (const [key, value, field] of inputs) {
				if (value !== undefined && value.trim().length === 0) {
					throw new EvaluationApiError(
						'METRIC_INPUT_EMPTY',
						`Metric "${metric.name}" input "${key}" must not be empty`,
						{ field, metricId: metric.id, metricName: metric.name },
					);
				}
			}
		}
	}

	checkBooleanCoercion(_workflow: unknown, config: UpsertEvaluationConfigDto) {
		for (const metric of config.metrics) {
			if (metric.type !== 'expression' || metric.config.outputType !== 'boolean') continue;
			if (!isCoercibleBooleanExpression(metric.config.expression)) {
				throw new EvaluationApiError(
					'BOOLEAN_COERCION_UNSUPPORTED',
					`Metric "${metric.name}" expression cannot be coerced into a boolean`,
					{ field: 'config.expression', metricId: metric.id, metricName: metric.name },
				);
			}
		}
	}

	llmJudgeMetrics(config: UpsertEvaluationConfigDto): LlmJudgeMetric[] {
		return config.metrics.filter((metric): metric is LlmJudgeMetric => metric.type === 'llm_judge');
	}

	/** Each judge names a known chat model, and a credential of its type that the user can read. */
	async checkLlmJudgeProvidersAndCredentials(user: User, config: UpsertEvaluationConfigDto) {
		for (const metric of this.llmJudgeMetrics(config)) {
			const { provider: nodeType, credentialId } = metric.config;
			const details = { metricId: metric.id, metricName: metric.name };
			const provider = this.llmJudgeProviderRegistry.get(nodeType);
			if (!provider) {
				throw new EvaluationApiError(
					'LLM_PROVIDER_UNSUPPORTED',
					`Provider "${nodeType}" is not supported for LLM judge metrics`,
					{ ...details, nodeType },
				);
			}
			const credential = await this.credentialsFinderService.findCredentialForUser(
				credentialId,
				user,
				['credential:read'],
			);
			if (!credential) {
				throw new EvaluationApiError(
					'LLM_CREDENTIAL_ACCESS_DENIED',
					`Credential "${credentialId}" is not accessible to the user`,
					{ ...details, credentialId },
				);
			}
			const expected = provider.credentialTypes.map((credentialType) => credentialType.name);
			if (!expected.includes(credential.type)) {
				throw new EvaluationApiError(
					'LLM_CREDENTIAL_TYPE_MISMATCH',
					`Credential type "${credential.type}" does not match provider "${nodeType}" (expected one of: ${expected.join(', ')})`,
					{ ...details, credentialId, nodeType },
				);
			}
		}
	}

	/** The data table of the dataset exists. */
	async checkDataTableAccess(_user: User, config: UpsertEvaluationConfigDto) {
		if (config.datasetSource !== 'data_table') return;
		const { dataTableId } = config.datasetRef;
		const [table] = await this.dataTableService.findDataTablesByIds([dataTableId]);
		if (!table) {
			throw new EvaluationApiError(
				'DATASET_NOT_FOUND',
				`Data table "${dataTableId}" was not found`,
				{
					field: 'datasetRef.dataTableId',
				},
			);
		}
	}
}
