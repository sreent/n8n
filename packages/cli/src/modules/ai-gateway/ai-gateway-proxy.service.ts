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
import { AiGatewaySettingsService } from './ai-gateway-settings.service';
import { AiGatewayTokenService } from './ai-gateway-token.service';
import { endpointOf, type GatewayEndpoint, parseGatewayPath } from './gateway-routes';
import { costOf, type AiGatewayModelPrice } from './prices';
import type { AiGatewayApiFormat, AiGatewayProvider } from './providers';
import { estimateGeminiEmbeddingTokens, UsageMeter } from './usage-meter';

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
			: format === 'gemini'
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

const stringField = (data: ICredentialDataDecryptedObject, field: string) => {
	const value = data[field];
	return typeof value === 'string' ? value.trim() : '';
};

/**
 * The proxy of the gateway: it checks the token, the endpoint, the price and the budgets, forwards
 * a call to the provider with the credential of the admin, passes the answer back as it comes, and
 * records the tokens and the cost. See `README.md`, "How a call works".
 */
@Service()
export class AiGatewayProxyService {
	private readonly credentialCache = new Map<
		string,
		{ data: ICredentialDataDecryptedObject; expiresAt: number }
	>();

	constructor(
		private readonly logger: Logger,
		private readonly config: ForkAiGatewayConfig,
		private readonly settings: AiGatewaySettingsService,
		private readonly tokens: AiGatewayTokenService,
		private readonly prices: AiGatewayPriceService,
		private readonly budgets: AiGatewayBudgetService,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly credentialsHelper: CredentialsHelper,
		private readonly outboundHttp: OutboundHttp,
		private readonly globalConfig: GlobalConfig,
		private readonly licenseState: LicenseState,
	) {}

	/** Forgets the decrypted credentials, for example after a change of the settings. */
	clearCredentialCache() {
		this.credentialCache.clear();
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
		attribution: {
			executionId?: string;
			workflowId?: string;
			agentId?: string;
			projectId?: string;
		},
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
		const credentialId = settings.providers[provider.slug]?.credentialId;
		if (!credentialId) {
			throw new GatewayError(503, `The AI gateway has no credential for ${provider.displayName}.`);
		}

		const userId = this.tokens.verify(this.tokenOf(req, url, provider));
		if (!userId) throw new GatewayError(401, 'The token of the AI gateway is not valid.');

		const method = req.method.toUpperCase();
		const endpoint = endpointOf(provider.format, method, rest);
		if (!endpoint) throw new GatewayError(403, 'The AI gateway does not support this endpoint.');

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
			const blocked = await this.budgets.blockReason({ userId, projectId: attribution.projectId });
			if (blocked) throw new GatewayError(402, blocked);
			body = this.withUsageRequest(provider, endpoint, body);
		}

