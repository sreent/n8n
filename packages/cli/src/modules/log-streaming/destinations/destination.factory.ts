import { Logger } from '@n8n/backend-common';
import { OutboundHttp, type HttpRequestClient } from '@n8n/backend-network';
import { Service } from '@n8n/di';

import { DestinationCredentials } from './destination-credentials';
import type { DestinationOptions } from './destination-options';
import type { LogStreamingDestination } from './log-streaming-destination';
import { SentryDestination } from './sentry.destination';
import { SyslogDestination } from './syslog.destination';
import { WebhookDestination } from './webhook.destination';

/** Makes the destination of stored options. */
@Service()
export class DestinationFactory {
	private readonly client: HttpRequestClient;

	constructor(
		private readonly logger: Logger,
		private readonly credentials: DestinationCredentials,
		outboundHttp: OutboundHttp,
	) {
		this.logger = this.logger.scoped('log-streaming');
		// An admin sets the destinations, and a destination often is in the internal network, for
		// example a SIEM. Thus the outbound network policy of the instance does not apply.
		this.client = outboundHttp.requests({ useDefaultSsrfPolicy: 'unsafe' });
	}

	create(options: DestinationOptions): LogStreamingDestination {
		switch (options.__type) {
			case '$$MessageEventBusDestinationWebhook':
				return new WebhookDestination(options, this.logger, this.client, this.credentials);
			case '$$MessageEventBusDestinationSyslog':
				return new SyslogDestination(options, this.logger);
			case '$$MessageEventBusDestinationSentry':
				return new SentryDestination(options, this.logger, this.client);
		}
	}
}
