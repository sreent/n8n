import type { ConnectionSecurity, LdapConfig } from '@n8n/constants';
import type { AuthProviderSyncHistory, User } from '@n8n/db';
import { isValidEmail } from '@n8n/db';
import { Container } from '@n8n/di';
import { validate as jsonSchemaValidate } from 'jsonschema';
import type { Entry } from 'ldapts';

import { BINARY_AD_ATTRIBUTES, DEFAULT_USER_FILTER, LDAP_CONFIG_SCHEMA } from './constants';
import { LdapRepository } from './database/ldap.repository';
import type { LdapRawUserEntry, LdapSynchronizationData, LdapUserData } from './types';

/**
 * Checks a configuration against the schema. The message lists each error as
 * `request.body.<field> <error>`, separated by commas, as the REST API gives it.
 */
export function validateLdapConfigurationSchema(ldapConfig: unknown): {
	valid: boolean;
	message: string;
} {
	const { valid, errors } = jsonSchemaValidate(ldapConfig, LDAP_CONFIG_SCHEMA, {
		nestedErrors: true,
	});
	const message = valid
		? ''
		: errors.map((error) => `request.body.${String(error.path[0])} ${error.message}`).join(',');
	return { valid, message };
}

/** True when the value passes the schema of the configuration. */
export function isLdapConfig(value: unknown): value is LdapConfig {
	return validateLdapConfigurationSchema(value).valid;
}

/** Escapes the characters that have a meaning in an LDAP filter (RFC 4515). */
export function escapeFilter(value: string): string {
	return value
		.replace(/\\/g, '\\5c')
		.replace(/\*/g, '\\2a')
		.replace(/\(/g, '\\28')
		.replace(/\)/g, '\\29')
		.replace(/\0/g, '\\00');
}

/** The filter of a search: the user filter of the configuration and the filter of the search. */
export function createFilter(filter: string, userFilter: string): string {
	return `(&${userFilter || DEFAULT_USER_FILTER}${filter})`;
}

/** The URL of the directory, with `ldaps` for TLS. */
export function formatUrl(url: string, port: number, security: ConnectionSecurity): string {
	const protocol = security === 'tls' ? 'ldaps' : 'ldap';
	return `${protocol}://${url}:${port}`;
}

/** The attributes that a search asks for. The email comes first and last, as in the original. */
export function getMappingAttributes(ldapConfig: LdapConfig): string[] {
	return [
		ldapConfig.emailAttribute,
		ldapConfig.ldapIdAttribute,
		ldapConfig.firstNameAttribute,
		ldapConfig.lastNameAttribute,
		ldapConfig.emailAttribute,
	];
}

const toHex = (value: unknown): unknown => (Buffer.isBuffer(value) ? value.toString('hex') : value);

/** Writes the binary Active Directory attributes of an entry as hexadecimal strings. */
export function resolveEntryBinaryAttributes(entry: Entry): Entry {
	for (const attribute of BINARY_AD_ATTRIBUTES) {
		const value: unknown = entry[attribute];
		if (Buffer.isBuffer(value)) {
			entry[attribute] = value.toString('hex');
		} else if (Array.isArray(value) && value.some((item) => Buffer.isBuffer(item))) {
			entry[attribute] = value.map((item) => String(toHex(item)));
		}
	}
	return entry;
}

export function resolveBinaryAttributes(entries: Entry[]): void {
	for (const entry of entries) resolveEntryBinaryAttributes(entry);
}

/**
 * The LDAP ID and the user fields of an entry, as the directory gives them. An attribute with
 * more values stays a list, and a missing attribute stays undefined. The callers check them.
 */
export function mapLdapAttributesToUser(entry: Entry, ldapConfig: LdapConfig): LdapRawUserEntry {
	return [
		entry[ldapConfig.ldapIdAttribute],
		{
			email: entry[ldapConfig.emailAttribute],
			firstName: entry[ldapConfig.firstNameAttribute],
			lastName: entry[ldapConfig.lastNameAttribute],
		},
	];
}

/** The user fields of an entry with a valid email. A name that is not one text stays unset. */
export function toLdapUserData(fields: LdapRawUserEntry[1]): LdapUserData | undefined {
	if (typeof fields.email !== 'string' || !isValidEmail(fields.email)) return undefined;
	const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
	return {
		email: fields.email,
		firstName: text(fields.firstName),
		lastName: text(fields.lastName),
	};
}

/** The users with an LDAP identity. */
export async function getLdapUsers(): Promise<User[]> {
	return await Container.get(LdapRepository).findLdapUsers();
}

/** Adds a run to the synchronization history. */
export async function saveLdapSynchronization(
	data: LdapSynchronizationData,
): Promise<AuthProviderSyncHistory> {
	return await Container.get(LdapRepository).saveSynchronization(data);
}

/** A page of the synchronization history for the REST API, newest first. */
export async function getLdapSynchronizations(
	page: number,
	perPage: number,
): Promise<AuthProviderSyncHistory[]> {
	return await Container.get(LdapRepository).findSynchronizations(page, perPage);
}

/** A part of the synchronization history and the count of all runs, for the public API. */
export async function getLdapSynchronizationsWithCount(
	offset: number,
	limit: number,
): Promise<[AuthProviderSyncHistory[], number]> {
	return await Container.get(LdapRepository).findSynchronizationsWithCount(offset, limit);
}
