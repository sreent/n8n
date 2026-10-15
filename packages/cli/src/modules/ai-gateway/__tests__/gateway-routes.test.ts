import { documentAiLocation, endpointOf, isSafeRest, parseGatewayPath } from '../gateway-routes';

describe('parseGatewayPath', () => {
	it('finds the provider and the rest of the path', () => {
		const parsed = parseGatewayPath('/v1/gateway/openai/v1/chat/completions');
		expect(parsed?.provider.slug).toBe('openai');
		expect(parsed?.rest).toBe('/chat/completions');
		expect(parsed?.attribution).toEqual({});
	});

	it('reads the execution, the workflow and the project of the attribution', () => {
		const parsed = parseGatewayPath(
			'/v1/gateway/exec/29021/R9JFXwkUCL1jZBuw%7Cnr6r2FfB0mVeqZP1/anthropic/v1/messages',
		);
		expect(parsed?.provider.slug).toBe('anthropic');
		expect(parsed?.rest).toBe('/v1/messages');
		expect(parsed?.attribution).toEqual({
			executionId: '29021',
			workflowId: 'R9JFXwkUCL1jZBuw',
			projectId: 'nr6r2FfB0mVeqZP1',
		});
	});

	it('reads an agent', () => {
		const parsed = parseGatewayPath('/v1/gateway/exec/agent/AG123%7CP1/google/v1beta/models');
		expect(parsed?.attribution).toEqual({ agentId: 'AG123', projectId: 'P1' });
		expect(parsed?.rest).toBe('/v1beta/models');
	});

	it('needs the version segment of the OpenAI path', () => {
		expect(parseGatewayPath('/v1/gateway/openai/chat/completions')).toBeUndefined();
	});

	it('gives nothing for an unknown provider or an unsafe path', () => {
		expect(parseGatewayPath('/v1/gateway/unknown/v1/chat')).toBeUndefined();
		expect(parseGatewayPath('/v1/gateway/ollama/api/%2e%2e/secret')).toBeUndefined();
		expect(parseGatewayPath('/v1/gateway/ollama/api//chat')).toBeUndefined();
		expect(parseGatewayPath('/other/openai/v1/models')).toBeUndefined();
	});
});

describe('isSafeRest', () => {
	it.each(['', '/chat/completions', '/v1beta/models/gemini-2.5-flash:generateContent'])(
		'accepts %s',
		(rest) => expect(isSafeRest(rest)).toBe(true),
	);

	it.each(['chat', '/a/../b', '/a/%2E%2E/b', '/a\\b', '/a//b', '/%E0%A4%A'])('refuses %s', (rest) =>
		expect(isSafeRest(rest)).toBe(false),
	);
});

