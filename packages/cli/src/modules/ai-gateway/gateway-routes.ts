import { DOCUMENT_AI_MODEL } from './prices';
import { AI_GATEWAY_PROVIDERS, type AiGatewayApiFormat, type AiGatewayProvider } from './providers';

const GATEWAY_PREFIX = '/v1/gateway/';

/** Who and what a call counts for, from the URL that `AiGatewayService` built. */
export interface AiGatewayCallAttribution {
	executionId?: string;
	workflowId?: string;
	agentId?: string;
	projectId?: string;
}

export interface ParsedGatewayPath {
	provider: AiGatewayProvider;
	attribution: AiGatewayCallAttribution;
	/** The path after the gateway path of the provider, as the client sent it, with a `/`. */
	rest: string;
}

const decode = (value: string) => {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
};

/** Whether a path can safely follow a base URL: no `..`, no `\`, no empty segment. */
export function isSafeRest(rest: string) {
	if (rest !== '' && !rest.startsWith('/')) return false;
	const decoded = decode(rest);
	if (decoded === undefined) return false;
	if (decoded.includes('\\') || decoded.includes('//')) return false;
	return !decoded.split('/').some((segment) => segment === '..' || segment === '.');
}

/**
 * Splits the path of a call after `/ai-gateway`: the optional attribution
 * (`/v1/gateway/exec/<executionId>/<workflowId>|<projectId>/...`), the provider and the rest.
 * Gives `undefined` for a path that names no provider or is not safe.
 */
export function parseGatewayPath(path: string): ParsedGatewayPath | undefined {
	if (!path.startsWith(GATEWAY_PREFIX)) return undefined;
	let remainder = path.slice(GATEWAY_PREFIX.length);
	const attribution: AiGatewayCallAttribution = {};

	if (remainder.startsWith('exec/')) {
		const [, executionSegment, contextSegment, ...others] = remainder.split('/');
		const executionId = decode(executionSegment ?? '');
		const context = decode(contextSegment ?? '');
		if (!executionId || !context) return undefined;
		const [attributionId, projectId] = context.split('|');
		if (executionId === 'agent') attribution.agentId = attributionId;
		else {
			attribution.executionId = executionId;
			attribution.workflowId = attributionId;
		}
		if (projectId) attribution.projectId = projectId;
		remainder = others.join('/');
	}

	// The longest gateway path first, so that `openai/v1` wins over a shorter slug.
	const providers = [...AI_GATEWAY_PROVIDERS].sort(
		(a, b) => b.gatewayPath.length - a.gatewayPath.length,
	);
	for (const provider of providers) {
		const providerPath = provider.gatewayPath.slice(GATEWAY_PREFIX.length);
		if (remainder !== providerPath && !remainder.startsWith(`${providerPath}/`)) continue;
		const rest = remainder.slice(providerPath.length);
		if (!isSafeRest(rest)) return undefined;
		return { provider, attribution, rest };
	}
	return undefined;
}

/** How the proxy treats an endpoint. */
export type GatewayEndpoint =
	/** A call with a model and a price: the proxy checks the budgets and records the cost. */
	| {
			kind: 'metered';
			model: 'body' | { fromPath: string };
			streamUsage?: 'openai';
			embedding?: 'gemini';
	  }
	/** A model list: the proxy keeps only the models with a price. */
	| { kind: 'models' }
	/** A call without a cost, for example a token count. */
	| { kind: 'free' };

const OPENAI_METERED = /(^|\/)(chat\/completions|completions|responses|embeddings)$/;
const OPENAI_MODELS = /(^|\/)models$/;
const OPENAI_MODEL = /(^|\/)models\/[^/]+$/;
const OPENAI_FREE = /(^|\/)moderations$/;

const GEMINI_CALL = /^\/(v1|v1beta|v1alpha)\/models\/([^/:]+):([a-zA-Z]+)$/;
const GEMINI_MODELS = /^\/(v1|v1beta|v1alpha)\/models$/;
const GEMINI_MODEL = /^\/(v1|v1beta|v1alpha)\/models\/[^/:]+$/;
const GEMINI_UPLOAD_START = /^\/upload\/v1beta\/files$/;
const GEMINI_FILE = /^\/v1beta\/files\/[^/:]+$/;

