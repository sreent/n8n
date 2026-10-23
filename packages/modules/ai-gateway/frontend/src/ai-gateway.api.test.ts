import type { AiGatewaySettings } from '@n8n/api-types';
import { makeRestApiRequest } from '@n8n/rest-api-client';

import { addAiGatewayTopUp, getAiGatewayUsage, updateAiGatewaySettings } from './ai-gateway.api';

vi.mock('@n8n/rest-api-client', () => ({ makeRestApiRequest: vi.fn(async () => ({})) }));

const context = { baseUrl: '/rest', pushRef: '' };

describe('ai-gateway.api', () => {
	beforeEach(() => vi.mocked(makeRestApiRequest).mockClear());

	it('sends the full settings with PUT', async () => {
		const settings: AiGatewaySettings = {
			enabled: true,
			providers: { openai: { credentialId: 'c1' } },
			monthlyBudget: 100,
			userMonthlyLimit: null,
			projectBudgets: {},
			prices: {},
			estimateUsage: true,
		};
		await updateAiGatewaySettings(context, settings);
		expect(makeRestApiRequest).toHaveBeenCalledWith(
			context,
			'PUT',
			'/ai-gateway/settings',
			settings,
		);
	});

	it('sends only the filters that are set, with the page', async () => {
		await getAiGatewayUsage(
			context,
			{ provider: 'openai', model: ' ', projectId: undefined },
			50,
			25,
		);
		expect(makeRestApiRequest).toHaveBeenCalledWith(context, 'GET', '/ai-gateway/usage', {
			provider: 'openai',
			skip: 50,
			take: 25,
		});
	});

	it('adds a top-up', async () => {
		await addAiGatewayTopUp(context, { amount: 25, note: 'October' });
		expect(makeRestApiRequest).toHaveBeenCalledWith(context, 'POST', '/ai-gateway/top-ups', {
			amount: 25,
			note: 'October',
		});
	});
});
