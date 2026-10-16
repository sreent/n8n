import { LicenseState, Logger } from '@n8n/backend-common';
import { OutboundHttp } from '@n8n/backend-network';
import { GlobalConfig } from '@n8n/config';
import { CredentialsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { isRecord } from '@n8n/utils/is-record';
import type { Request, Response } from 'express';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

import { CredentialsHelper } from '@/credentials-helper';

import { ForkAiGatewayConfig } from './ai-gateway.config';
import { AiGatewayBudgetService } from './ai-gateway-budget.service';
import { AiGatewayPriceService } from './ai-gateway-price.service';
import { AI_GATEWAY_ROUTE } from './ai-gateway-protocol.service';
import {
	type AiGatewayProviderSettings,
	AiGatewaySettingsService,
} from './ai-gateway-settings.service';
import { AiGatewayTokenService } from './ai-gateway-token.service';
import { AiGatewayVertexService, VertexSignInError } from './ai-gateway-vertex.service';
import {
	azureOpenAiBaseUrl,
	geminiModelCall,
	geminiModelInfo,
	geminiModelList,
	isPublisherModel,
	openAiModelList,
	stringField,
	vertexChatCompletionsPath,
	vertexModelPath,
	vertexTarget,
} from './backends';
import {
	type AiGatewayCallAttribution,
	documentAiLocation,
	endpointOf,
	type GatewayEndpoint,
	parseGatewayPath,
} from './gateway-routes';
import { costOf, type AiGatewayModelPrice } from './prices';
import {
	type AiGatewayApiFormat,
	type AiGatewayBackend,
	type AiGatewayProvider,
	backendOf,
	credentialTypesOf,
} from './providers';
import {
	estimateGeminiEmbeddingTokens,
	estimateInputTokens,
	type MeteredUsage,
	UsageMeter,
	usageOf,
} from './usage-meter';

/** The headers of a call that the proxy does not pass on to the provider. */
const DROPPED_REQUEST_HEADERS = new Set([
	'host',
	'connection',
	'keep-alive',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'content-length',
	'accept-encoding',
	'cookie',
	'authorization',
	'x-api-key',
	'x-goog-api-key',
	// They pick another project or organization that pays. The credential of the admin decides.
	'x-goog-user-project',
	'openai-organization',
	'openai-project',
	// They change the fields of an answer or the method of a call.
	'x-goog-fieldmask',
	'x-http-method-override',
	'x-http-method',
	'x-method-override',
	'api-key',
	'forwarded',
	'x-real-ip',
	'origin',
	'referer',
	'browser-id',
	'push-ref',
]);

/** The headers of an answer that the proxy does not pass back. */
const DROPPED_RESPONSE_HEADERS = new Set([
	// The organization of the API key of the admin.
	'openai-organization',
	'openai-project',
	'anthropic-organization-id',
	'connection',
	'keep-alive',
	'transfer-encoding',
	'content-encoding',
	'content-length',
	'set-cookie',
	'strict-transport-security',
	'alt-svc',
]);

/** The decrypted credentials of the admin stay this long in memory. */
const CREDENTIAL_CACHE_MS = 30_000;

/** The most requests in one `batchEmbedContents` call to Vertex AI. */
const MAX_VERTEX_BATCH = 250;

/** The `embedContent` calls that one batch sends to Vertex AI at the same time. */
const VERTEX_BATCH_CONCURRENCY = 4;

/** The text detections of the Cloud Vision API, which the price of the gateway covers. */
const OCR_FEATURES = new Set(['TEXT_DETECTION', 'DOCUMENT_TEXT_DETECTION']);

/** The fields of a call of Document AI that the proxy passes on. */
const DOCUMENT_AI_FIELDS = new Set([
	'rawDocument',
	'skipHumanReview',
	'processOptions',
	'imagelessMode',
	'labels',
]);

/**
 * The query parameters that the proxy passes to the APIs of Google, with a check of the value.
 * The other system parameters of Google can change the format or the fields of an answer, the
 * credential or the project that pays.
 */
const GOOGLE_QUERY_PARAMETERS = new Map<string, (value: string) => boolean>([
	['alt', (value) => value === 'sse' || value === 'json'],
	['pageSize', (value) => /^\d{1,5}$/.test(value)],
	['pageToken', (value) => value.length <= 2048],
]);

/** The backends that call the APIs of Google with a service account of the admin. */
const GOOGLE_BACKENDS = new Set(['vertex-ai', 'vertex-openai', 'google-cloud']);

/** The open models of Vertex AI have only the Chat Completions of the OpenAI API. */
const OPEN_MODELS_CHAT_ONLY =
	'The open models of Vertex AI support only Chat Completions. Turn off "Use Responses API" on the OpenAI Chat Model node.';

class GatewayError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** An error answer in the format of the provider API, so that its SDK shows the message. */
function sendError(res: Response, format: AiGatewayApiFormat, status: number, message: string) {
	const body =
		format === 'anthropic'
			? { type: 'error', error: { type: 'ai_gateway_error', message } }
			: format === 'gemini' || format === 'google-ocr'
				? { error: { code: status, message, status: 'FAILED_PRECONDITION' } }
				: { error: { message, type: 'ai_gateway_error', code: 'ai_gateway_error' } };
	res.status(status).json(body);
}

/** The upload URL of a Gemini file without an API key, because the node gets the URL. */
function withoutKeyParameter(value: string) {
	try {
		const uploadUrl = new URL(value);
		if (!uploadUrl.searchParams.has('key')) return value;
		uploadUrl.searchParams.delete('key');
		return uploadUrl.toString();
	} catch {
		return value;
	}
}

/** A request of the Gemini API without its field `model`, which Vertex AI takes from the path. */
function withoutModelField(request: unknown) {
	if (!isRecord(request)) return request;
	return Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'model'));
}

