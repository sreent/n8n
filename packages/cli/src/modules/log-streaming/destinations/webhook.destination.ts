import type { Logger } from '@n8n/backend-common';
import type { HttpRequestClient } from '@n8n/backend-network';
import { isRecord } from '@n8n/utils/is-record';
import {
	jsonParse,
	OperationalError,
	UserError,
	type GenericValue,
	type ICredentialDataDecryptedObject,
	type IDataObject,
	type IHttpRequestMethods,
	type IHttpRequestOptions,
} from 'n8n-workflow';

import type { EventMessageTypes } from '@/eventbus/event-message-classes';

import type { DestinationCredentials } from './destination-credentials';
import type { WebhookDestinationOptions } from './destination-options';
import { LogStreamingDestination } from './log-streaming-destination';
import { DEFAULT_REQUEST_TIMEOUT_MS, DELIVERY_CONCURRENCY } from '../log-streaming.constants';

const METHODS: readonly IHttpRequestMethods[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

/** The generic credential types that a webhook destination can use. */
export const WEBHOOK_CREDENTIAL_TYPES = [
	'httpBasicAuth',
	'httpBearerAuth',
	'httpHeaderAuth',
	'httpQueryAuth',
	'httpCustomAuth',
] as const;

type WebhookCredentialType = (typeof WEBHOOK_CREDENTIAL_TYPES)[number];

const isWebhookCredentialType = (type: unknown): type is WebhookCredentialType =>
	WEBHOOK_CREDENTIAL_TYPES.some((supported) => supported === type);

type ParameterItems = WebhookDestinationOptions['headerParameters'];

/** A webhook request without the event and the credential. */
interface WebhookRequest extends IHttpRequestOptions {
	headers: IDataObject;
	qs: IDataObject;
}

const isGenericValue = (value: unknown): value is GenericValue =>
	value === null || ['string', 'number', 'boolean', 'object'].includes(typeof value);

const stringValue = (value: unknown) =>
	typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);

/** The parameters from the JSON text of the options, or from the name and value pairs. */
function parameters(
	specify: string | undefined,
	json: string | undefined,
	items: ParameterItems,
	what: string,
): IDataObject {
	const result: IDataObject = {};
	if (specify === 'json') {
		const parsed = jsonParse<unknown>(json || '{}', {
			errorMessage: `The JSON of the ${what} is not valid`,
		});
		if (!isRecord(parsed)) throw new UserError(`The JSON of the ${what} must be an object`);
		for (const [name, value] of Object.entries(parsed)) {
			if (isGenericValue(value)) result[name] = value;
		}
		return result;
	}
	for (const { name, value } of items?.parameters ?? []) {
		if (name) result[name] = value ?? '';
	}
	return result;
}

/** The method of the request. Throws for a method that a destination does not support. */
function method(value: string | undefined): IHttpRequestMethods {
	const upper = (value || 'POST').toUpperCase();
	const supported = METHODS.find((candidate) => candidate === upper);
	if (!supported) throw new UserError(`The method "${value}" is not supported`);
	return supported;
}

/** The credential type and id of a destination that uses a credential, else `undefined`. */
export function webhookCredential(options: WebhookDestinationOptions) {
	if (options.authentication !== 'genericCredentialType') return undefined;
	const type = options.genericAuthType;
	const reference = type ? options.credentials?.[type] : undefined;
	const id = isRecord(reference) && typeof reference.id === 'string' ? reference.id : undefined;
	return { type, id };
}

/**
 * Checks the options that the deliveries use, so that a save tells about a mistake at once.
 * Throws a `UserError`.
 */
export function validateWebhookOptions(options: WebhookDestinationOptions) {
	method(options.method);
	if (options.sendHeaders) {
		parameters(options.specifyHeaders, options.jsonHeaders, options.headerParameters, 'headers');
	}
	if (options.sendQuery) {
		parameters(options.specifyQuery, options.jsonQuery, options.queryParameters, 'query');
	}
	if (options.authentication === 'predefinedCredentialType') {
		throw new UserError('Log streaming supports only generic credential types');
	}
	const credential = webhookCredential(options);
	if (!credential) return;
	if (!isWebhookCredentialType(credential.type)) {
		throw new UserError(
			`Log streaming does not support the credential type "${credential.type ?? ''}". Use one of: ${WEBHOOK_CREDENTIAL_TYPES.join(', ')}`,
		);
	}
	if (!credential.id) throw new UserError('Select a credential for the authentication');
}

