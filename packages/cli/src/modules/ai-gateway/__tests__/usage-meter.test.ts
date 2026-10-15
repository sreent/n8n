import { estimateGeminiEmbeddingTokens, UsageMeter, usageOf } from '../usage-meter';

const encode = (text: string) => new TextEncoder().encode(text);

/** Feeds the text in small pieces, so that events and lines cross the chunks. */
function meter(
	format: 'openai' | 'anthropic' | 'gemini' | 'ollama',
	contentType: string,
	text: string,
) {
	const usageMeter = new UsageMeter(format, contentType);
	for (let index = 0; index < text.length; index += 7) {
		usageMeter.push(encode(text.slice(index, index + 7)));
	}
	return usageMeter.finish();
}

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