/**
 * Waits until the client takes more of an answer, or until it closes the connection. Then the
 * proxy stops the call (see `forward`), and the record of the call follows.
 */
async function drained(res: Response) {
	if (res.destroyed) return;
	await new Promise<void>((resolve) => {
		const done = () => {
			res.off('drain', done);
			res.off('close', done);
			resolve();
		};
		res.on('drain', done);
		res.on('close', done);
	});
}

/** Whether the features of a request of the Cloud Vision API are one text detection. */
function isOneTextDetection(features: unknown) {
	return (
		Array.isArray(features) &&
		features.length === 1 &&
		isRecord(features[0]) &&
		typeof features[0].type === 'string' &&
		OCR_FEATURES.has(features[0].type)
	);
}

/** Whether a request of the Cloud Vision API reads a file of Cloud Storage. */
function readsCloudStorage(request: Record<string, unknown>) {
	const source = isRecord(request.image) ? request.image.source : undefined;
	if (isRecord(source)) {
		if (source.gcsImageUri !== undefined) return true;
		const imageUri = typeof source.imageUri === 'string' ? source.imageUri : '';
		if (imageUri.trim().toLowerCase().startsWith('gs:')) return true;
	}
	return isRecord(request.inputConfig) && request.inputConfig.gcsSource !== undefined;
}

interface CallBody {
	raw?: Uint8Array<ArrayBuffer>;
	json?: unknown;
}

const encodeJson = (json: unknown): CallBody => ({
	json,
	raw: new TextEncoder().encode(JSON.stringify(json)),
});

/** One call through the gateway: who sends it, and where it goes. */
interface GatewayCall {
	req: Request;
	url: URL;
	provider: AiGatewayProvider;
	/** The backend that serves the call, or `undefined` for the provider itself. */
	backend: AiGatewayBackend | undefined;
	providerSettings: AiGatewayProviderSettings;
	credential: ICredentialDataDecryptedObject;
	rest: string;
	userId: string;
	attribution: AiGatewayCallAttribution;
}

/** The URL, the authentication headers and the body of a call to the provider. */
interface UpstreamRequest {
	url: URL;
	auth: Record<string, string>;
	body: CallBody;
}

/**
 * The proxy of the gateway: it checks the token, the endpoint, the price and the budgets, forwards
 * a call to the provider or its backend with the credential of the admin, passes the answer back
 * as it comes, and records the tokens and the cost. See `README.md`, "How a call works".
 */
@Service()
export class AiGatewayProxyService {
	private readonly credentialCache = new Map<
		string,
		{ type: string; data: ICredentialDataDecryptedObject; expiresAt: number }
	>();

	constructor(
		private readonly logger: Logger,
		private readonly config: ForkAiGatewayConfig,
		private readonly settings: AiGatewaySettingsService,
		private readonly tokens: AiGatewayTokenService,
		private readonly prices: AiGatewayPriceService,
		private readonly budgets: AiGatewayBudgetService,
		private readonly vertex: AiGatewayVertexService,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly credentialsHelper: CredentialsHelper,
		private readonly outboundHttp: OutboundHttp,
		private readonly globalConfig: GlobalConfig,
		private readonly licenseState: LicenseState,
	) {}

