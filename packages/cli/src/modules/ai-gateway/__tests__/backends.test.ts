import {
	azureOpenAiBaseUrl,
	geminiModelCall,
	geminiModelInfo,
	geminiModelList,
	openAiModelList,
	projectOfServiceAccount,
	vertexHost,
	vertexModelPath,
	vertexTarget,
} from '../backends';
import { AI_GATEWAY_PROVIDERS, backendOf, credentialTypesOf, providerBySlug } from '../providers';

/** Fork test (not in upstream n8n): the backends of the AI gateway. See `../README.md`. */

describe('azureOpenAiBaseUrl', () => {
	it('builds the v1 URL from the resource name', () => {
		expect(azureOpenAiBaseUrl({ endpointType: 'classic', resourceName: 'acme-ai' })).toBe(
			'https://acme-ai.openai.azure.com/openai/v1',
		);
	});

	it.each([
		[
			'https://acme.cognitiveservices.azure.com',
			'https://acme.cognitiveservices.azure.com/openai/v1',
		],
		['https://acme.openai.azure.com/', 'https://acme.openai.azure.com/openai/v1'],
		['https://acme.openai.azure.com/openai', 'https://acme.openai.azure.com/openai/v1'],
		['https://acme.openai.azure.com/openai/v1/', 'https://acme.openai.azure.com/openai/v1'],
	])('prefers the endpoint %s of a classic credential', (endpoint, expected) => {
		expect(azureOpenAiBaseUrl({ resourceName: 'other', endpoint })).toBe(expected);
	});

	it('takes the full endpoint of an Azure AI Foundry credential', () => {
		expect(
			azureOpenAiBaseUrl({
				endpointType: 'foundry',
				foundryEndpoint: 'https://acme.services.ai.azure.com/openai/v1',
				endpoint: 'https://ignored.openai.azure.com',
			}),
		).toBe('https://acme.services.ai.azure.com/openai/v1');
	});

	it('gives undefined without an endpoint and a valid resource name', () => {
		expect(azureOpenAiBaseUrl({})).toBeUndefined();
		expect(azureOpenAiBaseUrl({ resourceName: 'evil.example.com/x' })).toBeUndefined();
		expect(azureOpenAiBaseUrl({ endpointType: 'foundry', resourceName: 'acme' })).toBeUndefined();
	});
});

describe('Vertex AI', () => {
	it.each([
		['global', 'aiplatform.googleapis.com'],
		['us', 'aiplatform.us.rep.googleapis.com'],
		['eu', 'aiplatform.eu.rep.googleapis.com'],
		['europe-west4', 'europe-west4-aiplatform.googleapis.com'],
	])('gives the host of the location %s', (location, host) => {
		expect(vertexHost(location)).toBe(host);
	});

	it('reads the project from the e-mail of a service account', () => {
		expect(projectOfServiceAccount('n8n@acme-prod-123.iam.gserviceaccount.com')).toBe(
			'acme-prod-123',
		);
		expect(projectOfServiceAccount('123-compute@developer.gserviceaccount.com')).toBeUndefined();
		expect(projectOfServiceAccount('someone@example.com')).toBeUndefined();
	});

	it('takes the project and the location from the settings first, then from the credential', () => {
		const credential = { email: 'n8n@acme-prod.iam.gserviceaccount.com', region: 'europe-west4' };
		expect(vertexTarget({}, credential)).toEqual({
			project: 'acme-prod',
			location: 'europe-west4',
		});
		expect(vertexTarget({ projectId: 'other-project', location: 'us' }, credential)).toEqual({
			project: 'other-project',
			location: 'us',
		});
		expect(vertexTarget({}, { email: credential.email })).toEqual({
			project: 'acme-prod',
			location: 'global',
		});
		expect(vertexTarget({}, { email: 'someone@example.com' })).toBeUndefined();
	});

	it('maps a call of the Gemini API to the path of Vertex AI', () => {
		const call = geminiModelCall('/v1beta/models/gemini-2.5-flash:streamGenerateContent');
		expect(call).toEqual({ model: 'gemini-2.5-flash', action: 'streamGenerateContent' });
		expect(
			vertexModelPath(
				{ project: 'acme-prod', location: 'global' },
				'gemini-2.5-flash',
				'generateContent',
			),
		).toBe(
			'/v1/projects/acme-prod/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
		);
		expect(geminiModelCall('/v1beta/models')).toBeUndefined();
		expect(geminiModelCall('/upload/v1beta/files')).toBeUndefined();
		expect(geminiModelInfo('/v1beta/models/gemini-2.5-pro')).toBe('gemini-2.5-pro');
		expect(geminiModelInfo('/v1beta/files/abc')).toBeUndefined();
	});

	it('gives model lists in the formats of the Gemini API and the OpenAI API', () => {
		expect(geminiModelList(['gemini-2.5-flash', 'gemini-embedding-001']).models).toEqual([
			expect.objectContaining({
				name: 'models/gemini-2.5-flash',
				supportedGenerationMethods: ['generateContent', 'countTokens'],
			}),
			expect.objectContaining({
				name: 'models/gemini-embedding-001',
				supportedGenerationMethods: ['embedContent', 'batchEmbedContents'],
			}),
		]);
		expect(openAiModelList(['gpt-4o-prod'])).toEqual({
			object: 'list',
			data: [{ id: 'gpt-4o-prod', object: 'model', created: 0, owned_by: 'azure' }],
		});
	});
});

describe('providers', () => {
	it('gives the backends of OpenAI and Google Gemini', () => {
		const openai = providerBySlug('openai');
		const google = providerBySlug('google');
		if (!openai || !google) throw new Error('missing provider');
		expect(credentialTypesOf(openai)).toEqual(['openAiApi', 'azureOpenAiApi']);
		expect(backendOf(openai, 'azureOpenAiApi')?.kind).toBe('azure-openai');
		expect(backendOf(openai, 'openAiApi')).toBeUndefined();
		expect(credentialTypesOf(google)).toEqual(['googlePalmApi', 'googleApi']);
		expect(backendOf(google, 'googleApi')?.kind).toBe('vertex-ai');
	});

	it('uses each backend credential type for one provider only', () => {
		const backendTypes = AI_GATEWAY_PROVIDERS.flatMap((provider) =>
			(provider.backends ?? []).map((backend) => backend.credentialType),
		);
		const ownTypes = AI_GATEWAY_PROVIDERS.map((provider) => provider.credentialType);
		expect(new Set(backendTypes).size).toBe(backendTypes.length);
		expect(backendTypes.filter((type) => ownTypes.includes(type))).toEqual([]);
	});
});
