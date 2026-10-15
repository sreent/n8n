import { isRecord } from '@n8n/utils/is-record';
import type { IDataObject, IExecuteFunctions, JsonObject } from 'n8n-workflow';
import { jsonParse, NodeApiError, NodeOperationError } from 'n8n-workflow';

import { getGoogleAccessToken } from '../GenericFunctions';

/** The default URL of the Cloud Vision API. */
export const VISION_API_URL = 'https://vision.googleapis.com';

/** A processor of Document AI, with an optional version. The group is the location. */
const PROCESSOR_NAME =
	/^projects\/[^/\s]+\/locations\/([a-z][a-z0-9-]*)\/processors\/[^/\s:]+(\/processorVersions\/[^/\s:]+)?$/;

export type GoogleCloudOcrApi = 'vision' | 'documentAi';

/** The location of a processor of Document AI, or `undefined` when its name is not valid. */
export function processorLocation(processor: string) {
	return PROCESSOR_NAME.exec(processor)?.[1];
}

/** The records of an array, for the lists of an answer. */
export function recordsOf(value: unknown) {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function textOf(value: unknown) {
	return typeof value === 'string' ? value : '';
}

/** A part of an answer as node output. */
export function toDataObject(value: Record<string, unknown>) {
	return jsonParse<IDataObject>(JSON.stringify(value));
}

/**
 * Sends a request to the Cloud Vision API or to Document AI with the credential of the node.
 * A service account serves both APIs. An API key serves the Vision API only, unless the
 * credential has another URL, such as the AI gateway of the fork, which serves both.
 */
export async function googleCloudOcrRequest(
	this: IExecuteFunctions,
	api: GoogleCloudOcrApi,
	path: string,
	body: IDataObject,
	location = 'us',
): Promise<unknown> {
	const authentication = this.getNodeParameter('authentication', 0);
	try {
		if (authentication === 'apiKey') {
			const credentials = await this.getCredentials('googleCloudOcrApi');
			const host = (textOf(credentials.host).trim() || VISION_API_URL).replace(/\/+$/, '');
			if (api === 'documentAi' && host === VISION_API_URL) {
				throw new NodeOperationError(this.getNode(), 'Document AI does not take API keys', {
					description: 'Use a service account, or Gateway credits.',
				});
			}
			return await this.helpers.httpRequestWithAuthentication.call(this, 'googleCloudOcrApi', {
				method: 'POST',
				url: `${host}${path}`,
				body,
				json: true,
			});
		}

		const credentials = await this.getCredentials('googleApi');
		// The scope of the service key "vertex" is cloud-platform, which the two APIs take.
		const token = await getGoogleAccessToken.call(this, credentials, 'vertex');
		const base =
			api === 'vision' ? VISION_API_URL : `https://${location}-documentai.googleapis.com`;
		return await this.helpers.httpRequest({
			method: 'POST',
			url: `${base}${path}`,
			body,
			json: true,
			headers: { Authorization: `Bearer ${textOf(token.access_token)}` },
		});
	} catch (error) {
		if (error instanceof NodeOperationError) throw error;
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}
