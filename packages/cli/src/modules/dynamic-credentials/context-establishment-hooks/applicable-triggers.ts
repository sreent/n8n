/** The trigger nodes that receive the requests from which the hooks extract an identity. */
const WEBHOOK_TRIGGER_TYPES = ['n8n-nodes-base.webhook', 'webhook'];

export function isWebhookTrigger(nodeType: string) {
	return WEBHOOK_TRIGGER_TYPES.includes(nodeType);
}

/** The value that replaces a header with an identity in the stored trigger items. */
export const MASKED_HEADER_VALUE = '**********';
