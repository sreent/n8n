import {
	AI_GATEWAY_AZURE_DEPLOYMENT_NAME,
	AI_GATEWAY_DOCUMENT_AI_PROCESSOR_ENTRY,
	AI_GATEWAY_GOOGLE_CLOUD_PROJECT,
	AI_GATEWAY_USAGE_DEFAULT_PAGE_SIZE,
	AI_GATEWAY_USAGE_MAX_PAGE_SIZE,
	AI_GATEWAY_VERTEX_LOCATION,
	AiGatewayAdminUsageQueryDto,
	AiGatewaySettingsDto,
	AiGatewayTopUpDto,
} from '../ai-gateway-admin.dto';

const settings = {
	enabled: true,
	providers: { openai: { credentialId: 'cred-1' } },
	monthlyBudget: 100,
	userMonthlyLimit: null,
	projectBudgets: {},
	prices: {},
};

describe('the patterns of the backends', () => {
	test('check the project, the location and the deployments', () => {
		expect(AI_GATEWAY_GOOGLE_CLOUD_PROJECT.test('acme-ai')).toBe(true);
		expect(AI_GATEWAY_GOOGLE_CLOUD_PROJECT.test('123456789')).toBe(true);
		expect(AI_GATEWAY_GOOGLE_CLOUD_PROJECT.test('Acme/../x')).toBe(false);
		expect(AI_GATEWAY_VERTEX_LOCATION.test('europe-west4')).toBe(true);
		expect(AI_GATEWAY_VERTEX_LOCATION.test('us')).toBe(true);
		expect(AI_GATEWAY_VERTEX_LOCATION.test('us/central')).toBe(false);
		expect(AI_GATEWAY_AZURE_DEPLOYMENT_NAME.test('gpt-4o_prod.v2')).toBe(true);
		expect(AI_GATEWAY_AZURE_DEPLOYMENT_NAME.test('bad/name')).toBe(false);
	});

	test('check the processors of Document AI', () => {
		expect(AI_GATEWAY_DOCUMENT_AI_PROCESSOR_ENTRY.test('projects/acme-ocr')).toBe(true);
		expect(AI_GATEWAY_DOCUMENT_AI_PROCESSOR_ENTRY.test('projects/123456789/locations/us')).toBe(
			true,
		);
		expect(
			AI_GATEWAY_DOCUMENT_AI_PROCESSOR_ENTRY.test(
				'projects/acme-ocr/locations/eu/processors/1a2b3c',
			),
		).toBe(true);
		expect(AI_GATEWAY_DOCUMENT_AI_PROCESSOR_ENTRY.test('acme-ocr')).toBe(false);
		expect(
			AI_GATEWAY_DOCUMENT_AI_PROCESSOR_ENTRY.test(
				'projects/acme-ocr/locations/eu/processors/1a2b3c/processorVersions/v1',
			),
		).toBe(false);
	});
});

describe('AiGatewaySettingsDto', () => {
	test('turns the estimates on for settings without the switch', () => {
		const result = AiGatewaySettingsDto.safeParse(settings);

		expect(result.success).toBe(true);
		expect(result.data?.estimateUsage).toBe(true);
	});

	test.each([
		{
			name: 'a deployment name with a slash',
			request: {
				...settings,
				providers: { openai: { credentialId: 'cred-1', deployments: ['bad/name'] } },
			},
		},
		{
			name: 'a processor entry without a project',
			request: {
				...settings,
				providers: { 'google-cloud-ocr': { credentialId: 'cred-1', documentAiProcessors: ['x'] } },
			},
		},
		{ name: 'a negative budget', request: { ...settings, monthlyBudget: -1 } },
	])('rejects $name', ({ request }) => {
		expect(AiGatewaySettingsDto.safeParse(request).success).toBe(false);
	});
});

describe('AiGatewayTopUpDto', () => {
	test('needs a positive amount', () => {
		expect(AiGatewayTopUpDto.safeParse({ amount: 25, note: ' March ' }).data).toEqual({
			amount: 25,
			note: 'March',
		});
		expect(AiGatewayTopUpDto.safeParse({ amount: 0 }).success).toBe(false);
	});
});

describe('AiGatewayAdminUsageQueryDto', () => {
	test('uses the first page by default', () => {
		expect(AiGatewayAdminUsageQueryDto.safeParse({}).data).toEqual({
			skip: 0,
			take: AI_GATEWAY_USAGE_DEFAULT_PAGE_SIZE,
		});
	});

	test('limits the page size', () => {
		expect(AiGatewayAdminUsageQueryDto.safeParse({ take: '1000' }).data?.take).toBe(
			AI_GATEWAY_USAGE_MAX_PAGE_SIZE,
		);
		expect(AiGatewayAdminUsageQueryDto.safeParse({ take: '0' }).success).toBe(false);
	});
});
