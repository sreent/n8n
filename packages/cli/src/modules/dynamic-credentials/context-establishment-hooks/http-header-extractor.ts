import { Logger } from '@n8n/backend-common';
import {
	ContextEstablishmentHook,
	type ContextEstablishmentOptions,
	type ContextEstablishmentResult,
	type HookDescription,
	type IContextEstablishmentHook,
} from '@n8n/decorators';
import { isRecord } from '@n8n/utils/is-record';

import { isWebhookTrigger, MASKED_HEADER_VALUE } from './applicable-triggers';

const DEFAULT_HEADER_NAME = 'authorization';
const DEFAULT_HEADER_PATTERN = '[Bb][Ee][Aa][Rr][Ee][Rr]\\s+(.+)';

/**
 * Takes the identity of the user from a header of the webhook request: the first capturing
 * group of a pattern. The stored trigger item keeps the header masked.
 */
@ContextEstablishmentHook()
export class HttpHeaderExtractor implements IContextEstablishmentHook {
	hookDescription: HookDescription = {
		name: 'HttpHeaderExtractor',
		displayName: 'HTTP Header Extractor',
		options: [
			{
				name: 'headerName',
				displayName: 'Header Name',
				type: 'string',
				default: DEFAULT_HEADER_NAME,
				noDataExpression: true,
				description: 'The name of the HTTP header to extract the value from.',
			},
			{
				name: 'headerValue',
				displayName: 'Header Value Pattern',
				type: 'string',
				noDataExpression: true,
				default: DEFAULT_HEADER_PATTERN,
				description:
					'A regular expression pattern to extract the identity from the header value. Use a capturing group to specify the identity part.',
			},
		],
	};

	constructor(private readonly logger: Logger) {}

	isApplicableToTriggerNode(nodeType: string) {
		return isWebhookTrigger(nodeType);
	}

	async execute(options: ContextEstablishmentOptions): Promise<ContextEstablishmentResult> {
		const triggerItems = options.triggerItems;
		if (!triggerItems || triggerItems.length === 0) {
			this.logger.debug('No trigger items found, skipping HttpHeaderExtractor hook.');
			throw new Error('No trigger items found, to perform header extraction');
		}

		const headerName = String(options.options?.headerName ?? DEFAULT_HEADER_NAME).toLowerCase();
		const pattern = String(options.options?.headerValue ?? DEFAULT_HEADER_PATTERN);
		const headers = triggerItems[0].json.headers;
		const value = isRecord(headers) && headerName.length > 0 ? headers[headerName] : undefined;
		if (!isRecord(headers) || typeof value !== 'string') {
			throw new Error('Http header not found or invalid');
		}
		// The identity must not stay readable in the stored execution data.
		headers[headerName] = MASKED_HEADER_VALUE;

		let expression: RegExp;
		try {
			expression = new RegExp(pattern);
		} catch (error) {
			this.logger.error('Invalid regex pattern', { error });
			throw new Error('Failed to execute regex pattern, during header extraction');
		}
		const identity = expression.exec(value)?.[1];
		if (identity === undefined) return { triggerItems };

		return {
			triggerItems,
			contextUpdate: {
				credentials: {
					version: 1,
					identity,
					metadata: { source: 'http-header', headerName },
				},
			},
		};
	}
}