	/** Forgets the decrypted credentials, for example after a change of the settings. */
	clearCredentialCache() {
		this.credentialCache.clear();
		this.vertex.clear();
	}

	async handle(req: Request, res: Response) {
		let format: AiGatewayApiFormat = 'openai';
		try {
			const url = new URL(req.originalUrl, 'http://gateway.invalid');
			const start = url.pathname.indexOf(`${AI_GATEWAY_ROUTE}/`);
			const path = start === -1 ? '' : url.pathname.slice(start + AI_GATEWAY_ROUTE.length);
			const parsed = parseGatewayPath(path);
			if (!parsed) throw new GatewayError(404, 'The AI gateway does not know this path.');
			format = parsed.provider.format;
			await this.forward(req, res, url, parsed.provider, parsed.rest, parsed.attribution);
		} catch (error) {
			if (res.headersSent) {
				res.end();
				return;
			}
			if (error instanceof GatewayError) {
				sendError(res, format, error.status, error.message);
				return;
			}
			// The details can name hosts of the admin's credentials, so only the log gets them.
			const message = error instanceof Error ? error.message : String(error);
			this.logger.warn('A call through the AI gateway failed', { error: message });
			sendError(res, format, 502, 'The AI gateway could not reach the provider.');
		}
	}

	private async forward(
		req: Request,
		res: Response,
		url: URL,
		provider: AiGatewayProvider,
		rest: string,
		attribution: AiGatewayCallAttribution,
	) {
		const settings = this.settings.current();
		// The same switches as the ordinary code: the setting, N8N_AI_GATEWAY_ENABLED and the licence.
		if (
			!settings.enabled ||
			!this.globalConfig.aiGateway.enabled ||
			!this.licenseState.isAiGatewayLicensed()
		) {
			throw new GatewayError(503, 'The AI gateway is off.');
		}
		const providerSettings = settings.providers[provider.slug];
		if (!providerSettings) {
			throw new GatewayError(503, `The AI gateway has no credential for ${provider.displayName}.`);
		}

		const userId = this.tokens.verify(this.tokenOf(req, url, provider));
		if (!userId) throw new GatewayError(401, 'The token of the AI gateway is not valid.');

		const method = req.method.toUpperCase();
		const endpoint = endpointOf(provider.format, method, rest);
		if (!endpoint) throw new GatewayError(403, 'The AI gateway does not support this endpoint.');

		const credential = await this.credentialData(providerSettings.credentialId, provider);
		let call: GatewayCall = {
			req,
			url,
			provider,
			backend: backendOf(provider, credential.type),
			providerSettings,
			credential: credential.data,
			rest,
			userId,
			attribution,
		};

		if (call.backend && this.answerFromBackendSettings(call, endpoint, res)) return;

		let body = this.bodyOf(req);
		let model: string | undefined;
		let price: AiGatewayModelPrice | undefined;
		if (endpoint.kind === 'metered') {
			model = this.modelOf(endpoint, body.json);
			price = this.prices.priceOf(provider, model);
			if (!price) {
				throw new GatewayError(
					403,
					`The model ${model} has no price in the AI gateway. Ask an admin to add one.`,
				);
			}
			if (provider.format === 'google-ocr') this.checkOcrRequest(rest, body.json);
			const blocked = await this.budgets.blockReason({ userId, projectId: attribution.projectId });
			if (blocked) throw new GatewayError(402, blocked);
			body = this.withUsageRequest(provider, endpoint, body);

			// A model of a publisher goes to the open models of Vertex AI, when the admin set them.
			if (
				providerSettings.openModels &&
				call.backend?.kind !== 'vertex-openai' &&
				isPublisherModel(model)
			) {
				call = await this.openModelsCall(call, providerSettings.openModels);
			}

			if (
				call.backend?.kind === 'vertex-ai' &&
				geminiModelCall(rest)?.action === 'batchEmbedContents'
			) {
				await this.batchEmbedOnVertex(call, res, model, price, body);
				return;
			}
		}

		const upstream = await this.upstreamRequest(call, body);
		const abort = new AbortController();
		res.on('close', () => {
			if (!res.writableFinished) abort.abort();
		});
		let response: globalThis.Response;
		try {
			response = await this.fetch()(upstream.url, {
				method,
				headers: this.upstreamHeaders(req, upstream.auth),
				body: upstream.body.raw,
				signal: abort.signal,
				redirect: 'manual',
			});
		} catch (error) {
			// The client stopped the call before the answer came. The provider can bill the input.
			if (abort.signal.aborted && endpoint.kind === 'metered' && model && price) {
				await this.recordStoppedCall(call, model, price, upstream.body.json);
			}
			throw error;
		}

		res.status(response.status);
		response.headers.forEach((value, name) => {
			const lower = name.toLowerCase();
			if (DROPPED_RESPONSE_HEADERS.has(lower)) return;
			res.setHeader(name, lower === 'x-goog-upload-url' ? withoutKeyParameter(value) : value);
		});
		const contentType = response.headers.get('content-type') ?? '';
		const ok = response.status >= 200 && response.status < 300;

		if (endpoint.kind === 'models' && ok && contentType.includes('json')) {
			const listed: unknown = await response.json();
			res.json(this.withOpenModels(call, this.pricedModels(provider, listed)));
			return;
		}

		res.setHeader('cache-control', 'no-cache, no-transform');
		res.setHeader('x-accel-buffering', 'no');
		const meter =
			endpoint.kind === 'metered' && ok ? new UsageMeter(provider.format, contentType) : undefined;
		let completed = false;
		try {
			await this.pipe(response, res, meter);
			completed = true;
		} finally {
			// Also a stream that ends early costs the tokens that it used.
			if (meter && model && price && endpoint.kind === 'metered') {
				const usage = this.usageToRecord(call, meter, endpoint, upstream.body.json, completed);
				if (usage) await this.record(call, model, price, usage);
				else {
					this.logger.warn('The answer of a call through the AI gateway had no usage', {
						provider: provider.slug,
						model,
					});
				}
			}
		}
		// End the answer after the record, so that the budget check of the next call sees the cost.
		res.end();
	}

