import { Logger } from '@n8n/backend-common';
import {
	ContextEstablishmentHook,
	type ContextEstablishmentOptions,
	type ContextEstablishmentResult,
	type HookDescription,
	type IContextEstablishmentHook,
} from '@n8n/decorators';
import { isRecord } from '@n8n/utils/is-record';
import type { INodeExecutionData } from 'n8n-workflow';

import { isWebhookTrigger, MASKED_HEADER_VALUE } from './applicable-triggers';

const TIMESTAMP_HEADER = 'x-slack-request-timestamp';
const SIGNATURE_HEADER = 'x-slack-signature';

/**
 * Takes the signed body of a Slack request (a slash command or another form request) as the
 * identity, with the timestamp and the signature. The Slack resolver verifies the signature and
 * reads the Slack user from the body.
 */
@ContextEstablishmentHook()
export class SlackSignatureExtractor implements IContextEstablishmentHook {
	hookDescription: HookDescription = {
		name: 'SlackSignatureExtractor',
		displayName: 'Slack Identity Extractor',
		options: [],
	};

	constructor(private readonly logger: Logger) {}

	isApplicableToTriggerNode(nodeType: string) {
		return isWebhookTrigger(nodeType);
	}

	async execute(options: ContextEstablishmentOptions): Promise<ContextEstablishmentResult> {
		const triggerItems = options.triggerItems;
		if (!triggerItems || triggerItems.length === 0) {
			return this.fail('No trigger items found for Slack identity extraction');
		}
		const item = triggerItems[0];
		const headers = isRecord(item.json.headers) ? item.json.headers : {};
		const timestamp = this.getHeader(headers, TIMESTAMP_HEADER);
		if (!timestamp) return this.fail('Missing X-Slack-Request-Timestamp header');
		const signature = this.getHeader(headers, SIGNATURE_HEADER);
		if (!signature) return this.fail('Missing X-Slack-Signature header');

		const rawBody = this.getRawBody(item, headers);
		if (rawBody === undefined) {
			this.logger.error('Could not retrieve raw body for Slack signature verification');
			throw new Error('Could not retrieve raw body for Slack signature verification.');
		}
		headers[SIGNATURE_HEADER] = MASKED_HEADER_VALUE;
		headers[TIMESTAMP_HEADER] = MASKED_HEADER_VALUE;

		return {
			triggerItems,
			contextUpdate: {
				credentials: {
					identity: rawBody,
					version: 1,
					metadata: { source: 'slack-signature', timestamp, signature },
				},
			},
		};
	}

	private fail(message: string): never {
		this.logger.error(message);
		throw new Error(message);
	}

	private getHeader(headers: Record<string, unknown>, name: string) {
		const value = headers[name];
		return typeof value === 'string' && value.length > 0 ? value : undefined;
	}

	/**
	 * The body that Slack signed. The Webhook node parses a form body into fields, so the hook
	 * encodes the fields again. Slack signs the form bodies of slash commands and interactions.
	 */
	private getRawBody(item: INodeExecutionData, headers: Record<string, unknown>) {
		const contentType = headers['content-type'];
		if (
			typeof contentType === 'string' &&
			!contentType.includes('application/x-www-form-urlencoded')
		) {
			return undefined;
		}
		const body = item.json.body;
		if (!isRecord(body)) return undefined;
		return new URLSearchParams(
			Object.entries(body).map(([key, value]) => [key, String(value)]),
		).toString();
	}
}