		const credential = await this.credentialData(credentialId, provider);
		const base = (stringField(credential, provider.urlField) || provider.defaultBaseUrl).replace(
			/\/+$/,
			'',
		);
		const upstream = new URL(`${base}${rest}`);
		if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
			throw new GatewayError(
				503,
				`The URL of the ${provider.displayName} credential is not valid.`,
			);
		}
		for (const [name, value] of url.searchParams) {
			if (provider.auth === 'google' && name === 'key') continue;
			upstream.searchParams.append(name, value);
		}

		const abort = new AbortController();
		res.on('close', () => {
			if (!res.writableFinished) abort.abort();
		});
		const fetch = this.outboundHttp.transport({ useDefaultSsrfPolicy: 'safe' }).asCustomFetch();
		const response = await fetch(upstream, {
			method,
			headers: this.upstreamHeaders(req, provider, credential),
			body: body.raw,
			signal: abort.signal,
			redirect: 'manual',
		});

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
			res.json(this.pricedModels(provider, listed));
			return;
		}

		res.setHeader('cache-control', 'no-cache, no-transform');
		res.setHeader('x-accel-buffering', 'no');
		const meter =
			endpoint.kind === 'metered' && ok ? new UsageMeter(provider.format, contentType) : undefined;
		try {
			await this.pipe(response, res, meter);
		} finally {
			// Also a stream that ends early costs the tokens that it used.
			if (meter && model && price && endpoint.kind === 'metered') {
				await this.record(provider, endpoint, model, price, meter, body.json, userId, attribution);
			}
		}
		// End the answer after the record, so that the budget check of the next call sees the cost.
		res.end();
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
	private bodyOf(req: Request): { raw?: Uint8Array<ArrayBuffer>; json?: unknown } {
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
		body: { raw?: Uint8Array<ArrayBuffer>; json?: unknown },
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
		if (!changed) return body;
		return { json, raw: new TextEncoder().encode(JSON.stringify(json)) };
	}

	private upstreamHeaders(
		req: Request,
		provider: AiGatewayProvider,
		credential: ICredentialDataDecryptedObject,
	) {
		const headers = new Headers();
		for (const [name, value] of Object.entries(req.headers)) {
			const lower = name.toLowerCase();
			if (DROPPED_REQUEST_HEADERS.has(lower) || lower.startsWith('x-forwarded-')) continue;
			if (typeof value === 'string') headers.set(lower, value);
			else if (Array.isArray(value)) headers.set(lower, value.join(', '));
		}

		const apiKey = stringField(credential, provider.apiKeyField);
		if (apiKey) {
			if (provider.auth === 'x-api-key') headers.set('x-api-key', apiKey);
			else if (provider.auth === 'google') headers.set('x-goog-api-key', apiKey);
			else headers.set('authorization', `Bearer ${apiKey}`);
		}

		const organization = stringField(credential, 'organizationId');
		if (provider.slug === 'openai' && organization)
			headers.set('openai-organization', organization);
		// The custom header option of the OpenAI and Anthropic credentials.
		const headerName = stringField(credential, 'headerName');
		if (credential.header === true && headerName) {
			headers.set(headerName, stringField(credential, 'headerValue'));
		}
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
				if (!res.write(value)) await new Promise((resolve) => res.once('drain', resolve));
				if ('flush' in res && typeof res.flush === 'function') res.flush();
			}
		} finally {
			reader.releaseLock();
		}
	}

	private async record(
		provider: AiGatewayProvider,
		endpoint: Extract<GatewayEndpoint, { kind: 'metered' }>,
		model: string,
		price: AiGatewayModelPrice,
		meter: UsageMeter,
		requestBody: unknown,
		userId: string,
		attribution: {
			executionId?: string;
			workflowId?: string;
			agentId?: string;
			projectId?: string;
		},
	) {
		let usage = meter.finish();
		if (!usage && endpoint.embedding === 'gemini') {
			// The embedding answers of Gemini have no usage.
			usage = {
				inputTokens: estimateGeminiEmbeddingTokens(requestBody),
				outputTokens: 0,
				cachedInputTokens: 0,
			};
		}
		if (!usage) {
			this.logger.warn('The answer of a call through the AI gateway had no usage', {
				provider: provider.slug,
				model,
			});
			return;
		}
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
			});
		} catch (error) {
			this.logger.error('Failed to record a call through the AI gateway', {
				provider: provider.slug,
				model,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** The decrypted credential of the admin, as an execution reads it (expressions included). */
	private async credentialData(credentialId: string, provider: AiGatewayProvider) {
		const cached = this.credentialCache.get(credentialId);
		if (cached && cached.expiresAt > Date.now()) return cached.data;
		const credential = await this.credentialsRepository.findOneBy({ id: credentialId });
		if (!credential || credential.type !== provider.credentialType) {
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
		this.credentialCache.set(credentialId, { data, expiresAt: Date.now() + CREDENTIAL_CACHE_MS });
		return data;
	}
}