describe('endpointOf', () => {
	it('meters the text endpoints of the OpenAI format, and asks for the usage of a stream', () => {
		expect(endpointOf('openai', 'POST', '/chat/completions')).toEqual({
			kind: 'metered',
			model: 'body',
			streamUsage: 'openai',
		});
		expect(endpointOf('openai', 'POST', '/compatible-mode/v1/chat/completions')).toMatchObject({
			kind: 'metered',
		});
		expect(endpointOf('openai', 'POST', '/responses')).toEqual({ kind: 'metered', model: 'body' });
		expect(endpointOf('openai', 'POST', '/embeddings')).toEqual({ kind: 'metered', model: 'body' });
	});

	it('serves the model lists and refuses the other endpoints', () => {
		expect(endpointOf('openai', 'GET', '/models')).toEqual({ kind: 'models' });
		expect(endpointOf('openai', 'GET', '/models/gpt-4o')).toEqual({ kind: 'free' });
		expect(endpointOf('openai', 'POST', '/moderations')).toEqual({ kind: 'free' });
		expect(endpointOf('openai', 'POST', '/images/generations')).toBeUndefined();
		expect(endpointOf('openai', 'POST', '/audio/transcriptions')).toBeUndefined();
		expect(endpointOf('openai', 'POST', '/files')).toBeUndefined();
	});

	it('knows the endpoints of Anthropic', () => {
		expect(endpointOf('anthropic', 'POST', '/v1/messages')).toEqual({
			kind: 'metered',
			model: 'body',
		});
		expect(endpointOf('anthropic', 'POST', '/v1/messages/count_tokens')).toEqual({ kind: 'free' });
		expect(endpointOf('anthropic', 'GET', '/v1/models')).toEqual({ kind: 'models' });
		expect(endpointOf('anthropic', 'POST', '/v1/files')).toBeUndefined();
	});

	it('takes the model of a Gemini call from the path', () => {
		expect(
			endpointOf('gemini', 'POST', '/v1beta/models/gemini-2.5-flash:streamGenerateContent'),
		).toEqual({ kind: 'metered', model: { fromPath: 'gemini-2.5-flash' } });
		expect(
			endpointOf('gemini', 'POST', '/v1beta/models/gemini-embedding-001:embedContent'),
		).toEqual({
			kind: 'metered',
			model: { fromPath: 'gemini-embedding-001' },
			embedding: 'gemini',
		});
		expect(endpointOf('gemini', 'POST', '/v1beta/models/gemini-2.5-flash:countTokens')).toEqual({
			kind: 'free',
		});
		expect(endpointOf('gemini', 'GET', '/v1beta/models')).toEqual({ kind: 'models' });
	});

	it('lets the analysis of Gemini upload files, and refuses the other file endpoints', () => {
		expect(endpointOf('gemini', 'POST', '/upload/v1beta/files')).toEqual({ kind: 'free' });
		expect(endpointOf('gemini', 'GET', '/v1beta/files/abc-123')).toEqual({ kind: 'free' });
		expect(endpointOf('gemini', 'GET', '/v1beta/files')).toBeUndefined();
		expect(endpointOf('gemini', 'DELETE', '/v1beta/files/abc-123')).toBeUndefined();
		expect(endpointOf('gemini', 'POST', '/v1beta/fileSearchStores')).toBeUndefined();
	});

	it('meters the text detection of the Cloud Vision API and the processors of Document AI', () => {
		const process = '/v1/projects/acme/locations/eu/processors/abc123:process';
		expect(endpointOf('google-ocr', 'POST', '/v1/images:annotate')).toEqual({
			kind: 'metered',
			model: { fromPath: 'vision-ocr' },
		});
		expect(endpointOf('google-ocr', 'POST', '/v1/files:annotate')).toEqual({
			kind: 'metered',
			model: { fromPath: 'vision-ocr' },
		});
		expect(endpointOf('google-ocr', 'POST', process)).toEqual({
			kind: 'metered',
			model: { fromPath: 'document-ai' },
		});
		expect(
			endpointOf(
				'google-ocr',
				'POST',
				'/v1/projects/acme/locations/us/processors/a/processorVersions/v1:process',
			),
		).toMatchObject({ kind: 'metered' });
		expect(documentAiLocation(process)).toBe('eu');
		expect(documentAiLocation('/v1/images:annotate')).toBeUndefined();
		expect(endpointOf('google-ocr', 'POST', '/v1/images:asyncBatchAnnotate')).toBeUndefined();
		expect(endpointOf('google-ocr', 'GET', '/v1/images:annotate')).toBeUndefined();
		expect(
			endpointOf('google-ocr', 'POST', '/v1/projects/acme/locations/eu/processors'),
		).toBeUndefined();
	});

	it('knows the native and the OpenAI-format endpoints of Ollama', () => {
		expect(endpointOf('ollama', 'POST', '/api/chat')).toEqual({ kind: 'metered', model: 'body' });
		expect(endpointOf('ollama', 'GET', '/api/tags')).toEqual({ kind: 'free' });
		expect(endpointOf('ollama', 'POST', '/v1/chat/completions')).toMatchObject({ kind: 'metered' });
		expect(endpointOf('ollama', 'DELETE', '/api/delete')).toBeUndefined();
	});
});
