import { isRecord } from '@n8n/utils/is-record';

import { documentAiLocation } from './gateway-routes';
import type { AiGatewayApiFormat } from './providers';

/** The tokens of one call, and the cost when the provider reports it (OpenRouter). */
export interface MeteredUsage {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	reportedCost?: number;
	/** The gateway estimated the tokens, because the answer did not report them all. */
	estimated?: boolean;
}

/** The answers that the meter keeps in full, to read the usage at the end. */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

/** The estimates of the gateway count four characters of text for each token. */
const CHARACTERS_PER_TOKEN = 4;

/** The pages of a file that one request of `files:annotate` reads when it names no pages. */
const DEFAULT_FILE_PAGES = 5;

/**
 * The keys of a request whose values are binary data, such as images, audio and files. An
 * estimate of the input leaves them out.
 */
const BINARY_KEYS = new Set([
	'data',
	'image',
	'images',
	'b64_json',
	'file_data',
	'inlineData',
	'inline_data',
	'input_audio',
]);

const count = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const child = (value: unknown, key: string) => (isRecord(value) ? value[key] : undefined);

const records = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);

const textLength = (value: unknown) => (typeof value === 'string' ? value.length : 0);

/** The length of a value as JSON, for the arguments of a tool call. */
const jsonLength = (value: unknown) =>
	value === undefined || value === null
		? 0
		: typeof value === 'string'
			? value.length
			: JSON.stringify(value).length;

const tokensOf = (characters: number) => Math.ceil(characters / CHARACTERS_PER_TOKEN);

/** Merges the usage of an event into the usage so far. Counts of a stream only grow. */
function merge(current: MeteredUsage | undefined, next: MeteredUsage | undefined) {
	if (!next) return current;
	if (!current) return next;
	return {
		inputTokens: Math.max(current.inputTokens, next.inputTokens),
		outputTokens: Math.max(current.outputTokens, next.outputTokens),
		cachedInputTokens: Math.max(current.cachedInputTokens, next.cachedInputTokens),
		reportedCost: next.reportedCost ?? current.reportedCost,
	};
}

function openAiUsage(event: unknown): MeteredUsage | undefined {
	// Chat completions, completions and embeddings have `usage`; the Responses API has
	// `response.usage`, also in its event `response.completed`.
	const usage = child(event, 'usage') ?? child(child(event, 'response'), 'usage');
	if (!isRecord(usage)) return undefined;
	const cost = usage.cost;
	return {
		inputTokens: count(usage.prompt_tokens) || count(usage.input_tokens),
		outputTokens: count(usage.completion_tokens) || count(usage.output_tokens),
		cachedInputTokens:
			count(child(usage.prompt_tokens_details, 'cached_tokens')) ||
			count(child(usage.input_tokens_details, 'cached_tokens')),
		...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
			? { reportedCost: cost }
			: {}),
	};
}

function anthropicUsage(event: unknown): MeteredUsage | undefined {
	// The answer and the event `message_delta` have `usage`; the event `message_start` has
	// `message.usage`.
	const usage = child(event, 'usage') ?? child(child(event, 'message'), 'usage');
	if (!isRecord(usage)) return undefined;
	const cacheRead = count(usage.cache_read_input_tokens);
	const cacheWrite = count(usage.cache_creation_input_tokens);
	return {
		inputTokens: count(usage.input_tokens) + cacheRead + cacheWrite,
		outputTokens: count(usage.output_tokens),
		cachedInputTokens: cacheRead,
	};
}

function geminiUsage(event: unknown): MeteredUsage | undefined {
	const usage = child(event, 'usageMetadata');
	if (!isRecord(usage)) return undefined;
	return {
		inputTokens: count(usage.promptTokenCount),
		outputTokens: count(usage.candidatesTokenCount) + count(usage.thoughtsTokenCount),
		cachedInputTokens: count(usage.cachedContentTokenCount),
	};
}

function ollamaUsage(event: unknown): MeteredUsage | undefined {
	if (!isRecord(event)) return undefined;
	if (event.prompt_eval_count === undefined && event.eval_count === undefined) {
		// The OpenAI-format endpoints of Ollama.
		return openAiUsage(event);
	}
	return {
		inputTokens: count(event.prompt_eval_count),
		outputTokens: count(event.eval_count),
		cachedInputTokens: 0,
	};
}

/**
 * The pages and images that the OCR of Google Cloud read, as input tokens: one for each image of
 * `images:annotate`, one for each page of `files:annotate`, and the pages of a Document AI
 * document. An image or a page with an error is not counted.
 */