	/**
	 * Answers the calls that a backend does not serve from the settings of the gateway: the model
	 * lists, the details of a model and the File API of Gemini. Gives `false` for the other calls.
	 */
	private answerFromBackendSettings(call: GatewayCall, endpoint: GatewayEndpoint, res: Response) {
		const { provider, backend, providerSettings, rest } = call;
		if (!backend) return false;
		if (endpoint.kind === 'models') {
			if (backend.kind === 'vertex-ai') {
				res.json(geminiModelList(this.prices.modelsWithPrice(provider)));
			} else if (backend.kind === 'vertex-openai') {
				res.json(openAiModelList(this.openModelIds(provider), 'vertex-ai'));
			} else {
				const deployments = (providerSettings.deployments ?? []).filter(
					(deployment) => this.prices.priceOf(provider, deployment) !== undefined,
				);
				res.json(this.withOpenModels(call, openAiModelList(deployments, 'azure')));
			}
			return true;
		}
		if (backend.kind !== 'vertex-ai' || geminiModelCall(rest)) return false;

		const model = geminiModelInfo(rest);
		if (model === undefined) {
			throw new GatewayError(
				403,
				'The AI gateway sends the calls of Google Gemini to Vertex AI, which has no File API. Ask an admin for a Gemini API credential in the AI gateway, or send the files inline.',
			);
		}
		if (this.prices.priceOf(provider, model) === undefined) {
			throw new GatewayError(404, `The AI gateway offers no model ${model}.`);
		}
		const [details] = geminiModelList([model]).models;
		res.json(details);
		return true;
	}

	/**
	 * The gateway prices one text detection for each image or page, and it reads only the content
	 * of a file or a public URL: the service account of the admin can read files of Cloud Storage
	 * that the user cannot read. So each request of the Cloud Vision API asks for one text detection
	 * of such an input, and a call of Document AI sends the content of the document.
	 */
	private checkOcrRequest(rest: string, json: unknown) {
		if (documentAiLocation(rest)) {
			const valid =
				isRecord(json) &&
				isRecord(json.rawDocument) &&
				Object.keys(json).every((key) => DOCUMENT_AI_FIELDS.has(key));
			if (!valid) {
				throw new GatewayError(
					403,
					'A call of Document AI through the AI gateway sends the content of the document (rawDocument), with no field mask and no file of Cloud Storage.',
				);
			}
			return;
		}
		const requests = isRecord(json) ? json.requests : undefined;
		if (
			!isRecord(json) ||
			Object.keys(json).some((key) => key !== 'requests') ||
			!Array.isArray(requests) ||
			requests.length === 0
		) {
			throw new GatewayError(
				403,
				'A call of the Cloud Vision API through the AI gateway has only the field "requests".',
			);
		}
		for (const request of requests) {
			if (!isRecord(request) || !isOneTextDetection(request.features)) {
				throw new GatewayError(
					403,
					'The AI gateway allows one text detection (TEXT_DETECTION or DOCUMENT_TEXT_DETECTION) for each image or file, and no other features.',
				);
			}
			if (readsCloudStorage(request)) {
				throw new GatewayError(
					403,
					'The AI gateway reads only the content of a file or a public URL, not a file of Cloud Storage.',
				);
			}
		}
	}

