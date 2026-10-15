import type { AiGatewayApiFormat } from '../providers';
import {
	estimateGeminiEmbeddingTokens,
	estimateInputTokens,
	UsageMeter,
	usageOf,
} from '../usage-meter';

const encode = (text: string) => new TextEncoder().encode(text);

/** Feeds the text in small pieces, so that events and lines cross the chunks. */
function fed(format: AiGatewayApiFormat, contentType: string, text: string) {
	const usageMeter = new UsageMeter(format, contentType);
	for (let index = 0; index < text.length; index += 7) {
		usageMeter.push(encode(text.slice(index, index + 7)));
	}
	return usageMeter;
}

const meter = (format: AiGatewayApiFormat, contentType: string, text: string) =>
	fed(format, contentType, text).finish();

const sseOf = (events: unknown[]) =>
	events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

describe('usageOf', () => {
	it('reads the usage of the chat completions and of the Responses API', () => {
		expect(
			usageOf('openai', {
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 4 },
				},
			}),
		).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 });
		expect(
			usageOf('openai', {
				type: 'response.completed',
				response: {
					usage: { input_tokens: 7, output_tokens: 3, input_tokens_details: { cached_tokens: 1 } },
				},
			}),
		).toEqual({ inputTokens: 7, outputTokens: 3, cachedInputTokens: 1 });
	});

	it('takes the cost that OpenRouter reports', () => {
		expect(
			usageOf('openai', { usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.0042 } }),
		).toEqual({ inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, reportedCost: 0.0042 });
	});

	it('counts the cache tokens of Anthropic as input', () => {
		expect(
			usageOf('anthropic', {
				usage: {
					input_tokens: 10,
					output_tokens: 20,
					cache_read_input_tokens: 100,
					cache_creation_input_tokens: 50,
				},
			}),
		).toEqual({ inputTokens: 160, outputTokens: 20, cachedInputTokens: 100 });
	});

	it('counts the thoughts of Gemini as output', () => {
		expect(
			usageOf('gemini', {
				usageMetadata: {
					promptTokenCount: 12,
					candidatesTokenCount: 8,
					thoughtsTokenCount: 30,
					cachedContentTokenCount: 2,
				},
			}),
		).toEqual({ inputTokens: 12, outputTokens: 38, cachedInputTokens: 2 });
	});

	it('gives nothing for an event without usage', () => {
		expect(usageOf('openai', { choices: [] })).toBeUndefined();
		expect(usageOf('anthropic', 'text')).toBeUndefined();
	});
});

describe('UsageMeter', () => {
	it('reads the last usage of an OpenAI stream', () => {
		const stream = [
			'data: {"choices":[{"delta":{"content":"Hi"}}],"usage":null}',
			'',
			'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}',
			'',
			'data: [DONE]',
			'',
		].join('\n');
		expect(meter('openai', 'text/event-stream; charset=utf-8', stream)).toEqual({
			inputTokens: 9,
			outputTokens: 2,
			cachedInputTokens: 0,
		});
	});

	it('joins the input of message_start and the output of message_delta of Anthropic', () => {
		const stream = [
			'event: message_start',
			'data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}',
			'',
			'event: content_block_delta',
			'data: {"type":"content_block_delta","delta":{"text":"Hello"}}',
			'',
			'event: message_delta',
			'data: {"type":"message_delta","usage":{"output_tokens":15}}',
			'',
		].join('\r\n');
		expect(meter('anthropic', 'text/event-stream', stream)).toEqual({
			inputTokens: 25,
			outputTokens: 15,
			cachedInputTokens: 0,
		});
	});

	it('reads a Gemini stream as events and as one JSON array', () => {
		const events = [
			'data: {"candidates":[],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1}}',
			'',
			'data: {"candidates":[],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":6}}',
			'',
		].join('\n');
		expect(meter('gemini', 'text/event-stream', events)).toEqual({
			inputTokens: 4,
			outputTokens: 6,
			cachedInputTokens: 0,
		});
		const array = JSON.stringify([
			{ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } },
			{ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 } },
		]);
		expect(meter('gemini', 'application/json', array)).toEqual({
			inputTokens: 3,
			outputTokens: 5,
			cachedInputTokens: 0,
		});
	});

	it('reads the last line of an Ollama stream', () => {
		const lines = [
			JSON.stringify({ message: { content: 'a' }, done: false }),
			JSON.stringify({ done: true, prompt_eval_count: 11, eval_count: 22 }),
			'',
		].join('\n');
		expect(meter('ollama', 'application/x-ndjson', lines)).toEqual({
			inputTokens: 11,
			outputTokens: 22,
			cachedInputTokens: 0,
		});
	});

	it('reads a JSON answer at the end', () => {
		expect(
			meter(
				'openai',
				'application/json',
				JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } }),
			),
		).toEqual({ inputTokens: 3, outputTokens: 4, cachedInputTokens: 0 });
		expect(meter('openai', 'application/json', '{"broken"')).toBeUndefined();
	});
});

describe('the pages of the OCR of Google Cloud', () => {
	const units = (answer: unknown) =>
		meter('google-ocr', 'application/json', JSON.stringify(answer))?.inputTokens;

	it('counts the images, the pages of files and the pages of documents without an error', () => {
		expect(
			units({ responses: [{ fullTextAnnotation: { text: 'A' } }, { error: { code: 3 } }] }),
		).toBe(1);
		expect(
			units({
				responses: [
					{ totalPages: 9, responses: [{}, {}, { error: { code: 3 } }] },
					{ totalPages: 1, responses: [{}] },
				],
			}),
		).toBe(3);
		expect(units({ document: { text: 'Scan', pages: [{}, {}, {}] } })).toBe(3);
		expect(units({ unknown: true })).toBeUndefined();
	});
});

