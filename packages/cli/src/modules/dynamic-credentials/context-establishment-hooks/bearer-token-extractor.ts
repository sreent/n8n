import {
	ContextEstablishmentHook,
	type ContextEstablishmentOptions,
	type HookDescription,
	type IContextEstablishmentHook,
} from '@n8n/decorators';

import { isWebhookTrigger } from './applicable-triggers';
import { HttpHeaderExtractor } from './http-header-extractor';

/** Takes the bearer token of the `Authorization` header as the identity of the user. */
@ContextEstablishmentHook()
export class BearerTokenExtractor implements IContextEstablishmentHook {
	hookDescription: HookDescription = {
		name: 'BearerTokenExtractor',
		displayName: 'Bearer Token Extractor',
		options: [],
	};

	constructor(private readonly httpHeaderExtractor: HttpHeaderExtractor) {}

	isApplicableToTriggerNode(nodeType: string) {
		return isWebhookTrigger(nodeType);
	}

	async execute(options: ContextEstablishmentOptions) {
		// The default options of the header extractor read the bearer token.
		return await this.httpHeaderExtractor.execute({ ...options, options: {} });
	}
}
