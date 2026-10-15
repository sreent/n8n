import { costOf, findPrice, LIST_PRICES, modelPriceKeys } from '../prices';

describe('modelPriceKeys', () => {
	it.each([
		['gpt-4o-2024-08-06', ['gpt-4o-2024-08-06', 'gpt-4o']],
		['claude-sonnet-4-5-20250929', ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5']],
		['models/gemini-2.5-flash', ['gemini-2.5-flash']],
		['gemini-2.5-flash-preview-05-20', ['gemini-2.5-flash-preview-05-20', 'gemini-2.5-flash']],
		['kimi-k2-0905-preview', ['kimi-k2-0905-preview', 'kimi-k2-0905', 'kimi-k2']],
		['gpt-4o-mini', ['gpt-4o-mini']],
	])('gives the keys of %s', (model, keys) => expect(modelPriceKeys(model)).toEqual(keys));
});

describe('findPrice', () => {
	it('finds the own entry of a model before the entry without a suffix', () => {
		expect(findPrice(LIST_PRICES.openai, 'gpt-4o-mini')).toEqual(LIST_PRICES.openai['gpt-4o-mini']);
		expect(findPrice(LIST_PRICES.openai, 'gpt-4o-2024-08-06')).toEqual(
			LIST_PRICES.openai['gpt-4o'],
		);
	});

	it('gives nothing for an unknown model or table', () => {
		expect(findPrice(LIST_PRICES.openai, 'gpt-unknown')).toBeUndefined();
		expect(findPrice(undefined, 'gpt-4o')).toBeUndefined();
		expect(findPrice(LIST_PRICES.openai, 'constructor')).toBeUndefined();
	});
});

describe('costOf', () => {
	it('prices the tokens for one million tokens, with the cached input price', () => {
		const price = { input: 2, output: 8, cachedInput: 0.5 };
		expect(
			costOf(price, { inputTokens: 1_000_000, outputTokens: 500_000, cachedInputTokens: 200_000 }),
		).toBeCloseTo(0.8 * 2 + 0.2 * 0.5 + 0.5 * 8);
	});

	it('uses the input price for cached tokens without a cached price', () => {
		expect(
			costOf(
				{ input: 1, output: 1 },
				{ inputTokens: 100, outputTokens: 0, cachedInputTokens: 100 },
			),
		).toBeCloseTo(0.0001);
	});
});
