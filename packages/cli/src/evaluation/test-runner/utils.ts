import type { IRunData } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

/** `true` for a parameter value that has content: not empty text, an empty list or an empty object. */
export function checkNodeParameterNotEmpty(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === 'string') return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === 'object') return Object.keys(value).length > 0;
	return true;
}

export type TokenUsage = {
	completionTokens: number;
	promptTokens: number;
	totalTokens: number;
};

function isTokenUsage(value: unknown): value is Partial<TokenUsage> {
	return typeof value === 'object' && value !== null;
}

/** The sum of the token usage that the language model sub-nodes of an execution report. */
export function extractTokenUsage(runData: IRunData): TokenUsage {
	const usage: TokenUsage = { completionTokens: 0, promptTokens: 0, totalTokens: 0 };
	for (const tasks of Object.values(runData)) {
		for (const task of tasks) {
			for (const branch of task.data?.[NodeConnectionTypes.AiLanguageModel] ?? []) {
				for (const item of branch ?? []) {
					const reported = item.json.tokenUsage ?? item.json.tokenUsageEstimate;
					if (!isTokenUsage(reported)) continue;
					usage.completionTokens += Number(reported.completionTokens ?? 0) || 0;
					usage.promptTokens += Number(reported.promptTokens ?? 0) || 0;
					usage.totalTokens += Number(reported.totalTokens ?? 0) || 0;
				}
			}
		}
	}
	return usage;
}
