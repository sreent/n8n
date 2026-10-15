import {
	AZURE_DEPLOYMENT_NAME,
	formatUsd,
	GOOGLE_CLOUD_PROJECT,
	parseDeployments,
	priceRows,
	VERTEX_LOCATION,
	withAdminPrice,
} from './ai-gateway.utils';

describe('formatUsd', () => {
	it('shows two decimals, and more for a small amount when asked', () => {
		expect(formatUsd(12.5)).toBe('$12.50');
		expect(formatUsd(0.0075, 4)).toBe('$0.0075');
		expect(formatUsd(1234)).toBe('$1,234.00');
	});
});

describe('priceRows', () => {
	it('puts the prices of the admin in place of the list prices, by provider and model', () => {
		const rows = priceRows(
			{
				openai: {
					'gpt-4o': { input: 2.5, output: 10 },
					'gpt-4o-mini': { input: 0.15, output: 0.6 },
				},
				anthropic: { 'claude-haiku-4-5': { input: 1, output: 5 } },
			},
			{
				openai: { 'gpt-4o': { input: 2, output: 8 } },
				ollama: { 'llama3.2': { input: 0.1, output: 0.1 } },
			},
		);

		expect(rows.map((row) => `${row.provider}/${row.model}/${row.source}`)).toEqual([
			'anthropic/claude-haiku-4-5/list',
			'ollama/llama3.2/admin',
			'openai/gpt-4o/admin',
			'openai/gpt-4o-mini/list',
		]);
		expect(rows[2]).toMatchObject({
			price: { input: 2, output: 8 },
			listPrice: { input: 2.5, output: 10 },
		});
	});
});

describe('withAdminPrice', () => {
	it('sets a price and removes it again, without empty providers', () => {
		const set = withAdminPrice({}, 'openai', 'gpt-x', { input: 1, output: 2 });
		expect(set).toEqual({ openai: { 'gpt-x': { input: 1, output: 2 } } });

		expect(withAdminPrice(set, 'openai', 'gpt-x', undefined)).toEqual({});
	});

	it('does not change the prices that it gets', () => {
		const prices = { openai: { 'gpt-x': { input: 1, output: 2 } } };
		withAdminPrice(prices, 'openai', 'gpt-y', { input: 3, output: 4 });
		expect(prices).toEqual({ openai: { 'gpt-x': { input: 1, output: 2 } } });
	});
});

describe('the options of the backends', () => {
	it('reads the deployments of a text with commas, spaces and line breaks', () => {
		expect(parseDeployments(' gpt-4o, chat-prod\ngpt-4o  ,')).toEqual(['gpt-4o', 'chat-prod']);
		expect(parseDeployments('')).toEqual([]);
	});

	it('checks the project, the location and the deployments as the backend does', () => {
		expect(GOOGLE_CLOUD_PROJECT.test('acme-ai')).toBe(true);
		expect(GOOGLE_CLOUD_PROJECT.test('123456789')).toBe(true);
		expect(GOOGLE_CLOUD_PROJECT.test('Acme/../x')).toBe(false);
		expect(VERTEX_LOCATION.test('europe-west4')).toBe(true);
		expect(VERTEX_LOCATION.test('us')).toBe(true);
		expect(VERTEX_LOCATION.test('us/central')).toBe(false);
		expect(AZURE_DEPLOYMENT_NAME.test('gpt-4o_prod.v2')).toBe(true);
		expect(AZURE_DEPLOYMENT_NAME.test('bad/name')).toBe(false);
	});
});
