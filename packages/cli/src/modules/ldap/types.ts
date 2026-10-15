import type { AuthenticatedRequest, RunningMode } from '@n8n/db';

/** The user fields that come from the directory, after the check of the email. */
export interface LdapUserData {
	email: string;
	firstName?: string;
	lastName?: string;
}

/** An entry of the directory as its LDAP ID and its user fields. */
export type LdapUserEntry = [ldapId: string, data: LdapUserData];

/** The LDAP ID and the user fields of an entry, before any check. */
export type LdapRawUserEntry = [
	ldapId: unknown,
	fields: { email: unknown; firstName: unknown; lastName: unknown },
];

/** The fields of a synchronization run that the history keeps. */
export interface LdapSynchronizationData {
	startedAt: Date;
	endedAt: Date;
	created: number;
	updated: number;
	disabled: number;
	scanned: number;
	runMode: RunningMode;
	status: 'success' | 'error';
	error: string;
}

export declare namespace LdapRequest {
	type GetSync = AuthenticatedRequest<{}, {}, {}, { page?: string; perPage?: string }>;
	type Sync = AuthenticatedRequest<{}, {}, { type: RunningMode }>;
	type Update = AuthenticatedRequest<{}, {}, unknown>;
}
