/**
 * Fork code (not in upstream n8n): the audit events of the governance actions of the fork
 * features. `ForkGovernanceEventRelay` sends them. `eventNamesAudit` includes them, so log
 * streaming destinations and the audit log get them like the audit events of n8n.
 */
export const forkEventNamesAudit = [
	'n8n.audit.git-sync.settings.saved',
	'n8n.audit.git-sync.disconnected',
	'n8n.audit.git-sync.pushed',
	'n8n.audit.git-sync.pulled',
	'n8n.audit.ai-gateway.settings.updated',
	'n8n.audit.ai-gateway.top-up.added',
	'n8n.audit.log-streaming.destination.created',
	'n8n.audit.log-streaming.destination.updated',
	'n8n.audit.log-streaming.destination.deleted',
	'n8n.audit.git-connection.provider.created',
	'n8n.audit.git-connection.provider.updated',
	'n8n.audit.git-connection.provider.deleted',
	'n8n.audit.git-connection.created',
	'n8n.audit.git-connection.updated',
	'n8n.audit.git-connection.deleted',
	'n8n.audit.git-connection.promoted',
	'n8n.audit.git-connection.applied',
	'n8n.audit.source-control.settings.saved',
	'n8n.audit.source-control.disconnected',
	'n8n.audit.source-control.pushed',
	'n8n.audit.source-control.pulled',
	'n8n.audit.ldap.settings.saved',
	'n8n.audit.ldap.synchronized',
] as const;
