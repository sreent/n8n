import {
	azureOpenAiBaseUrl,
	DOCUMENT_AI_PROCESSOR_ENTRY,
	geminiModelCall,
	geminiModelInfo,
	geminiModelList,
	isPublisherModel,
	openAiModelList,
	projectOfServiceAccount,
	servesDocumentAiProcessor,
	vertexChatCompletionsPath,
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

describe('Document AI', () => {
	const processor = 'projects/acme-ocr/locations/eu/processors/abc123';

	it.each([
		'projects/acme-ocr',
		'projects/123456789',
		'projects/example.com:acme-ocr',
		'projects/acme-ocr/locations/eu',
		'projects/acme-ocr/locations/eu/processors/abc123',
	])('accepts the entry %s', (entry) => {
		expect(DOCUMENT_AI_PROCESSOR_ENTRY.test(entry)).toBe(true);
	});

	it.each([
		'acme-ocr',
		'projects/Acme-OCR',
		'projects/acme-ocr/',
		'projects/acme-ocr/locations/eu/processors',
		'projects/acme-ocr/locations/eu/processors/abc123:process',
		'projects/acme-ocr/locations/eu/processors/abc123/processorVersions/v1',
		'projects/acme-ocr/locations/eu/processors/a%2Fb',
		'https://eu-documentai.googleapis.com/v1/projects/acme-ocr/locations/eu/processors/abc123',
	])('refuses the entry %s', (entry) => {
		expect(DOCUMENT_AI_PROCESSOR_ENTRY.test(entry)).toBe(false);
	});

	it('serves all processors without a list, else the processors, locations and projects in it', () => {
		expect(servesDocumentAiProcessor(undefined, processor)).toBe(true);
		expect(servesDocumentAiProcessor([], processor)).toBe(true);
		expect(servesDocumentAiProcessor([processor], processor)).toBe(true);
		expect(servesDocumentAiProcessor(['projects/acme-ocr/locations/eu'], processor)).toBe(true);
		expect(servesDocumentAiProcessor(['projects/acme-ocr'], processor)).toBe(true);

		expect(
			servesDocumentAiProcessor(['projects/acme-ocr/locations/eu/processors/abc'], processor),
		).toBe(false);
		expect(servesDocumentAiProcessor(['projects/acme-ocr/locations/us'], processor)).toBe(false);
		expect(servesDocumentAiProcessor(['projects/acme'], processor)).toBe(false);
		// The project of the path is text: its number is another entry.
		expect(
			servesDocumentAiProcessor(
				['projects/123456789'],
				'projects/acme-ocr/locations/eu/processors/x',
			),
		).toBe(false);
		expect(
			servesDocumentAiProcessor(
				['projects/acme-ocr'],
				'projects/acme-ocr%2Fx/locations/eu/processors/x',
			),
		).toBe(false);
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
		expect(openAiModelList(['gpt-4o-prod'], 'azure')).toEqual({
			object: 'list',
			data: [{ id: 'gpt-4o-prod', object: 'model', created: 0, owned_by: 'azure' }],
		});
	});

	it('knows the models of a publisher, and the path of their Chat Completions', () => {
		expect(isPublisherModel('meta/llama-3.3-70b-instruct-maas')).toBe(true);
		expect(isPublisherModel('deepseek-ai/deepseek-v3.1-maas')).toBe(true);
		expect(isPublisherModel('gpt-4o')).toBe(false);
		expect(isPublisherModel('a/b/c')).toBe(false);
		expect(isPublisherModel('/llama')).toBe(false);
		expect(vertexChatCompletionsPath({ project: 'acme-prod', location: 'us-central1' })).toBe(
			'/v1/projects/acme-prod/locations/us-central1/endpoints/openapi/chat/completions',
		);
	});
});

describe('providers', () => {
	it('gives the backends of OpenAI and Google Gemini', () => {
		const openai = providerBySlug('openai');
		const google = providerBySlug('google');
		if (!openai || !google) throw new Error('missing provider');
		expect(credentialTypesOf(openai)).toEqual(['openAiApi', 'azureOpenAiApi', 'googleApi']);
		expect(backendOf(openai, 'azureOpenAiApi')?.kind).toBe('azure-openai');
		expect(backendOf(openai, 'googleApi')?.kind).toBe('vertex-openai');
		expect(backendOf(openai, 'openAiApi')).toBeUndefined();
		expect(credentialTypesOf(google)).toEqual(['googlePalmApi', 'googleApi']);
		expect(backendOf(google, 'googleApi')?.kind).toBe('vertex-ai');
	});

	it('never uses the own credential type of a provider as a backend', () => {
		const backendTypes = AI_GATEWAY_PROVIDERS.flatMap((provider) =>
			(provider.backends ?? []).map((backend) => backend.credentialType),
		);
		const ownTypes = AI_GATEWAY_PROVIDERS.map((provider) => provider.credentialType);
		expect(backendTypes.filter((type) => ownTypes.includes(type))).toEqual([]);
	});
});
