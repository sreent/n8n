/**
 * The list prices of common models, in US dollars for one million tokens. The fork read them from
 * the public price pages of the providers on 2026-10-15. Prices change: an admin checks them, and
 * changes them or adds models on the page Settings > AI gateway. A model without a price is
 * blocked. See `README.md`, "Prices".
 */

export interface AiGatewayModelPrice {
	/** Dollars for one million input tokens. */
	input: number;
	/** Dollars for one million output tokens. */
	output: number;
	/** Dollars for one million cached input tokens. The input price applies when it is unset. */
	cachedInput?: number;
}

/** The date when the fork read the list prices. */
export const LIST_PRICES_DATE = '2026-10-15';

/** List prices by provider slug and model. A model matches its own entry or a dated version. */
export const LIST_PRICES: Readonly<Record<string, Readonly<Record<string, AiGatewayModelPrice>>>> =
	{
		openai: {
			'gpt-5': { input: 1.25, output: 10, cachedInput: 0.125 },
			'gpt-5-mini': { input: 0.25, output: 2, cachedInput: 0.025 },
			'gpt-5-nano': { input: 0.05, output: 0.4, cachedInput: 0.005 },
			'gpt-4.1': { input: 2, output: 8, cachedInput: 0.5 },
			'gpt-4.1-mini': { input: 0.4, output: 1.6, cachedInput: 0.1 },
			'gpt-4.1-nano': { input: 0.1, output: 0.4, cachedInput: 0.025 },
			'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 },
			'gpt-4o-mini': { input: 0.15, output: 0.6, cachedInput: 0.075 },
			o3: { input: 2, output: 8, cachedInput: 0.5 },
			'o4-mini': { input: 1.1, output: 4.4, cachedInput: 0.275 },
			'o3-mini': { input: 1.1, output: 4.4, cachedInput: 0.55 },
			'text-embedding-3-small': { input: 0.02, output: 0 },
			'text-embedding-3-large': { input: 0.13, output: 0 },
			'text-embedding-ada-002': { input: 0.1, output: 0 },
		},
		anthropic: {
			'claude-opus-4-1': { input: 15, output: 75, cachedInput: 1.5 },
			'claude-opus-4': { input: 15, output: 75, cachedInput: 1.5 },
			'claude-sonnet-4-5': { input: 3, output: 15, cachedInput: 0.3 },
			'claude-sonnet-4': { input: 3, output: 15, cachedInput: 0.3 },
			'claude-haiku-4-5': { input: 1, output: 5, cachedInput: 0.1 },
			'claude-3-7-sonnet': { input: 3, output: 15, cachedInput: 0.3 },
			'claude-3-5-haiku': { input: 0.8, output: 4, cachedInput: 0.08 },
		},
		google: {
			'gemini-2.5-pro': { input: 1.25, output: 10, cachedInput: 0.31 },
			'gemini-2.5-flash': { input: 0.3, output: 2.5, cachedInput: 0.075 },
			'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cachedInput: 0.025 },
			'gemini-2.0-flash': { input: 0.1, output: 0.4, cachedInput: 0.025 },
			'gemini-2.0-flash-lite': { input: 0.075, output: 0.3 },
			'gemini-embedding-001': { input: 0.15, output: 0 },
			'text-embedding-004': { input: 0, output: 0 },
		},
		xai: {
			'grok-4': { input: 3, output: 15, cachedInput: 0.75 },
			'grok-3': { input: 3, output: 15, cachedInput: 0.75 },
			'grok-3-mini': { input: 0.3, output: 0.5, cachedInput: 0.075 },
		},
		deepseek: {
			'deepseek-chat': { input: 0.28, output: 0.42, cachedInput: 0.028 },
			'deepseek-reasoner': { input: 0.28, output: 0.42, cachedInput: 0.028 },
		},
		moonshot: {
			'kimi-k2': { input: 0.6, output: 2.5, cachedInput: 0.15 },
		},
		minimax: {
			'MiniMax-M2': { input: 0.3, output: 1.2, cachedInput: 0.03 },
		},
		// Pages and images, not tokens: $1.50 for 1,000 pages is $1,500 for one million. The text
		// detection of the Cloud Vision API and the Enterprise Document OCR of Document AI. Other
		// processors of Document AI cost more: an admin sets their price.
		'google-ocr': {
			'vision-ocr': { input: 1500, output: 0 },
			'document-ai': { input: 1500, output: 0 },
		},
	};

const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4}|latest|preview(-[\w-]+)?|exp(-[\w-]+)?)$/;

/**
 * The price key of a model id: the id itself, else the id without a date or preview suffix (for
 * example `gpt-4o-2024-08-06` gives `gpt-4o`, `claude-sonnet-4-5-20250929` gives
 * `claude-sonnet-4-5`). A Gemini id can start with `models/`.
 */
export function modelPriceKeys(model: string) {
	const id = model.replace(/^models\//, '');
	const keys = [id];
	let current = id;
	while (DATE_SUFFIX.test(current)) {
		current = current.replace(DATE_SUFFIX, '');
		keys.push(current);
	}
	return keys;
}

/** The price of a model in a table: its own entry, else the entry of its id without a suffix. */
export function findPrice(
	table: Readonly<Record<string, AiGatewayModelPrice>> | undefined,
	model: string,
): AiGatewayModelPrice | undefined {
	if (!table) return undefined;
	for (const key of modelPriceKeys(model)) {
		if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
	}
	return undefined;
}

/** The cost in dollars of the tokens of one call. */
export function costOf(
	price: AiGatewayModelPrice,
	tokens: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
) {
	const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
	const uncached = tokens.inputTokens - cached;
	const cachedPrice = price.cachedInput ?? price.input;
	return (uncached * price.input + cached * cachedPrice + tokens.outputTokens * price.output) / 1e6;
}
