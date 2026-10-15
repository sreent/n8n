import type { LdapConfig } from '@n8n/constants';
import type { Schema } from 'jsonschema';

/** The Active Directory attributes that the search returns as binary data. */
export const BINARY_AD_ATTRIBUTES = ['objectGUID', 'objectSid'];

/** The user filter when the configuration has none. */
export const DEFAULT_USER_FILTER = '(|(objectClass=person)(objectClass=user))';

/**
 * The schema of a configuration that the REST API or the public API saves. It checks only the
 * types and the fields. The order of the properties and of the required fields sets the order of
 * the error messages.
 */
export const LDAP_CONFIG_SCHEMA: Schema = {
	$schema: 'https://json-schema.org/draft/2019-09/schema',
	type: 'object',
	properties: {
		emailAttribute: { type: 'string' },
		firstNameAttribute: { type: 'string' },
		lastNameAttribute: { type: 'string' },
		ldapIdAttribute: { type: 'string' },
		loginIdAttribute: { type: 'string' },
		bindingAdminDn: { type: 'string' },
		bindingAdminPassword: { type: 'string' },
		baseDn: { type: 'string' },
		connectionUrl: { type: 'string' },
		connectionSecurity: { type: 'string' },
		connectionPort: { type: 'number' },
		allowUnauthorizedCerts: { type: 'boolean' },
		userFilter: { type: 'string' },
		loginEnabled: { type: 'boolean' },
		loginLabel: { type: 'string' },
		synchronizationEnabled: { type: 'boolean' },
		synchronizationInterval: { type: 'number' },
		searchPageSize: { type: 'number' },
		searchTimeout: { type: 'number' },
		enforceEmailUniqueness: { type: 'boolean' },
	},
	required: [
		'loginEnabled',
		'loginLabel',
		'connectionUrl',
		'allowUnauthorizedCerts',
		'connectionSecurity',
		'connectionPort',
		'baseDn',
		'bindingAdminDn',
		'bindingAdminPassword',
		'firstNameAttribute',
		'lastNameAttribute',
		'emailAttribute',
		'loginIdAttribute',
		'ldapIdAttribute',
		'userFilter',
		'synchronizationEnabled',
		'synchronizationInterval',
		'searchPageSize',
		'searchTimeout',
	],
	additionalProperties: false,
};

/** The fields of the configuration that the event `ldap-settings-updated` holds. */
export const NON_SENSIBLE_LDAP_CONFIG_PROPERTIES: Array<keyof LdapConfig> = [
	'loginEnabled',
	'emailAttribute',
	'firstNameAttribute',
	'lastNameAttribute',
	'loginIdAttribute',
	'ldapIdAttribute',
	'synchronizationEnabled',
	'synchronizationInterval',
	'searchPageSize',
	'searchTimeout',
	'loginLabel',
	'enforceEmailUniqueness',
];
