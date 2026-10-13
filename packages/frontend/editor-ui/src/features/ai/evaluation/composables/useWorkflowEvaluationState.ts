// Fork code (not in upstream n8n): which evaluation nodes the current workflow has, and the node
// that sets each metric. It replaces the enterprise composable of the same name. See
// `../FORK.md`.
import type { INode, INodeParameters } from 'n8n-workflow';
import {
	DEFAULT_EVALUATION_METRIC,
	EVALUATION_NODE_TYPE,
	EVALUATION_TRIGGER_NODE_TYPE,
	NodeHelpers,
} from 'n8n-workflow';
import { computed } from 'vue';

import { useNodeTypesStore } from '@/app/stores/nodeTypes.store';
import { injectWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';

import { BUILT_IN_METRIC_CATEGORIES, BUILT_IN_METRIC_NAMES } from '../evaluation.constants';
import type { MetricSource } from '../evaluation.types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export function useWorkflowEvaluationState() {
	const workflowDocumentStore = injectWorkflowDocumentStore();
	const nodeTypesStore = useNodeTypesStore();

	/** The parameters of a node with the defaults of its node type. */
	function resolvedParameters(node: INode): INodeParameters {
		const nodeType = nodeTypesStore.getNodeType(node.type, node.typeVersion);
		if (!nodeType) return node.parameters;
		return (
			NodeHelpers.getNodeParameters(
				nodeType.properties,
				node.parameters,
				true,
				false,
				node,
				nodeType,
			) ?? node.parameters
		);
	}

	const nodes = computed(() => workflowDocumentStore.value.allNodes);

	const evaluationNodes = computed(() =>
		nodes.value
			.filter((node) => node.type === EVALUATION_NODE_TYPE)
			.map((node) => ({ node, parameters: resolvedParameters(node) })),
	);

	// The operation of the Evaluation node is "Set outputs" when the parameter is missing.
	const operationOf = (parameters: INodeParameters) => parameters.operation ?? 'setOutputs';

	const evaluationTriggerExists = computed(() =>
		nodes.value.some((node) => node.type === EVALUATION_TRIGGER_NODE_TYPE),
	);

	const evaluationSetOutputsNodeExist = computed(() =>
		evaluationNodes.value.some(({ parameters }) => operationOf(parameters) === 'setOutputs'),
	);

	const setMetricsNodes = computed(() =>
		evaluationNodes.value.filter(({ parameters }) => operationOf(parameters) === 'setMetrics'),
	);

	const evaluationSetMetricsNodeExist = computed(() => setMetricsNodes.value.length > 0);

	/** The node and the kind of each metric that a Set Metrics node sets. */
	const metricSourceByKey = computed(() => {
		const sources: Record<string, MetricSource> = {};
		for (const { node, parameters } of setMetricsNodes.value) {
			const metric =
				typeof parameters.metric === 'string'
					? parameters.metric
					: node.typeVersion < 4.7
						? 'customMetrics'
						: DEFAULT_EVALUATION_METRIC;
			if (metric === 'customMetrics') {
				const metrics: unknown = parameters.metrics;
				const assignments = isRecord(metrics) ? metrics.assignments : [];
				for (const assignment of Array.isArray(assignments) ? assignments : []) {
					if (isRecord(assignment) && typeof assignment.name === 'string' && assignment.name) {
						sources[assignment.name] = { category: 'custom', nodeName: node.name };
					}
				}
				continue;
			}
			const category = BUILT_IN_METRIC_CATEGORIES[metric];
			if (!category) continue;
			const options: unknown = parameters.options;
			const metricName = isRecord(options) ? options.metricName : undefined;
			const name =
				typeof metricName === 'string' && metricName ? metricName : BUILT_IN_METRIC_NAMES[metric];
			sources[name] = { category, nodeName: node.name };
		}
		return sources;
	});

	return {
		evaluationTriggerExists,
		evaluationSetOutputsNodeExist,
		evaluationSetMetricsNodeExist,
		metricSourceByKey,
	};
}