	/** The open models of Vertex AI that have a price: the models of a publisher. */
	private openModelIds(provider: AiGatewayProvider) {
		return this.prices.modelsWithPrice(provider).filter(isPublisherModel);
	}

	/** A model list of the OpenAI API with the open models of Vertex AI, when the admin set them. */
	private withOpenModels(call: GatewayCall, listed: unknown) {
		if (!call.providerSettings.openModels || !isRecord(listed) || !Array.isArray(listed.data)) {
			return listed;
		}
		const openModels = openAiModelList(this.openModelIds(call.provider), 'vertex-ai').data;
		return { ...listed, data: [...listed.data, ...openModels] };
	}

	/** The call, sent to the open models of Vertex AI with the service account of the admin. */
	private async openModelsCall(
		call: GatewayCall,
		openModels: NonNullable<AiGatewayProviderSettings['openModels']>,
	): Promise<GatewayCall> {
		const backend = call.provider.backends?.find(({ kind }) => kind === 'vertex-openai');
		const credential = await this.credentialData(openModels.credentialId, call.provider);
		if (!backend || credential.type !== backend.credentialType) {
			throw new GatewayError(
				503,
				'The credential of the open models of Vertex AI for the AI gateway is missing or has the wrong type.',
			);
		}
		return {
			...call,
			backend,
			credential: credential.data,
			providerSettings: {
				credentialId: openModels.credentialId,
				projectId: openModels.projectId,
				location: openModels.location,
			},
		};
	}

	/** The URL, the authentication and the body of a call, for the provider or its backend. */
	private async upstreamRequest(call: GatewayCall, body: CallBody): Promise<UpstreamRequest> {
		const { provider, backend, credential, rest, url } = call;
		const toGoogle =
			provider.auth === 'google' || (backend !== undefined && GOOGLE_BACKENDS.has(backend.kind));
		const query = (target: URL) => {
			for (const [name, value] of url.searchParams) {
				if (toGoogle && GOOGLE_QUERY_PARAMETERS.get(name)?.(value) !== true) continue;
				target.searchParams.append(name, value);
			}
			return target;
		};

		if (backend?.kind === 'azure-openai') {
			const base = azureOpenAiBaseUrl(credential);
			if (!base) {
				throw new GatewayError(
					503,
					'The Azure OpenAI credential of the AI gateway has no endpoint and no resource name.',
				);
			}
			const apiKey = stringField(credential, 'apiKey');
			return {
				url: query(this.checkedUrl(`${base}${rest}`, backend.displayName)),
				auth: apiKey ? { 'api-key': apiKey } : {},
				body,
			};
		}

		if (backend?.kind === 'google-cloud') {
			const location = documentAiLocation(rest);
			const origin = location ? this.vertex.documentAiOrigin(location) : this.vertex.visionOrigin();
			return {
				url: query(new URL(`${origin}${rest}`)),
				auth: { authorization: `Bearer ${await this.vertexToken(credential)}` },
				body,
			};
		}

		if (provider.format === 'google-ocr' && !backend && documentAiLocation(rest)) {
			throw new GatewayError(
				403,
				'Document AI takes no API keys. Ask an admin for a service account for Google Cloud OCR in the AI gateway.',
			);
		}

		if (backend?.kind === 'vertex-openai') {
			if (rest !== '/chat/completions') throw new GatewayError(403, OPEN_MODELS_CHAT_ONLY);
			const target = this.vertexTargetOf(call);
			return {
				url: query(
					new URL(`${this.vertex.origin(target.location)}${vertexChatCompletionsPath(target)}`),
				),
				auth: { authorization: `Bearer ${await this.vertexToken(credential)}` },
				body,
			};
		}

		if (backend?.kind === 'vertex-ai') {
			const target = this.vertexTargetOf(call);
			const modelCall = geminiModelCall(rest);
			if (!modelCall) throw new GatewayError(403, 'The AI gateway does not support this endpoint.');
			const path = vertexModelPath(target, modelCall.model, modelCall.action);
			return {
				url: query(new URL(`${this.vertex.origin(target.location)}${path}`)),
				auth: { authorization: `Bearer ${await this.vertexToken(credential)}` },
				body:
					modelCall.action === 'embedContent' && isRecord(body.json)
						? encodeJson(withoutModelField(body.json))
						: body,
			};
		}

		const base = (stringField(credential, provider.urlField) || provider.defaultBaseUrl).replace(
			/\/+$/,
			'',
		);
		const auth: Record<string, string> = {};
		const apiKey = stringField(credential, provider.apiKeyField);
		if (apiKey) {
			if (provider.auth === 'x-api-key') auth['x-api-key'] = apiKey;
			else if (provider.auth === 'google') auth['x-goog-api-key'] = apiKey;
			else auth.authorization = `Bearer ${apiKey}`;
		}
		const organization = stringField(credential, 'organizationId');
		if (provider.slug === 'openai' && organization) auth['openai-organization'] = organization;
		// The custom header option of the OpenAI and Anthropic credentials.
		const headerName = stringField(credential, 'headerName');
		if (credential.header === true && headerName) {
			auth[headerName.toLowerCase()] = stringField(credential, 'headerValue');
		}
		return {
			url: query(this.checkedUrl(`${base}${rest}`, provider.displayName)),
			auth,
			body,
		};
	}

