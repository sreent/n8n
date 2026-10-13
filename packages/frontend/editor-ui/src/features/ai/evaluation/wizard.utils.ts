// Fork code (not in upstream n8n): the helpers of the Tests panel. They find the trigger and the
// input of the AI node in the graph and in an execution, and they build the evaluation config that
// the panel saves. See `FORK.md` in this folder.
import type { EvaluationMetric, UpsertEvaluationConfigDto } from '@n8n/api-types';
import { nanoid } from 'nanoid';
import type { IConnections, IRunExecutionData } from 'n8n-workflow';
import { getParentNodes, mapConnectionsByDestination } from 'n8n-workflow';

import {
	CANNED_METRICS,
	FALLBACK_INPUT_FIELD_NAME,
	LM_SUBNODE_TYPE_TO_CHATHUB_PROVIDER,
	TEST_CASE_NAME_COLUMN,
	getExpectedFieldsForMetrics,
	type CannedMetricKey,
} from './wizard.constants';

/** The model of the AI judge of a check. */
export interface JudgeSelection {
	/** The provider, for example `openai`. */
	provider: string;
	credentialId?: string;
	model?: string;
}

/** A check of the user, an n8n expression. */
export interface CustomCheck {
	id: string;
	name: string;
	expression: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

// #region The graph

/** The first node that sends data to a node, on the main connections. */
function mainParent(byDestination: IConnections, nodeName: string): string | undefined {
	return getParentNodes(byDestination, nodeName, 'main', 1)[0];
}

/**
 * The trigger of the AI node (the first node of its chain) and the node after the trigger, where
 * a run of a case starts. Without a node before the AI node, both are the AI node.
 */
export function findTriggerAndStart(connections: IConnections, aiNodeName: string) {
	const byDestination = mapConnectionsByDestination(connections);
	const visited = new Set([aiNodeName]);
	let start = aiNodeName;
	let parent = mainParent(byDestination, start);
	while (parent && !visited.has(parent)) {
		visited.add(parent);
		const grandParent = mainParent(byDestination, parent);
		if (!grandParent) return { trigger: parent, start };
		start = parent;
		parent = grandParent;
	}
	return { trigger: aiNodeName, start: aiNodeName };
}

// #endregion

// #region The data of an execution

type RunData = NonNullable<IRunExecutionData['resultData']>['runData'];

function firstOutputItem(runData: RunData, nodeName: string, outputIndex = 0) {
	const runs = runData[nodeName];
	const lastRun = runs?.[runs.length - 1];
	const json = lastRun?.data?.main?.[outputIndex]?.[0]?.json;
	return isRecord(json) ? json : undefined;
}

/** The output of the node before the AI node that reaches the AI node. */
function outputIndexTo(connections: IConnections, source: string, target: string) {
	const outputs = connections[source]?.main ?? [];
	const index = outputs.findIndex((targets) => targets?.some((item) => item.node === target));
	return index === -1 ? 0 : index;
}

/** The first input item of the AI node in a run of the workflow. */
export function readAiNodeInput(
	runData: RunData | undefined,
	connections: IConnections,
	aiNodeName: string,
): Record<string, unknown> | undefined {
	if (!runData) return undefined;
	const parent = mainParent(mapConnectionsByDestination(connections), aiNodeName);
	if (parent && runData[parent]) {
		return firstOutputItem(runData, parent, outputIndexTo(connections, parent, aiNodeName));
	}
	const source = runData[aiNodeName]?.[0]?.source?.[0];
	return source
		? firstOutputItem(runData, source.previousNode, source.previousNodeOutput ?? 0)
		: undefined;
}

/** The first output item of a node in a run of the workflow. */
export function readNodeOutput(runData: RunData | undefined, nodeName: string) {
	return runData ? firstOutputItem(runData, nodeName) : undefined;
}

/** The text of a value in a field of a case. */
export const fieldText = (value: unknown): string =>
	typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);

