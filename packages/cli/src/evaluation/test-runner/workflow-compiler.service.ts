import type { EvaluationMetric } from '@n8n/api-types';
import type { EvaluationConfig } from '@n8n/db';
import { CredentialsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { nanoid } from 'nanoid';
import type {
	IConnection,
	IConnections,
	INode,
	INodeParameters,
	IWorkflowBase,
} from 'n8n-workflow';
import {
	deepCopy,
	EVALUATION_NODE_TYPE,
	EVALUATION_TRIGGER_NODE_TYPE,
	isResourceLocatorValue,
	NodeConnectionTypes,
	NodeHelpers,
	tryToParseBoolean,
} from 'n8n-workflow';

import { NodeTypes } from '@/node-types';

import { TestRunError } from './errors';

/** Node names that start with this prefix belong to the compiler. A workflow may not use them. */
export const EVAL_NODE_PREFIX = '__eval_';
export const EVAL_TRIGGER_NODE_NAME = `${EVAL_NODE_PREFIX}trigger`;

export const metricNodeName = (metricId: string) => `${EVAL_NODE_PREFIX}metric_${metricId}`;
export const modelNodeName = (metricId: string) => `${EVAL_NODE_PREFIX}model_${metricId}`;

/** The version of the Evaluation nodes that the compiler adds. */
const COMPILED_NODE_VERSION = 4.7;
/** The trigger sits this far to the left of the start node. */
const TRIGGER_OFFSET_X = 220;
/** The metric column sits this far to the right of the rightmost node of the workflow. */
const METRIC_COLUMN_OFFSET_X = 440;
/** The height of a metric row, and of a judge row with its chat model below the metric. */
const METRIC_ROW_HEIGHT = 140;
const JUDGE_ROW_HEIGHT = 380;
const MODEL_OFFSET_Y = 220;

const METRIC_NODE_NAMES: Record<Exclude<EvaluationMetric['type'], 'llm_judge'>, string> = {
	expression: 'customMetrics',
	string_similarity: 'stringSimilarity',
	categorization: 'categorization',
	tools_used: 'toolsUsed',
};

type CompilableConfig = Pick<
	EvaluationConfig,
	'datasetSource' | 'datasetRef' | 'startNodeName' | 'endNodeName' | 'metrics'
>;

/** An expression that reads the current item reads the dataset row instead. */
function readFromTrigger(expression: string): string {
	return expression.replace(/\$json\b/g, `$('${EVAL_TRIGGER_NODE_NAME}').item.json`);
}

/** The body of a single `={{ … }}` expression, or `undefined` for any other value. */
export function singleExpressionBody(expression: string): string | undefined {
	const match = /^=\{\{([\s\S]*)\}\}$/.exec(expression.trim());
	if (!match || match[1].includes('{{') || match[1].includes('}}')) return undefined;
	return match[1].trim();
}

/**
 * A boolean metric gives 1 or 0. An expression gets a condition around it. A plain value that n8n
 * reads as a boolean ("true", "false", "1", "0") becomes the number. Any other value stays, and
 * the metric node fails on it.
 */
function booleanAsNumber(expression: string): string {
	if (expression.startsWith('=')) {
		const body = singleExpressionBody(expression);
		return body === undefined ? expression : `={{ (${body}) ? 1 : 0 }}`;
	}
	try {
		return tryToParseBoolean(expression.trim()) ? '1' : '0';
	} catch {
		return expression;
	}
}

function isTriggerOfEvaluations(node: INode) {
	return node.type === EVALUATION_TRIGGER_NODE_TYPE;
}

/** Set Metrics and Set Outputs write results. The compiled run must not run them twice. */
function writesEvaluationResults(node: INode) {
	if (node.type !== EVALUATION_NODE_TYPE) return false;
	const operation = node.parameters.operation ?? 'setOutputs';
	return operation === 'setMetrics' || operation === 'setOutputs';
}

/**
 * Fork code (not in upstream n8n): makes the workflow that a test run of an evaluation config
 * runs. It adds a dataset trigger before the start node and one Set Metrics node for each metric
 * after the end node, and removes or disables the Evaluation nodes of the workflow. The saved
 * workflow does not change. See `../FORK.md`.
 */
@Service()
export class WorkflowCompilerService {
	constructor(
		private readonly nodeTypes: NodeTypes,
		private readonly credentialsRepository: CredentialsRepository,
	) {}

	async compile(workflow: IWorkflowBase, config: CompilableConfig): Promise<IWorkflowBase> {
		if (config.datasetSource !== 'data_table' || !('dataTableId' in config.datasetRef)) {
			throw new TestRunError('COMPILATION_FAILED', { reason: 'unsupported_dataset_source' });
		}
		this.assertNoReservedNames(workflow);

		const removed = new Set(workflow.nodes.filter(isTriggerOfEvaluations).map((node) => node.name));
		const nodes = workflow.nodes
			.filter((node) => !removed.has(node.name))
			.map((node) => {
				const copy = deepCopy(node);
				if (writesEvaluationResults(copy)) copy.disabled = true;
				return copy;
			});
		const connections = this.copyConnections(workflow.connections, removed);

		const start = nodes.find((node) => node.name === config.startNodeName);
		const end = nodes.find((node) => node.name === config.endNodeName);
		if (!start) {
			throw new TestRunError('COMPILATION_FAILED', {
				reason: 'start_node_not_found',
				nodeName: config.startNodeName,
			});
		}

		this.pruneConnectionsTo(connections, start.name);
		nodes.push({
			id: nanoid(),
			name: EVAL_TRIGGER_NODE_NAME,
			type: EVALUATION_TRIGGER_NODE_TYPE,
			typeVersion: COMPILED_NODE_VERSION,
			position: [start.position[0] - TRIGGER_OFFSET_X, start.position[1]],
			parameters: {
				source: 'dataTable',
				dataTableId: config.datasetRef.dataTableId,
				limitRows: false,
				filterRows: false,
			},
		});
		connections[EVAL_TRIGGER_NODE_NAME] = {
			main: [[{ node: start.name, type: NodeConnectionTypes.Main, index: 0 }]],
		};

		const metricX =
			Math.max(...workflow.nodes.map((node) => node.position[0])) + METRIC_COLUMN_OFFSET_X;
		const metricNodes: INode[] = [];
		const modelNodes: INode[] = [];
		// A config keeps its end node when the workflow loses it. Then no metric gets input, and
		// each case fails without metrics.
		let rowY = (end ?? start).position[1];
		for (const metric of config.metrics) {
			metricNodes.push(this.buildMetricNode(metric, [metricX, rowY]));
			if (metric.type === 'llm_judge') {
				modelNodes.push(await this.buildChatModelNode(metric, [metricX, rowY + MODEL_OFFSET_Y]));
				connections[modelNodeName(metric.id)] = {
					[NodeConnectionTypes.AiLanguageModel]: [
						[
							{
								node: metricNodeName(metric.id),
								type: NodeConnectionTypes.AiLanguageModel,
								index: 0,
							},
						],
					],
				};
				rowY += JUDGE_ROW_HEIGHT;
			} else {
				rowY += METRIC_ROW_HEIGHT;
			}
		}
		nodes.push(...metricNodes, ...modelNodes);

		// The metrics replace what came after the end node: the run stops there.
		if (end) {
			connections[end.name] = {
				...connections[end.name],
				main: [
					metricNodes.map((node) => ({
						node: node.name,
						type: NodeConnectionTypes.Main,
						index: 0,
					})),
				],
			};
		}

		return { ...workflow, nodes, connections };
	}

	/** Throws when a node of the workflow uses the name prefix of the compiler. */
	assertNoReservedNames(workflow: IWorkflowBase) {
		const reserved = workflow.nodes.find((node) => node.name.startsWith(EVAL_NODE_PREFIX));
		if (reserved) {
			throw new TestRunError('COMPILATION_FAILED', {
				reason: 'reserved_prefix_in_use',
				nodeName: reserved.name,
			});
		}
	}

	private buildMetricNode(metric: EvaluationMetric, position: [number, number]): INode {
		return {
			id: nanoid(),
			name: metricNodeName(metric.id),
			type: EVALUATION_NODE_TYPE,
			typeVersion: COMPILED_NODE_VERSION,
			position,
			parameters: { operation: 'setMetrics', ...this.metricParameters(metric) },
		};
	}

	private metricParameters(metric: EvaluationMetric): INodeParameters {
		const options = { metricName: metric.name };
		switch (metric.type) {
			case 'expression': {
				const { expression, outputType } = metric.config;
				const value = outputType === 'boolean' ? booleanAsNumber(expression) : expression;
				return {
					metric: METRIC_NODE_NAMES.expression,
					metrics: { assignments: [{ id: nanoid(), name: metric.name, value, type: 'number' }] },
				};
			}
			case 'string_similarity':
			case 'categorization':
				return {
					metric: METRIC_NODE_NAMES[metric.type],
					expectedAnswer: readFromTrigger(metric.config.inputs.expectedAnswer),
					actualAnswer: metric.config.inputs.actualAnswer,
					options,
				};
			case 'tools_used':
				return {
					metric: METRIC_NODE_NAMES.tools_used,
					expectedTools: readFromTrigger(metric.config.inputs.expectedTools),
					intermediateSteps: metric.config.inputs.intermediateSteps,
					options,
				};
			case 'llm_judge': {
				const { inputs, preset, prompt } = metric.config;
				return {
					metric: preset,
					...(inputs.expectedAnswer !== undefined
						? { expectedAnswer: readFromTrigger(inputs.expectedAnswer) }
						: {}),
					...(inputs.userQuery !== undefined
						? { userQuery: readFromTrigger(inputs.userQuery) }
						: {}),
					actualAnswer: inputs.actualAnswer,
					...(prompt !== undefined ? { prompt } : {}),
					options,
				};
			}
		}
	}

	/** The chat model sub-node of an LLM judge, with its credential and model. */
	private async buildChatModelNode(
		metric: Extract<EvaluationMetric, { type: 'llm_judge' }>,
		position: [number, number],
	): Promise<INode> {
		const { provider, credentialId, model } = metric.config;
		const credential = await this.credentialsRepository.findOneBy({ id: credentialId });
		if (!credential) {
			throw new TestRunError('COMPILATION_FAILED', {
				reason: 'llm_credential_not_found',
				credentialId,
			});
		}

		const version = this.newestVersion(provider);
		const description = this.nodeTypes.getByNameAndVersion(provider, version).description;
		const defaults =
			NodeHelpers.getNodeParameters(
				description.properties,
				{},
				true,
				false,
				{ typeVersion: version },
				description,
			) ?? {};

		let parameters: INodeParameters = { model };
		if (isResourceLocatorValue(defaults.model)) {
			parameters = { model: { __rl: true, mode: 'list', value: model, cachedResultName: model } };
		} else if (!('model' in defaults) && 'modelName' in defaults) {
			parameters = { modelName: model };
		}

		return {
			id: nanoid(),
			name: modelNodeName(metric.id),
			type: provider,
			typeVersion: version,
			position,
			credentials: { [credential.type]: { id: credentialId, name: '' } },
			parameters,
		};
	}

	/** The version that the editor gives a new node of this type. */
	private newestVersion(nodeTypeName: string): number {
		const nodeType = this.nodeTypes.getByName(nodeTypeName);
		if ('nodeVersions' in nodeType) {
			return nodeType.description.defaultVersion ?? nodeType.currentVersion;
		}
		const { defaultVersion, version } = nodeType.description;
		return defaultVersion ?? (Array.isArray(version) ? Math.max(...version) : version);
	}

	/** A copy of the connections without the removed nodes. */
	private copyConnections(source: IConnections, removed: Set<string>): IConnections {
		const connections: IConnections = {};
		for (const [from, outputs] of Object.entries(source)) {
			if (removed.has(from)) continue;
			const copy: IConnections[string] = {};
			for (const [type, branches] of Object.entries(outputs)) {
				copy[type] = branches.map((branch) =>
					(branch ?? [])
						.filter((connection) => !removed.has(connection.node))
						.map((c) => ({ ...c })),
				);
			}
			connections[from] = copy;
		}
		return connections;
	}

	/** Removes the connections into a node. A source without connections left goes away. */
	private pruneConnectionsTo(connections: IConnections, nodeName: string) {
		for (const [from, outputs] of Object.entries(connections)) {
			for (const [type, branches] of Object.entries(outputs)) {
				outputs[type] = branches.map((branch) =>
					(branch ?? []).filter((connection: IConnection) => connection.node !== nodeName),
				);
			}
			const isEmpty = Object.values(outputs).every((branches) =>
				branches.every((branch) => (branch ?? []).length === 0),
			);
			if (isEmpty) delete connections[from];
		}
	}
}
