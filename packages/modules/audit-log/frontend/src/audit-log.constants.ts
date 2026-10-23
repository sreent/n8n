import { AUDIT_LOG_MAX_PAGE_SIZE } from '@n8n/api-types';

/** Must match the backend module id. */
export const AUDIT_LOG_MODULE_ID = 'audit-log';

export const AUDIT_LOG_STORE = 'auditLog';

/** Route name of the settings page. */
export const AUDIT_LOG_SETTINGS_VIEW = 'SettingsAuditLogView';

/** The global scope that the REST API of the audit log needs. */
export const AUDIT_LOG_SCOPE = 'auditLogs:manage';

/** The prefix of the names of all audit events. */
export const AUDIT_EVENT_PREFIX = 'n8n.audit.';

/** The page sizes of the table. The backend gives at most `AUDIT_LOG_MAX_PAGE_SIZE` events. */
export const PAGE_SIZES = [25, 50, 100, AUDIT_LOG_MAX_PAGE_SIZE];

/** The number of users that the user filter reads for each search. */
export const USER_SEARCH_SIZE = 20;
