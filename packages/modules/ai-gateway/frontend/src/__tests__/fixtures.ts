import type {
	AiGatewayOverview,
	AiGatewayPriceTable,
	AiGatewaySettingsResponse,
	AiGatewayTopUp,
	AiGatewayUsagePage,
} from '../ai-gateway.api';

export const settingsResponse = (): AiGatewaySettingsResponse => ({
	settings: {
		enabled: true,
		providers: { openai: { credentialId: 'cred-openai' } },
		monthlyBudget: 100,
		userMonthlyLimit: null,
		projectBudgets: { 'project-a': 20 },
		prices: { openai: { 'gpt-custom': { input: 1, output: 2 } } },
	},
	providers: [
		{
			slug: 'openai',
			displayName: 'OpenAI',
			credentialType: 'openAiApi',
			priceUnit: 'tokens',
			backends: [
				{ kind: 'azure-openai', credentialType: 'azureOpenAiApi', displayName: 'Azure OpenAI' },
				{ kind: 'vertex-openai', credentialType: 'googleApi', displayName: 'Vertex AI' },
			],
			credential: { id: 'cred-openai', name: 'Org OpenAI', type: 'openAiApi' },
			credentialOptions: [
				{ id: 'cred-openai', name: 'Org OpenAI', type: 'openAiApi' },
				{ id: 'cred-openai-2', name: 'Second OpenAI', type: 'openAiApi' },
				{ id: 'cred-azure', name: 'Org Azure', type: 'azureOpenAiApi' },
				{ id: 'cred-sa', name: 'Org service account', type: 'googleApi' },
			],
		},
		{
			slug: 'anthropic',
			displayName: 'Anthropic',
			credentialType: 'anthropicApi',
			priceUnit: 'tokens',
			backends: [],
			credential: null,
			credentialOptions: [{ id: 'cred-anthropic', name: 'Org Anthropic', type: 'anthropicApi' }],
		},
		{
			slug: 'google',
			displayName: 'Google Gemini',
			credentialType: 'googlePalmApi',
			priceUnit: 'tokens',
			backends: [{ kind: 'vertex-ai', credentialType: 'googleApi', displayName: 'Vertex AI' }],
			credential: null,
			credentialOptions: [],
		},
		{
			slug: 'google-ocr',
			displayName: 'Google Cloud OCR',
			credentialType: 'googleCloudOcrApi',
			priceUnit: 'pages',
			backends: [
				{ kind: 'google-cloud', credentialType: 'googleApi', displayName: 'Service account' },
			],
			credential: null,
			credentialOptions: [],
		},
	],
	projects: [
		{ id: 'project-a', name: 'Team A' },
		{ id: 'project-b', name: 'Team B' },
	],
	baseUrl: 'http://127.0.0.1:5678/ai-gateway',
});

export const overview = (): AiGatewayOverview => ({
	periodStart: '2026-10-01T00:00:00.000Z',
	periodEnd: '2026-11-01T00:00:00.000Z',
	monthlyBudget: 100,
	spentThisMonth: 12.3456,
	spentFromBudget: 12.3456,
	budgetLeft: 87.6544,
	topUpBalance: 25,
	remaining: 112.6544,
	userMonthlyLimit: null,
	projects: [
		{ projectId: 'project-a', name: 'Team A', monthlyBudget: 20, spentThisMonth: 4.5 },
		{ projectId: 'gone', name: null, monthlyBudget: null, spentThisMonth: 1 },
	],
	spentWithoutProject: 0.25,
});

export const topUps = (): AiGatewayTopUp[] => [
	{
		id: 't1',
		createdAt: '2026-10-02T08:00:00.000Z',
		amount: 25,
		createdById: 'u1',
		createdByEmail: 'owner@example.com',
		note: 'October',
	},
];

export const priceTable = (): AiGatewayPriceTable => ({
	listPricesDate: '2026-10-15',
	listPrices: {
		openai: { 'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 } },
		anthropic: { 'claude-sonnet-4-5': { input: 3, output: 15 } },
		'google-ocr': { 'vision-ocr': { input: 1500, output: 0 } },
	},
	adminPrices: { openai: { 'gpt-custom': { input: 1, output: 2 } } },
});

export const usagePage = (): AiGatewayUsagePage => ({
	count: 1,
	entries: [
		{
			id: 'call-1',
			timestamp: Date.parse('2026-10-03T08:00:00.000Z'),
			provider: 'openai',
			model: 'gpt-4o',
			inputTokens: 1000,
			outputTokens: 500,
			cachedInputTokens: 0,
			cost: 0.0075,
			costFromTopUp: 0,
			userId: 'u2',
			userEmail: 'member@example.com',
			projectId: 'project-a',
			projectName: 'Team A',
		},
	],
});