/** Adds the values of a credential to the request. */
function authenticate(
	request: WebhookRequest,
	body: IDataObject,
	type: WebhookCredentialType,
	data: ICredentialDataDecryptedObject,
) {
	switch (type) {
		case 'httpBasicAuth':
			request.auth = { username: stringValue(data.user), password: stringValue(data.password) };
			return;
		case 'httpBearerAuth':
			request.headers.Authorization = `Bearer ${stringValue(data.token)}`;
			return;
		case 'httpHeaderAuth':
			request.headers[stringValue(data.name)] = stringValue(data.value);
			return;
		case 'httpQueryAuth':
			request.qs[stringValue(data.name)] = stringValue(data.value);
			return;
		case 'httpCustomAuth': {
			const custom =
				typeof data.json === 'string'
					? jsonParse<unknown>(data.json, {
							errorMessage: 'The JSON of the custom auth credential is not valid',
						})
					: data.json;
			if (!isRecord(custom)) return;
			if (isRecord(custom.headers)) Object.assign(request.headers, custom.headers);
			if (isRecord(custom.qs)) Object.assign(request.qs, custom.qs);
			if (isRecord(custom.body)) Object.assign(body, custom.body);
			return;
		}
	}
}

/**
 * Sends each event as JSON in an HTTP request. A response with a 2xx status code is a success. When
 * `responseCodeMustMatch` is set, only `expectedStatusCode` is a success.
 */
export class WebhookDestination extends LogStreamingDestination<WebhookDestinationOptions> {
	constructor(
		options: WebhookDestinationOptions,
		logger: Logger,
		private readonly client: HttpRequestClient,
		private readonly credentials: DestinationCredentials,
	) {
		super(options, logger, DELIVERY_CONCURRENCY.webhook);
	}

	protected async send(message: EventMessageTypes) {
		const request = await this.request(message);
		const { statusCode } = await this.client.request({
			...request,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		});
		if (!this.isSuccess(statusCode)) {
			throw new OperationalError(`The webhook answered with the status code ${statusCode}`);
		}
	}

	/** The request that delivers the event. */
	async request(message: EventMessageTypes): Promise<IHttpRequestOptions> {
		const { options } = this;
		const body: IDataObject = {
			...this.serialize(message, { withPayload: options.sendPayload !== false }),
		};
		const request: WebhookRequest = {
			url: options.url,
			method: method(options.method),
			headers: {},
			qs: {},
			body,
			json: true,
			timeout: options.options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
		};
		if (options.sendHeaders) {
			const headers = parameters(
				options.specifyHeaders,
				options.jsonHeaders,
				options.headerParameters,
				'headers',
			);
			for (const [name, value] of Object.entries(headers)) {
				request.headers[name] = typeof value === 'object' ? JSON.stringify(value) : value;
			}
		}
		if (options.sendQuery) {
			Object.assign(
				request.qs,
				parameters(options.specifyQuery, options.jsonQuery, options.queryParameters, 'query'),
			);
		}
		this.applyRequestOptions(request);

		const credential = webhookCredential(options);
		if (credential?.id && isWebhookCredentialType(credential.type)) {
			const data = await this.credentials.load(credential.id, credential.type);
			authenticate(request, body, credential.type, data);
		}
		return request;
	}

	private applyRequestOptions(request: WebhookRequest) {
		const requestOptions = this.options.options;
		if (!requestOptions) return;
		if (requestOptions.allowUnauthorizedCerts) request.skipSslCertificateValidation = true;
		if (requestOptions.queryParameterArrays) {
			request.arrayFormat = requestOptions.queryParameterArrays;
		}
		const redirect = requestOptions.redirect?.redirect;
		if (redirect?.followRedirects === false) request.disableFollowRedirect = true;
		if (redirect?.maxRedirects !== undefined) request.maxRedirects = redirect.maxRedirects;
		const proxy = requestOptions.proxy?.proxy;
		if (proxy) request.proxy = { protocol: proxy.protocol, host: proxy.host, port: proxy.port };
	}

	private isSuccess(statusCode: number) {
		if (this.options.responseCodeMustMatch) {
			return statusCode === (this.options.expectedStatusCode ?? 200);
		}
		return statusCode >= 200 && statusCode < 300;
	}
}