/** The values of the input fields of a case, read from an input item of the AI node. */
export function inputValues(item: Record<string, unknown> | undefined): Record<string, string> {
	if (!item) return {};
	return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, fieldText(value)]));
}

/** The names of the input fields of a case. Without a known input, one field `input`. */
export function inputFieldNames(item: Record<string, unknown> | undefined): string[] {
	const names = item ? Object.keys(item) : [];
	return names.length ? names : [FALLBACK_INPUT_FIELD_NAME];
}

/**
 * The answer of the AI node as text: the field `output`, `text` or `response`, the only field, or
 * the whole item. The string-based checks read the answer the same way.
 */
export function answerText(json: unknown): string {
	if (json === null || json === undefined) return '';
	if (!isRecord(json)) return typeof json === 'object' ? JSON.stringify(json) : String(json);
	const answer = json.output ?? json.text ?? json.response;
	if (answer !== undefined && answer !== null) {
		return typeof answer === 'object' ? JSON.stringify(answer) : String(answer);
	}
	const keys = Object.keys(json);
	if (keys.length === 1) {
		const only = json[keys[0]];
		return typeof only === 'object' && only !== null ? JSON.stringify(only) : String(only);
	}
	return JSON.stringify(json);
}

// #endregion

// #region The config

const quote = (text: string) => text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const nodeJson = (nodeName: string) => `$('${quote(nodeName)}').first().json`;

/** An expression that reads a field of the dataset row, which the trigger gives. */
const datasetField = (triggerName: string, field: string) =>
	`={{ ${nodeJson(triggerName)}[${JSON.stringify(field)}] }}`;

/** An expression with the answer of the AI node as text, as `answerText` reads it. */
const answerExpression = (aiNodeName: string) =>
	`={{ (() => { const j = ${nodeJson(aiNodeName)}; if (j === null || j === undefined) return ''; if (typeof j !== 'object') return String(j); const p = j.output ?? j.text ?? j.response; if (p !== undefined && p !== null) return typeof p === 'object' ? JSON.stringify(p) : String(p); const ks = Object.keys(j); if (ks.length === 1) { const o = j[ks[0]]; return typeof o === 'object' && o !== null ? JSON.stringify(o) : String(o); } return JSON.stringify(j); })() }}`;

/** An expression of a custom check in the form of an n8n expression. */
export function customExpression(expression: string): string {
	const trimmed = expression.trim();
	if (!trimmed) return '';
	return trimmed.startsWith('=') ? trimmed : `={{ ${trimmed} }}`;
}

const providerNodeType = (provider: string) =>
	Object.entries(LM_SUBNODE_TYPE_TO_CHATHUB_PROVIDER).find(([, name]) => name === provider)?.[0];

/** The provider name of a chat model node type, or the type itself. */
export const chatHubProvider = (nodeType: string) =>
	LM_SUBNODE_TYPE_TO_CHATHUB_PROVIDER[nodeType] ?? nodeType;

export interface ConfigInput {
	workflowName: string;
	dataTableId: string;
	aiNodeName: string;
	triggerName: string;
	startNodeName: string;
	inputFields: string[];
	metricKeys: CannedMetricKey[];
	judgeSelectionByMetric: Partial<Record<CannedMetricKey, JudgeSelection>>;
	customChecks: CustomCheck[];
}

function judgeConfig(input: ConfigInput, key: 'correctness' | 'helpfulness') {
	const selection = input.judgeSelectionByMetric[key];
	const provider = selection ? providerNodeType(selection.provider) : undefined;
	if (!selection?.credentialId || !selection.model || !provider) {
		throw new Error(`Missing model selection for ${key}`);
	}
	const actualAnswer = `={{ JSON.stringify(${nodeJson(input.aiNodeName)}) }}`;
	return {
		preset: key,
		provider,
		credentialId: selection.credentialId,
		model: selection.model,
		outputType: 'numeric' as const,
		inputs:
			key === 'correctness'
				? { actualAnswer, expectedAnswer: datasetField(input.triggerName, 'expectedAnswer') }
				: { actualAnswer, userQuery: datasetField(input.triggerName, input.inputFields[0]) },
	};
}

