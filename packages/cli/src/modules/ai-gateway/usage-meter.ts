import { isRecord } from '@n8n/utils/is-record';

import type { AiGatewayApiFormat } from './providers';

/** The tokens of one call, and the cost when the provider reports it (OpenRouter). */
export interface MeteredUsage {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	reportedCost?: number;
}

/** The answers that the meter keeps in full, to read the usage at the end. */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

const count = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const child = (value: unknown, key: string) => (isRecord(value) ? value[key] : undefined);

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

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

/**
 * Reads the usage of an answer while the proxy passes it on. It reads server-sent events and
 * lines of JSON as they come, and keeps a JSON answer to read it at the end.
 */
export class UsageMeter {
	private usage: MeteredUsage | undefined;

	private readonly kind: 'sse' | 'ndjson' | 'json';

	private pending = '';

	private readonly buffered: Buffer[] = [];

	private bufferedBytes = 0;

	private overflow = false;

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
		if (this.kind === 'json') {
			if (this.overflow) return undefined;
			const body = parseJson(Buffer.concat(this.buffered).toString('utf8'));
			// A stream of Gemini without `alt=sse` is one JSON array of answers.
			const events = Array.isArray(body) ? body : [body];
			for (const event of events) this.usage = merge(this.usage, usageOf(this.format, event));
			return this.usage;
		}
		this.pending += this.decoder.decode();
		if (this.pending) this.readLine(this.pending);
		this.pending = '';
		return this.usage;
	}

	private readLine(line: string) {
		const text =
			this.kind === 'sse' ? (line.startsWith('data:') ? line.slice(5).trim() : '') : line.trim();
		if (!text || text === '[DONE]') return;
		this.usage = merge(this.usage, usageOf(this.format, parseJson(text)));
	}
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
	return Math.ceil(characters / 4);
}