describe('estimateGeminiEmbeddingTokens', () => {
	it('counts four characters for each token of the texts', () => {
		expect(estimateGeminiEmbeddingTokens({ content: { parts: [{ text: 'abcdefgh' }] } })).toBe(2);
		expect(
			estimateGeminiEmbeddingTokens({
				requests: [
					{ model: 'models/gemini-embedding-001', content: { parts: [{ text: 'abcd' }] } },
					{ model: 'models/gemini-embedding-001', content: { parts: [{ text: 'abcde' }] } },
				],
			}),
		).toBe(3);
	});
});

describe('the estimate of the output', () => {
	const outputTokens = (format: AiGatewayApiFormat, contentType: string, text: string) =>
		fed(format, contentType, text).estimatedOutputTokens();

	it('counts the text of a stream: four characters for each token', () => {
		// 'Hello wor' + 'ld!' + '{"a":1}': 19 characters.
		expect(
			outputTokens(
				'openai',
				'text/event-stream',
				sseOf([
					{ choices: [{ delta: { role: 'assistant', content: 'Hello wor' } }] },
					{ choices: [{ delta: { content: 'ld!' } }] },
					{ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"a":1}' } }] } }] },
				]),
			),
		).toBe(5);
		// The deltas of the Responses API, without the done events and without audio: 12 characters.
		expect(
			outputTokens(
				'openai',
				'text/event-stream',
				sseOf([
					{ type: 'response.output_text.delta', delta: 'Hello' },
					{ type: 'response.function_call_arguments.delta', delta: '{"x":2}' },
					{ type: 'response.output_text.done', text: 'Hello' },
					{ type: 'response.audio.delta', delta: 'AAAAAAAAAAAA' },
				]),
			),
		).toBe(3);
		// Text, the JSON of a tool call and thinking: 16 characters.
		expect(
			outputTokens(
				'anthropic',
				'text/event-stream',
				sseOf([
					{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
					{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi there' } },
					{
						type: 'content_block_delta',
						delta: { type: 'input_json_delta', partial_json: '{"q":' },
					},
					{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
				]),
			),
		).toBe(4);
		// 'Twelve chars' and the JSON of a function call: 12 + 22 characters.
		expect(
			outputTokens(
				'gemini',
				'text/event-stream',
				sseOf([
					{ candidates: [{ content: { parts: [{ text: 'Twelve chars' }] } }] },
					{ candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: {} } }] } }] },
				]),
			),
		).toBe(9);
		expect(
			outputTokens(
				'ollama',
				'application/x-ndjson',
				'{"message":{"content":"Hello"}}\n{"message":{"content":" you"},"done":false}\n',
			),
		).toBe(3);
	});

	it('counts the text of a whole answer, and the size of an answer that stopped early', () => {
		const answer = { choices: [{ message: { content: 'Twenty characters!!!' } }] };
		const whole = fed('openai', 'application/json', JSON.stringify(answer));
		expect(whole.finish()).toBeUndefined();
		expect(whole.estimatedOutputTokens()).toBe(5);

		const cut = '{"choices":[{"message":{"content":"Twenty char';
		expect(outputTokens('openai', 'application/json', cut)).toBe(Math.ceil(cut.length / 4));
		expect(
			outputTokens(
				'anthropic',
				'application/json',
				JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'Eight ch' }] }),
			),
		).toBe(2);
		expect(outputTokens('google-ocr', 'application/json', '{"responses":[')).toBe(0);
	});
});

describe('estimateInputTokens', () => {
	it('counts the text of a request without images and files', () => {
		const png = `data:image/png;base64,${'A'.repeat(4000)}`;
		// 'gpt-4o', 'user', 'text', 'Read this' and 'image_url': 32 characters.
		expect(
			estimateInputTokens(
				'openai',
				{
					model: 'gpt-4o',
					messages: [
						{
							role: 'user',
							content: [
								{ type: 'text', text: 'Read this' },
								{ type: 'image_url', image_url: { url: png } },
							],
						},
					],
				},
				'/chat/completions',
			),
		).toBe(8);
		expect(
			estimateInputTokens(
				'gemini',
				{
					contents: [
						{ parts: [{ text: 'Twelve chars' }, { inlineData: { mimeType: 'x', data: 'AAAA' } }] },
					],
				},
				'/v1beta/models/gemini-2.5-flash:generateContent',
			),
		).toBe(3);
		// 'Be brief', 'user', 'image', 'base64' and 'image/png': 32 characters.
		expect(
			estimateInputTokens(
				'anthropic',
				{
					system: 'Be brief',
					messages: [
						{
							role: 'user',
							content: [
								{
									type: 'image',
									source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
								},
							],
						},
					],
				},
				'/v1/messages',
			),
		).toBe(8);
	});

	it('counts the pages and images that a request of the OCR asks for', () => {
		const image = { image: { content: 'AAAA' }, features: [{ type: 'TEXT_DETECTION' }] };
		const file = { inputConfig: { content: 'AAAA', mimeType: 'application/pdf' } };
		expect(
			estimateInputTokens('google-ocr', { requests: [image, image] }, '/v1/images:annotate'),
		).toBe(2);
		expect(
			estimateInputTokens(
				'google-ocr',
				{ requests: [{ ...file, pages: [6, 7] }, file] },
				'/v1/files:annotate',
			),
		).toBe(7);
		expect(
			estimateInputTokens(
				'google-ocr',
				{ rawDocument: { content: 'AAAA', mimeType: 'application/pdf' } },
				'/v1/projects/acme/locations/eu/processors/abc123:process',
			),
		).toBe(1);
	});
});