function cannedMetricDto(input: ConfigInput, key: CannedMetricKey): EvaluationMetric {
	const id = nanoid();
	const textInputs = () => ({
		actualAnswer: answerExpression(input.aiNodeName),
		expectedAnswer: datasetField(input.triggerName, 'expectedAnswer'),
	});
	switch (key) {
		case 'correctness':
		case 'helpfulness':
			return { id, name: key, type: 'llm_judge', config: judgeConfig(input, key) };
		case 'stringSimilarity':
			return { id, name: key, type: 'string_similarity', config: { inputs: textInputs() } };
		case 'categorization':
			return { id, name: key, type: 'categorization', config: { inputs: textInputs() } };
		case 'toolsUsed':
			return {
				id,
				name: key,
				type: 'tools_used',
				config: {
					inputs: {
						expectedTools: datasetField(input.triggerName, 'expectedTools'),
						intermediateSteps: `={{ ${nodeJson(input.aiNodeName)}.intermediateSteps }}`,
					},
				},
			};
	}
}

/**
 * The config that the Tests panel saves. The checks keep their order, and the custom checks come
 * last. A check with an AI judge needs a model; without it the build throws.
 */
export function buildEvaluationConfig(input: ConfigInput): UpsertEvaluationConfigDto {
	const metrics: EvaluationMetric[] = [
		...input.metricKeys.map((key) => cannedMetricDto(input, key)),
		...input.customChecks.map(
			(check): EvaluationMetric => ({
				id: nanoid(),
				name: check.name,
				type: 'expression',
				config: { expression: customExpression(check.expression), outputType: 'numeric' },
			}),
		),
	];
	return {
		name: `Evaluation: ${input.workflowName}`,
		datasetSource: 'data_table',
		datasetRef: { dataTableId: input.dataTableId },
		startNodeName: input.startNodeName,
		endNodeName: input.aiNodeName,
		metrics,
	};
}

/** The columns of the dataset: the input fields, the expected fields and the case name. */
export function requiredColumns(inputFields: string[], metricKeys: CannedMetricKey[]): string[] {
	return [
		...new Set([...inputFields, ...getExpectedFieldsForMetrics(metricKeys), TEST_CASE_NAME_COLUMN]),
	];
}

/** The state of the panel that a saved config gives. */
export interface HydratedConfig {
	metricKeys: CannedMetricKey[];
	judgeSelectionByMetric: Partial<Record<CannedMetricKey, JudgeSelection>>;
	customChecks: CustomCheck[];
}

const CANNED_KEYS = CANNED_METRICS.map((metric) => metric.key);
const isCannedKey = (name: string): name is CannedMetricKey =>
	CANNED_KEYS.some((key) => key === name);

/** Reads the checks of a saved config. A custom check gets a new ID. */
export function hydrateConfig(metrics: EvaluationMetric[]): HydratedConfig {
	const result: HydratedConfig = { metricKeys: [], judgeSelectionByMetric: {}, customChecks: [] };
	for (const metric of metrics) {
		if (metric.type === 'expression') {
			result.customChecks.push({
				id: nanoid(),
				name: metric.name,
				expression: metric.config.expression,
			});
			continue;
		}
		if (!isCannedKey(metric.name)) continue;
		result.metricKeys.push(metric.name);
		if (metric.type === 'llm_judge') {
			result.judgeSelectionByMetric[metric.name] = {
				provider: chatHubProvider(metric.config.provider),
				credentialId: metric.config.credentialId,
				model: metric.config.model,
			};
		}
	}
	return result;
}

// #endregion