function googleOcrUsage(event: unknown): MeteredUsage | undefined {
	let units: number | undefined;
	const responses = child(event, 'responses');
	if (Array.isArray(responses)) {
		units = 0;
		for (const response of responses) {
			const pages = child(response, 'responses');
			if (Array.isArray(pages)) units += pages.filter((page) => !child(page, 'error')).length;
			else if (!child(response, 'error')) units += 1;
		}
	}
	const documentPages = child(child(event, 'document'), 'pages');
	if (Array.isArray(documentPages)) units = documentPages.length;
	if (units === undefined) return undefined;
	return { inputTokens: units, outputTokens: 0, cachedInputTokens: 0 };
}

/** The usage in one answer, or in one event of a stream. */
export function usageOf(format: AiGatewayApiFormat, event: unknown): MeteredUsage | undefined {
	switch (format) {
		case 'openai':
			return openAiUsage(event);
		case 'anthropic':
			return anthropicUsage(event);
		case 'gemini':
			return geminiUsage(event);
		case 'ollama':
			return ollamaUsage(event);
		case 'google-ocr':
			return googleOcrUsage(event);
	}
}

/** The characters of the text in an answer of the OpenAI API, or in one event of its stream. */
function openAiOutputLength(event: unknown) {
	let length = 0;
	// Chat completions and completions: `choices`, with a message, a delta of a stream or a text.
	for (const choice of records(child(event, 'choices'))) {
		length += textLength(choice.text);
		for (const message of [choice.message, choice.delta]) {
			if (!isRecord(message)) continue;
			length +=
				textLength(message.content) +
				textLength(message.refusal) +
				textLength(message.reasoning_content) +
				textLength(message.reasoning) +
				textLength(child(message.function_call, 'arguments'));
			for (const call of records(message.tool_calls)) {
				length += textLength(child(call.function, 'arguments'));
			}
		}
	}
	// A stream of the Responses API: the text of the events `response.output_text.delta`,
	// `response.function_call_arguments.delta` and others. Audio deltas are binary data.
	const type = child(event, 'type');
	if (typeof type === 'string' && type.endsWith('.delta') && !type.includes('audio')) {
		length += textLength(child(event, 'delta'));
	}
	// A whole answer of the Responses API.
	if (child(event, 'object') === 'response') {
		for (const item of records(child(event, 'output'))) {
			length += textLength(item.arguments);
			for (const part of [...records(item.content), ...records(item.summary)]) {
				length += textLength(part.text);
			}
		}
	}
	return length;
}

/** The characters of the text in an answer of the Anthropic API, or in one event of its stream. */
function anthropicOutputLength(event: unknown) {
	const delta = child(event, 'delta');
	let length =
		textLength(child(delta, 'text')) +
		textLength(child(delta, 'partial_json')) +
		textLength(child(delta, 'thinking'));
	if (child(event, 'type') === 'message') {
		for (const block of records(child(event, 'content'))) {
			length += textLength(block.text) + textLength(block.thinking) + jsonLength(block.input);
		}
	}
	return length;
}

/** The characters of the text in an answer of the Gemini API, or in one part of its stream. */
function geminiOutputLength(event: unknown) {
	let length = 0;
	for (const candidate of records(child(event, 'candidates'))) {
		for (const part of records(child(candidate.content, 'parts'))) {
			length += textLength(part.text) + jsonLength(part.functionCall);
		}
	}
	return length;
}

/** The characters of the text in an answer of Ollama, or in one line of its stream. */
function ollamaOutputLength(event: unknown) {
	if (!isRecord(event)) return 0;
	let length = textLength(event.response) + textLength(event.thinking);
	if (isRecord(event.message)) {
		length +=
			textLength(event.message.content) +
			textLength(event.message.thinking) +
			jsonLength(event.message.tool_calls);
	}
	// The OpenAI-format endpoints of Ollama.
	return length + openAiOutputLength(event);
}

/** The characters of the text that an answer, or one event of its stream, gives. */
function outputLengthOf(format: AiGatewayApiFormat, event: unknown) {
	switch (format) {
		case 'openai':
			return openAiOutputLength(event);
		case 'anthropic':
			return anthropicOutputLength(event);
		case 'gemini':
			return geminiOutputLength(event);
		case 'ollama':
			return ollamaOutputLength(event);
		case 'google-ocr':
			return 0;
	}
}

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

/**
 * Reads the usage of an answer while the proxy passes it on. It reads server-sent events and
 * lines of JSON as they come, and keeps a JSON answer to read it at the end. It also counts the
 * text of the answer, for an estimate when the answer has no usage or stops early.
 */
export class UsageMeter {
	private usage: MeteredUsage | undefined;

	private readonly kind: 'sse' | 'ndjson' | 'json';

	private pending = '';

	private readonly buffered: Buffer[] = [];

	private bufferedBytes = 0;

	private receivedBytes = 0;

	private outputCharacters = 0;

	private overflow = false;

	private finished = false;

	private readonly decoder = new TextDecoder();

