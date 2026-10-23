import { EventService } from '@n8n/backend-services';
import { Redactable } from '@n8n/decorators';
import { Service } from '@n8n/di';

import type { EventNamesAuditType } from '@/eventbus/event-message-classes';
import { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';
import type { ForkGovernanceEventMap } from '@/events/maps/fork-governance.event-map';
import { EventRelay } from '@/events/relays/event-relay';

/** The audit event of each governance event of the fork features. */
const AUDIT_EVENT_NAMES = {
	'git-sync-settings-saved': 'n8n.audit.git-sync.settings.saved',
	'git-sync-disconnected': 'n8n.audit.git-sync.disconnected',
	'git-sync-pushed': 'n8n.audit.git-sync.pushed',
	'git-sync-pulled': 'n8n.audit.git-sync.pulled',
	'ai-gateway-settings-updated': 'n8n.audit.ai-gateway.settings.updated',
	'ai-gateway-top-up-added': 'n8n.audit.ai-gateway.top-up.added',
	'log-streaming-destination-created': 'n8n.audit.log-streaming.destination.created',
	'log-streaming-destination-updated': 'n8n.audit.log-streaming.destination.updated',
	'log-streaming-destination-deleted': 'n8n.audit.log-streaming.destination.deleted',
	'git-connection-provider-created': 'n8n.audit.git-connection.provider.created',
	'git-connection-provider-updated': 'n8n.audit.git-connection.provider.updated',
	'git-connection-provider-deleted': 'n8n.audit.git-connection.provider.deleted',
	'git-connection-created': 'n8n.audit.git-connection.created',
	'git-connection-updated': 'n8n.audit.git-connection.updated',
	'git-connection-deleted': 'n8n.audit.git-connection.deleted',
	'git-connection-promoted': 'n8n.audit.git-connection.promoted',
	'git-connection-applied': 'n8n.audit.git-connection.applied',
	'source-control-settings-saved': 'n8n.audit.source-control.settings.saved',
	'source-control-disconnected': 'n8n.audit.source-control.disconnected',
	'source-control-pushed': 'n8n.audit.source-control.pushed',
	'source-control-pulled': 'n8n.audit.source-control.pulled',
	'ldap-settings-saved': 'n8n.audit.ldap.settings.saved',
	'ldap-synchronized': 'n8n.audit.ldap.synchronized',
} as const satisfies Record<keyof ForkGovernanceEventMap, EventNamesAuditType>;

type ForkGovernanceEvent = ForkGovernanceEventMap[keyof ForkGovernanceEventMap];

/**
 * Fork code (not in upstream n8n): sends the governance actions of the fork features to log
 * streaming and the audit log, as `LogStreamingEventRelay` does for the actions of n8n. The main
 * instance runs it, because only a main instance takes these REST requests.
 */
@Service()
export class ForkGovernanceEventRelay extends EventRelay {
	constructor(
		eventService: EventService,
		private readonly eventBus: MessageEventBus,
	) {
		super(eventService);
	}

	init() {
		const handlers: {
			[EventName in keyof ForkGovernanceEventMap]: (
				event: ForkGovernanceEventMap[EventName],
			) => void;
		} = {
			'git-sync-settings-saved': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['git-sync-settings-saved']),
			'git-sync-disconnected': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['git-sync-disconnected']),
			'git-sync-pushed': (event) => this.send(event, AUDIT_EVENT_NAMES['git-sync-pushed']),
			'git-sync-pulled': (event) => this.send(event, AUDIT_EVENT_NAMES['git-sync-pulled']),
			'ai-gateway-settings-updated': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['ai-gateway-settings-updated']),
			'ai-gateway-top-up-added': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['ai-gateway-top-up-added']),
			'log-streaming-destination-created': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['log-streaming-destination-created']),
			'log-streaming-destination-updated': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['log-streaming-destination-updated']),
			'log-streaming-destination-deleted': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['log-streaming-destination-deleted']),
			'git-connection-provider-created': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['git-connection-provider-created']),
			'git-connection-provider-updated': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['git-connection-provider-updated']),
			'git-connection-provider-deleted': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['git-connection-provider-deleted']),
			'git-connection-created': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['git-connection-created']),
			'git-connection-updated': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['git-connection-updated']),
			'git-connection-deleted': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['git-connection-deleted']),
			'git-connection-promoted': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['git-connection-promoted']),
			'git-connection-applied': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['git-connection-applied']),
			'source-control-settings-saved': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['source-control-settings-saved']),
			'source-control-disconnected': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['source-control-disconnected']),
			'source-control-pushed': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['source-control-pushed']),
			'source-control-pulled': (event) =>
				this.send(event, AUDIT_EVENT_NAMES['source-control-pulled']),
			'ldap-settings-saved': (event) => this.send(event, AUDIT_EVENT_NAMES['ldap-settings-saved']),
			'ldap-synchronized': (event) => this.send(event, AUDIT_EVENT_NAMES['ldap-synchronized']),
		};
		this.setupListeners(handlers);
	}

	/** `@Redactable()` turns `user` into `userId`, `_email`, `_firstName`, `_lastName` and `globalRole`. */
	@Redactable()
	private send({ user, ...rest }: ForkGovernanceEvent, eventName: EventNamesAuditType) {
		void this.eventBus.sendAuditEvent({ eventName, payload: { ...user, ...rest } });
	}
}
