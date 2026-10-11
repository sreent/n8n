/** Must match the backend module id. */
export const AUDIT_LOG_MODULE_ID = 'audit-log';

export const AUDIT_LOG_STORE = 'auditLog';

/** Route name of the settings page. */
export const AUDIT_LOG_SETTINGS_VIEW = 'SettingsAuditLogView';

/** The global scope that the REST API of the audit log needs. */
export const AUDIT_LOG_SCOPE = 'auditLogs:manage';

/** The prefix of the names of all audit events. */
export const AUDIT_EVENT_PREFIX = 'n8n.audit.';

/** The backend gives at most 250 events for each page. */
export const PAGE_SIZES = [25, 50, 100, 250];

export const DEFAULT_PAGE_SIZE = 50;

/** The number of users that the user filter reads for each search. */
export const USER_SEARCH_SIZE = 20;
