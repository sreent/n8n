import { UserError } from 'n8n-workflow';

import { CredentialResolutionError } from './credential-resolution.error';

/** The resolver that a private credential uses does not exist. */
export class CredentialResolverNotFoundError extends CredentialResolutionError {
	constructor(resolverId: string, credentialName: string) {
		super(`Resolver "${resolverId}" not found for credential "${credentialName}"`);
	}
}

/** A route names a resolver that does not exist. */
export class DynamicCredentialResolverNotFoundError extends UserError {
	constructor(resolverId: string) {
		super(`Credential resolver with ID "${resolverId}" does not exist.`);
	}
}
