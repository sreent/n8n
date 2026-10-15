import { OperationalError, UserError } from 'n8n-workflow';

/** The directory refused an operation: wrong credentials, an invalid search or a limit. */
export class LdapRejectionError extends UserError {}

/** n8n could not reach the directory. */
export class LdapConnectionError extends OperationalError {}