	/** A URL of a credential, when it is a valid http or https URL. */
	private checkedUrl(value: string, name: string) {
		let upstream: URL;
		try {
			upstream = new URL(value);
		} catch {
			throw new GatewayError(503, `The URL of the ${name} credential is not valid.`);
		}
		if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
			throw new GatewayError(503, `The URL of the ${name} credential is not valid.`);
		}
		return upstream;
	}

	private vertexTargetOf(call: GatewayCall) {
		const target = vertexTarget(call.providerSettings, call.credential);
		if (!target) {
			throw new GatewayError(
				503,
				'The AI gateway needs the project of Google Cloud for Vertex AI. An admin sets it on the page Settings > AI gateway.',
			);
		}
		return target;
	}

	private async vertexToken(credential: ICredentialDataDecryptedObject) {
		try {
			return await this.vertex.accessToken(credential);
		} catch (error) {
			if (!(error instanceof VertexSignInError)) throw error;
			this.logger.warn('The AI gateway could not sign in to Google Cloud', {
				error: error.message,
			});
			throw new GatewayError(
				503,
				'The AI gateway could not sign in to Google Cloud with the credential of the admin.',
			);
		}
	}

	/**
	 * Vertex AI has no `batchEmbedContents`, so the proxy sends one `embedContent` call for each
	 * request of the batch, a few at a time, and gives the answer of the Gemini API.
	 */
	private async batchEmbedOnVertex(
		call: GatewayCall,
		res: Response,
		model: string,
		price: AiGatewayModelPrice,
		body: CallBody,
	) {
		const requests = isRecord(body.json) ? body.json.requests : undefined;
		if (!Array.isArray(requests) || requests.length === 0) {
			throw new GatewayError(400, 'The batch of the call has no requests.');
		}
		if (requests.length > MAX_VERTEX_BATCH) {
			throw new GatewayError(400, `A batch can have up to ${MAX_VERTEX_BATCH} requests.`);
		}
		const target = this.vertexTargetOf(call);
		const url = new URL(
			`${this.vertex.origin(target.location)}${vertexModelPath(target, model, 'embedContent')}`,
		);
		const headers = this.upstreamHeaders(call.req, {
			authorization: `Bearer ${await this.vertexToken(call.credential)}`,
		});
		headers.set('content-type', 'application/json');

		const abort = new AbortController();
		res.on('close', () => {
			if (!res.writableFinished) abort.abort();
		});
		const fetch = this.fetch();
		const embeddings: unknown[] = new Array<unknown>(requests.length);
		let inputTokens = 0;
		let estimated = false;
		let failure: { status: number; body: unknown } | undefined;
		let next = 0;
		const work = async () => {
			while (failure === undefined && next < requests.length) {
				const index = next++;
				const single = withoutModelField(requests[index]);
				const response = await fetch(url, {
					method: 'POST',
					headers,
					body: JSON.stringify(single),
					signal: abort.signal,
					redirect: 'manual',
				});
				const answer: unknown = await response.json().catch(() => undefined);
				if (!response.ok) {
					failure ??= { status: response.status, body: answer };
					return;
				}
				embeddings[index] = isRecord(answer) ? answer.embedding : undefined;
				const reported = usageOf('gemini', answer)?.inputTokens;
				if (reported) inputTokens += reported;
				else {
					inputTokens += estimateGeminiEmbeddingTokens(single);
					estimated = true;
				}
			}
		};
		try {
			await Promise.all(
				Array.from({ length: Math.min(VERTEX_BATCH_CONCURRENCY, requests.length) }, work),
			);
		} finally {
			// The calls that worked cost their tokens, also when another call of the batch failed.
			if (inputTokens > 0) {
				await this.record(call, model, price, {
					inputTokens,
					outputTokens: 0,
					cachedInputTokens: 0,
					estimated,
				});
			}
		}
		if (failure) {
			res.status(failure.status).json(
				failure.body ?? {
					error: { code: failure.status, message: 'Vertex AI refused the call.' },
				},
			);
			return;
		}
		res.json({ embeddings });
	}

	private fetch() {
		return this.outboundHttp.transport({ useDefaultSsrfPolicy: 'safe' }).asCustomFetch();
	}

	/** The token that the node sent, in the place of the API key of the provider. */
	private tokenOf(req: Request, url: URL, provider: AiGatewayProvider) {
		const header = (name: string) => {
			const value = req.headers[name];
			return typeof value === 'string' ? value : '';
		};
		const bearer = header('authorization').replace(/^Bearer\s+/i, '');
		if (provider.auth === 'x-api-key') return header('x-api-key') || bearer;
		if (provider.auth === 'google') {
			return header('x-goog-api-key') || url.searchParams.get('key') || bearer;
		}
		return bearer;
	}

	/** The body of a call, and its JSON when it has one. */
	private bodyOf(req: Request): CallBody {
		const raw: unknown = req.rawBody;
		if (!Buffer.isBuffer(raw) || raw.length === 0) return {};
		if (raw.length > this.config.maxRequestMb * 1024 * 1024) {
			throw new GatewayError(413, 'The request is too large for the AI gateway.');
		}
		const json: unknown = req.is('application/json') ? req.body : undefined;
		return { raw: new Uint8Array(raw), json };
	}

	private modelOf(endpoint: Extract<GatewayEndpoint, { kind: 'metered' }>, json: unknown) {
		const model =
			endpoint.model === 'body'
				? isRecord(json)
					? json.model
					: undefined
				: endpoint.model.fromPath;
		if (typeof model !== 'string' || !model.trim()) {
			throw new GatewayError(400, 'The AI gateway needs the model of the call.');
		}
		return model.trim();
	}

	/** Asks the provider for the usage of a stream (OpenAI format) and for the cost (OpenRouter). */
	private withUsageRequest(
		provider: AiGatewayProvider,
		endpoint: Extract<GatewayEndpoint, { kind: 'metered' }>,
		body: CallBody,
	) {
		if (!isRecord(body.json)) return body;
		const json: Record<string, unknown> = { ...body.json };
		let changed = false;
		if (endpoint.streamUsage === 'openai' && json.stream === true) {
			const options = isRecord(json.stream_options) ? json.stream_options : {};
			json.stream_options = { ...options, include_usage: true };
			changed = true;
		}
		if (provider.slug === 'openrouter' && !isRecord(json.usage)) {
			json.usage = { include: true };
			changed = true;
		}
		return changed ? encodeJson(json) : body;
	}

	/** The headers of the call without the ones that the proxy drops, and the authentication. */
	private upstreamHeaders(req: Request, auth: Record<string, string>) {
		const headers = new Headers();
		for (const [name, value] of Object.entries(req.headers)) {
			const lower = name.toLowerCase();
			if (DROPPED_REQUEST_HEADERS.has(lower) || lower.startsWith('x-forwarded-')) continue;
			if (typeof value === 'string') headers.set(lower, value);
			else if (Array.isArray(value)) headers.set(lower, value.join(', '));
		}
		for (const [name, value] of Object.entries(auth)) headers.set(name, value);
		return headers;
	}

	/** Keeps the models of a model list that have a price. */
	private pricedModels(provider: AiGatewayProvider, listed: unknown) {
		if (!isRecord(listed)) return listed;
		const hasPrice = (id: unknown) =>
			typeof id === 'string' && this.prices.priceOf(provider, id) !== undefined;
		if (Array.isArray(listed.data)) {
			return {
				...listed,
				data: listed.data.filter((model) => hasPrice(isRecord(model) ? model.id : undefined)),
			};
		}
		if (Array.isArray(listed.models)) {
			return {
				...listed,
				models: listed.models.filter((model) =>
					hasPrice(isRecord(model) ? (model.name ?? model.model) : undefined),
				),
			};
		}
		return listed;
	}

	/** Passes the answer back as it comes, and gives each chunk to the meter. */
	private async pipe(response: globalThis.Response, res: Response, meter: UsageMeter | undefined) {
		if (!response.body) return;
		const reader = response.body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				meter?.push(value);
				if (!res.write(value)) await drained(res);
				if ('flush' in res && typeof res.flush === 'function') res.flush();
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * The usage that the gateway records for an answer. The embedding answers of the Gemini API
	 * have no usage: an estimate. Another answer without usage, or an answer that stopped early,
	 * gets an estimate while the admin keeps the estimates on: the text of the request, and the
	 * text that the answer gave. A usage that the answer reported stays, with the larger output.
	 * See `README.md`, "Estimates".
	 */
	private usageToRecord(
		call: GatewayCall,
		meter: UsageMeter,
		endpoint: Extract<GatewayEndpoint, { kind: 'metered' }>,
		requestBody: unknown,
		completed: boolean,
	): MeteredUsage | undefined {
		const reported = meter.finish();
		if (!reported && endpoint.embedding === 'gemini') {
			return {
				inputTokens: estimateGeminiEmbeddingTokens(requestBody),
				outputTokens: 0,
				cachedInputTokens: 0,
				estimated: true,
			};
		}
		if ((reported && completed) || !this.settings.current().estimateUsage) return reported;

		const inputTokens = estimateInputTokens(call.provider.format, requestBody, call.rest);
		const outputTokens = meter.estimatedOutputTokens();
		if (!reported) {
			this.logger.warn('The answer of a call through the AI gateway had no usage: an estimate', {
				provider: call.provider.slug,
				completed,
			});
			return { inputTokens, outputTokens, cachedInputTokens: 0, estimated: true };
		}
		// The answer stopped early, so its usage can be short of what the provider bills.
		if (reported.inputTokens > 0 && reported.outputTokens >= outputTokens) return reported;
		return {
			...reported,
			inputTokens: reported.inputTokens || inputTokens,
			outputTokens: Math.max(reported.outputTokens, outputTokens),
			estimated: true,
		};
	}

	/**
	 * Records a call that the client stopped before the answer came: an estimate of its input,
	 * while the admin keeps the estimates on.
	 */
	private async recordStoppedCall(
		call: GatewayCall,
		model: string,
		price: AiGatewayModelPrice,
		requestBody: unknown,
	) {
		if (!this.settings.current().estimateUsage) return;
		await this.record(call, model, price, {
			inputTokens: estimateInputTokens(call.provider.format, requestBody, call.rest),
			outputTokens: 0,
			cachedInputTokens: 0,
			estimated: true,
		});
	}

	private async record(
		call: GatewayCall,
		model: string,
		price: AiGatewayModelPrice,
		usage: MeteredUsage,
	) {
		const { provider, userId, attribution } = call;
		const cost = usage.reportedCost ?? costOf(price, usage);
		try {
			await this.budgets.charge({
				userId,
				projectId: attribution.projectId ?? null,
				workflowId: attribution.workflowId ?? null,
				executionId: attribution.executionId ?? null,
				agentId: attribution.agentId ?? null,
				provider: provider.slug,
				model,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cachedInputTokens: usage.cachedInputTokens,
				cost,
				estimated: usage.estimated === true,
			});
		} catch (error) {
			this.logger.error('Failed to record a call through the AI gateway', {
				provider: provider.slug,
				model,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * The type and the decrypted data of the credential of the admin, as an execution reads it
	 * (expressions included). The type is the type of the provider or of one of its backends.
	 */
	private async credentialData(credentialId: string, provider: AiGatewayProvider) {
		const cached = this.credentialCache.get(credentialId);
		if (cached && cached.expiresAt > Date.now()) return cached;
		const credential = await this.credentialsRepository.findOneBy({ id: credentialId });
		if (!credential || !credentialTypesOf(provider).includes(credential.type)) {
			throw new GatewayError(
				503,
				`The credential of ${provider.displayName} for the AI gateway is missing or has the wrong type.`,
			);
		}
		// Load lazily because the execution stack imports the modules.
		const { getBase } = await import('@/workflow-execute-additional-data.js');
		const data = await this.credentialsHelper.getDecrypted(
			await getBase(),
			{ id: credential.id, name: credential.name },
			credential.type,
			'internal',
		);
		const entry = { type: credential.type, data, expiresAt: Date.now() + CREDENTIAL_CACHE_MS };
		this.credentialCache.set(credentialId, entry);
		return entry;
	}
}