	constructor(
		private readonly format: AiGatewayApiFormat,
		contentType: string,
	) {
		this.kind = contentType.includes('text/event-stream')
			? 'sse'
			: contentType.includes('ndjson')
				? 'ndjson'
				: 'json';
	}

	push(chunk: Uint8Array) {
		this.receivedBytes += chunk.length;
		if (this.kind === 'json') {
			if (this.overflow) return;
			this.bufferedBytes += chunk.length;
			if (this.bufferedBytes > MAX_BUFFERED_BYTES) {
				this.overflow = true;
				this.buffered.length = 0;
				return;
			}
			this.buffered.push(Buffer.from(chunk));
			return;
		}
		this.pending += this.decoder.decode(chunk, { stream: true });
		const lines = this.pending.split(/\r?\n/);
		this.pending = lines.pop() ?? '';
		for (const line of lines) this.readLine(line);
	}

	/** The usage of the whole answer, or `undefined` when the answer had none. */
	finish(): MeteredUsage | undefined {
		if (this.finished) return this.usage;
		this.finished = true;
		if (this.kind === 'json') {
			const body = this.overflow
				? undefined
				: parseJson(Buffer.concat(this.buffered).toString('utf8'));
			this.buffered.length = 0;
			if (body === undefined) {
				// The answer stopped early or is too long to read: its size is the estimate.
				this.outputCharacters = this.receivedBytes;
				return this.usage;
			}
			// A stream of Gemini without `alt=sse` is one JSON array of answers.
			const events = Array.isArray(body) ? body : [body];
			for (const event of events) this.readEvent(event);
			return this.usage;
		}
		this.pending += this.decoder.decode();
		if (this.pending) this.readLine(this.pending);
		this.pending = '';
		return this.usage;
	}

	/**
	 * An estimate of the output tokens: the text that the answer gave until it ended or stopped,
	 * four characters for each token. The OCR counts pages, so it has no output.
	 */
	estimatedOutputTokens() {
		this.finish();
		return this.format === 'google-ocr' ? 0 : tokensOf(this.outputCharacters);
	}

	private readLine(line: string) {
		const text =
			this.kind === 'sse' ? (line.startsWith('data:') ? line.slice(5).trim() : '') : line.trim();
		if (!text || text === '[DONE]') return;
		this.readEvent(parseJson(text));
	}

	private readEvent(event: unknown) {
		this.usage = merge(this.usage, usageOf(this.format, event));
		this.outputCharacters += outputLengthOf(this.format, event);
	}
}

/** The characters of the text in a request, without binary data such as images and files. */
function textLengthOfRequest(value: unknown): number {
	if (typeof value === 'string') return value.startsWith('data:') ? 0 : value.length;
	if (Array.isArray(value))
		return value.reduce<number>((sum, item) => sum + textLengthOfRequest(item), 0);
	if (!isRecord(value)) return 0;
	let length = 0;
	for (const [key, item] of Object.entries(value)) {
		if (!BINARY_KEYS.has(key)) length += textLengthOfRequest(item);
	}
	return length;
}

/**
 * The pages and images that a request of the OCR asks for: each image of `images:annotate`, the
 * pages of each file of `files:annotate` (the first 5 when it names none), and one page of a
 * document of Document AI, whose page count only the answer gives.
 */
function ocrUnitsOfRequest(body: unknown, rest: string) {
	if (documentAiLocation(rest)) return 1;
	let units = 0;
	for (const request of records(child(body, 'requests'))) {
		if (!isRecord(request.inputConfig)) {
			units += 1;
			continue;
		}
		const pages = request.pages;
		units += Array.isArray(pages) && pages.length > 0 ? pages.length : DEFAULT_FILE_PAGES;
	}
	return units;
}

/**
 * An estimate of the input tokens of a request, for an answer without usage: the text of the
 * request, four characters for each token, without images, audio and files. For the OCR, the
 * pages and images that the request asks for.
 */
export function estimateInputTokens(format: AiGatewayApiFormat, body: unknown, rest: string) {
	if (format === 'google-ocr') return ocrUnitsOfRequest(body, rest);
	return tokensOf(textLengthOfRequest(body));
}

/**
 * An estimate of the input tokens of a Gemini embedding request, whose answer has no usage: four
 * characters for each token.
 */
export function estimateGeminiEmbeddingTokens(body: unknown): number {
	let characters = 0;
	const visit = (value: unknown) => {
		if (typeof value === 'string') characters += value.length;
		else if (Array.isArray(value)) value.forEach(visit);
		else if (isRecord(value)) {
			for (const [key, item] of Object.entries(value)) {
				if (key === 'text' || key === 'content' || key === 'requests' || key === 'parts')
					visit(item);
			}
		}
	};
	visit(body);
	return tokensOf(characters);
}
