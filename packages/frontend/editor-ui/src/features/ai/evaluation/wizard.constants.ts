// Fork code (not in upstream n8n): the constants of the evaluation panels of the canvas: the info
// card, the Tests panel and the dataset modal. See `FORK.md` in this folder.
import type { IconName } from '@n8n/design-system';
import type { BaseTextKey } from '@n8n/i18n';

import type { MetricCategory } from './evaluation.types';

/** The checks that the Tests panel offers. */
export type CannedMetricKey =
	| 'correctness'
	| 'helpfulness'
	| 'stringSimilarity'
	| 'categorization'
	| 'toolsUsed';

export interface CannedMetric {
	key: CannedMetricKey;
	labelKey: BaseTextKey;
	/** The label in the menu "Add check" and on the chip. A check without it is not in the menu. */
	optionLabelKey?: BaseTextKey;
	/** The sentence of the check in the configuration of a case. */
	sentenceKey: BaseTextKey;
	descriptionKey: BaseTextKey;
	category: MetricCategory;
	icon: IconName;
}

export const CANNED_METRICS: CannedMetric[] = [
	{
		key: 'correctness',
		labelKey: 'evaluations.wizardSidepanel.metric.correctness.label',
		optionLabelKey: 'evaluations.tests.metric.correctness.option',
		sentenceKey: 'evaluations.tests.metric.correctness.sentence',
		descriptionKey: 'evaluations.wizardSidepanel.metric.correctness.description',
		category: 'aiBased',
		icon: 'badge-check',
	},
	{
		key: 'helpfulness',
		labelKey: 'evaluations.wizardSidepanel.metric.helpfulness.label',
		sentenceKey: 'evaluations.tests.metric.helpfulness.sentence',
		descriptionKey: 'evaluations.wizardSidepanel.metric.helpfulness.description',
		category: 'aiBased',
		icon: 'thumbs-up',
	},
	{
		key: 'stringSimilarity',
		labelKey: 'evaluations.wizardSidepanel.metric.stringSimilarity.label',
		optionLabelKey: 'evaluations.tests.metric.stringSimilarity.option',
		sentenceKey: 'evaluations.tests.metric.stringSimilarity.sentence',
		descriptionKey: 'evaluations.wizardSidepanel.metric.stringSimilarity.description',
		category: 'stringSimilarity',
		icon: 'case-upper',
	},
	{
		key: 'categorization',
		labelKey: 'evaluations.wizardSidepanel.metric.categorization.label',
		sentenceKey: 'evaluations.tests.metric.categorization.sentence',
		descriptionKey: 'evaluations.wizardSidepanel.metric.categorization.description',
		category: 'categorization',
		icon: 'tags',
	},
	{
		key: 'toolsUsed',
		labelKey: 'evaluations.wizardSidepanel.metric.toolsUsed.label',
		optionLabelKey: 'evaluations.tests.metric.toolsUsed.option',
		sentenceKey: 'evaluations.tests.metric.toolsUsed.sentence',
		descriptionKey: 'evaluations.wizardSidepanel.metric.toolsUsed.description',
		category: 'toolsUsed',
		icon: 'wrench',
	},
];

export const isCannedMetricKey = (key: string): key is CannedMetricKey =>
	CANNED_METRICS.some((metric) => metric.key === key);

export const cannedMetric = (key: CannedMetricKey) =>
	CANNED_METRICS.find((metric) => metric.key === key);

/** The checks with an AI judge. They need a model and a credential. */
export const LLM_JUDGE_METRIC_KEYS: CannedMetricKey[] = ['correctness', 'helpfulness'];

export const DEFAULT_SELECTED_METRIC_KEYS: CannedMetricKey[] = ['correctness'];

/** The field of the expected value of each check, as a column of the dataset. */
export const CANNED_METRIC_EXPECTED_FIELDS: Partial<
	Record<CannedMetricKey, { name: string; labelKey: BaseTextKey }>
> = {
	correctness: { name: 'expectedAnswer', labelKey: 'evaluations.tests.detail.expectedAnswer' },
	stringSimilarity: { name: 'expectedAnswer', labelKey: 'evaluations.tests.detail.expectedAnswer' },
	categorization: { name: 'expectedAnswer', labelKey: 'evaluations.tests.detail.expectedAnswer' },
	toolsUsed: { name: 'expectedTools', labelKey: 'evaluations.tests.detail.expectedTools' },
};

/** The names of the expected fields of the checks, once each, in the order of the checks. */
export function getExpectedFieldsForMetrics(keys: CannedMetricKey[]): string[] {
	const names = keys.flatMap((key) => CANNED_METRIC_EXPECTED_FIELDS[key]?.name ?? []);
	return [...new Set(names)];
}

/** The column of the dataset that keeps the name of a case. */
export const TEST_CASE_NAME_COLUMN = 'caseName';

/** The input field of a case when no run of the workflow shows the fields of the AI node. */
export const FALLBACK_INPUT_FIELD_NAME = 'input';

/** The nodes that the Tests panel can test: agents, chains and the model nodes of vendors. */
export const AI_ROOT_NODE_TYPES = [
	'@n8n/n8n-nodes-langchain.agent',
	'@n8n/n8n-nodes-langchain.openAiAssistant',
	'@n8n/n8n-nodes-langchain.chainLlm',
	'@n8n/n8n-nodes-langchain.chainRetrievalQa',
	'@n8n/n8n-nodes-langchain.chainSummarization',
	'@n8n/n8n-nodes-langchain.informationExtractor',
	'@n8n/n8n-nodes-langchain.sentimentAnalysis',
	'@n8n/n8n-nodes-langchain.textClassifier',
	'@n8n/n8n-nodes-langchain.openAi',
	'@n8n/n8n-nodes-langchain.anthropic',
	'@n8n/n8n-nodes-langchain.googleGemini',
	'@n8n/n8n-nodes-langchain.ollama',
	'@n8n/n8n-nodes-langchain.alibabaCloud',
	'@n8n/n8n-nodes-langchain.miniMax',
	'@n8n/n8n-nodes-langchain.moonshot',
];

export const isAiRootNodeType = (type: string) => AI_ROOT_NODE_TYPES.includes(type);

/** The provider of the AI judge for each chat model node. */
export const LM_SUBNODE_TYPE_TO_CHATHUB_PROVIDER: Record<string, string> = {
	'@n8n/n8n-nodes-langchain.lmChatOpenAi': 'openai',
	'@n8n/n8n-nodes-langchain.lmChatAnthropic': 'anthropic',
	'@n8n/n8n-nodes-langchain.lmChatGoogleGemini': 'google',
	'@n8n/n8n-nodes-langchain.lmChatAzureOpenAi': 'azureOpenAi',
	'@n8n/n8n-nodes-langchain.lmChatAwsBedrock': 'awsBedrock',
	'@n8n/n8n-nodes-langchain.lmChatOllama': 'ollama',
	'@n8n/n8n-nodes-langchain.lmChatVercelAiGateway': 'vercelAiGateway',
};

/** The name of the dataset and of the config that the Tests panel makes for a workflow. */
export const getCanonicalEvaluationName = (workflowName: string) => `Evaluation: ${workflowName}`;

/** The Tests panel saves a change after this pause. */
export const AUTO_SAVE_DELAY_MS = 1500;

/** The workflows for which the user closed the info card on the canvas, comma-separated. */
export const CANVAS_INFO_CARD_DISMISSED_KEY = 'N8N_EVALUATIONS_CANVAS_INFO_CARD_DISMISSED';