function openAiEndpoint(method: string, rest: string): GatewayEndpoint | undefined {
	if (method === 'POST' && OPENAI_METERED.test(rest)) {
		const streams = /(chat\/completions|completions)$/.test(rest);
		return { kind: 'metered', model: 'body', ...(streams ? { streamUsage: 'openai' } : {}) };
	}
	if (method === 'POST' && OPENAI_FREE.test(rest)) return { kind: 'free' };
	if (method === 'GET' && OPENAI_MODELS.test(rest)) return { kind: 'models' };
	if (method === 'GET' && OPENAI_MODEL.test(rest)) return { kind: 'free' };
	return undefined;
}

function anthropicEndpoint(method: string, rest: string): GatewayEndpoint | undefined {
	if (method === 'POST' && rest === '/v1/messages') return { kind: 'metered', model: 'body' };
	if (method === 'POST' && rest === '/v1/messages/count_tokens') return { kind: 'free' };
	if (method === 'GET' && rest === '/v1/models') return { kind: 'models' };
	if (method === 'GET' && /^\/v1\/models\/[^/]+$/.test(rest)) return { kind: 'free' };
	return undefined;
}

function geminiEndpoint(method: string, rest: string): GatewayEndpoint | undefined {
	const call = GEMINI_CALL.exec(rest);
	if (method === 'POST' && call) {
		const [, , model, action] = call;
		if (action === 'generateContent' || action === 'streamGenerateContent') {
			return { kind: 'metered', model: { fromPath: model } };
		}
		if (action === 'embedContent' || action === 'batchEmbedContents') {
			return { kind: 'metered', model: { fromPath: model }, embedding: 'gemini' };
		}
		if (action === 'countTokens') return { kind: 'free' };
		return undefined;
	}
	if (method === 'GET' && GEMINI_MODELS.test(rest)) return { kind: 'models' };
	if (method === 'GET' && GEMINI_MODEL.test(rest)) return { kind: 'free' };
	// The analysis of documents and images uploads the files first: the start of an upload, and
	// the state of a file. The node sends the content of the file to the upload URL of Google.
	if (method === 'POST' && GEMINI_UPLOAD_START.test(rest)) return { kind: 'free' };
	if (method === 'GET' && GEMINI_FILE.test(rest)) return { kind: 'free' };
	return undefined;
}

/**
 * A call of Document AI: `/v1/projects/<project>/locations/<location>/processors/<id>:process`,
 * also with `/processorVersions/<id>`. The groups are the location and the processor ID.
 */
const DOCUMENT_AI_PROCESS =
	/^\/v1\/projects\/[^/]+\/locations\/([a-z][a-z0-9-]*)\/processors\/([\w-]{1,64})(\/processorVersions\/[^/:]+)?:process$/;

/** The location of a call of Document AI, or `undefined` for another path. */
export function documentAiLocation(rest: string) {
	return DOCUMENT_AI_PROCESS.exec(rest)?.[1];
}

/**
 * The text detection of the Cloud Vision API, and the processors of Document AI. The model of a
 * call of Document AI names its processor (`document-ai/<processor ID>`), so that each processor
 * can have its own price.
 */
function googleOcrEndpoint(method: string, rest: string): GatewayEndpoint | undefined {
	if (method !== 'POST') return undefined;
	if (rest === '/v1/images:annotate' || rest === '/v1/files:annotate') {
		return { kind: 'metered', model: { fromPath: 'vision-ocr' } };
	}
	const processor = DOCUMENT_AI_PROCESS.exec(rest)?.[2];
	if (processor) {
		return { kind: 'metered', model: { fromPath: `${DOCUMENT_AI_MODEL}/${processor}` } };
	}
	return undefined;
}

function ollamaEndpoint(method: string, rest: string): GatewayEndpoint | undefined {
	if (method === 'POST' && /^\/api\/(chat|generate|embed|embeddings)$/.test(rest)) {
		return { kind: 'metered', model: 'body' };
	}
	if (method === 'POST' && rest === '/api/show') return { kind: 'free' };
	if (method === 'GET' && rest === '/api/tags') return { kind: 'free' };
	// The OpenAI-format endpoints of Ollama.
	if (rest.startsWith('/v1/')) return openAiEndpoint(method, rest);
	return undefined;
}

/** How the proxy treats a call, or `undefined` for an endpoint that the gateway does not serve. */
export function endpointOf(
	format: AiGatewayApiFormat,
	method: string,
	rest: string,
): GatewayEndpoint | undefined {
	switch (format) {
		case 'openai':
			return openAiEndpoint(method, rest);
		case 'anthropic':
			return anthropicEndpoint(method, rest);
		case 'gemini':
			return geminiEndpoint(method, rest);
		case 'ollama':
			return ollamaEndpoint(method, rest);
		case 'google-ocr':
			return googleOcrEndpoint(method, rest);
	}
}
