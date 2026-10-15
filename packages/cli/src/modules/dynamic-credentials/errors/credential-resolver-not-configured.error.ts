import { CredentialResolutionError } from './credential-resolution.error';

/** A private credential has no resolver: not on the credential, the workflow or the system. */
export class CredentialResolverNotConfiguredError extends CredentialResolutionError {
	constructor(credentialName: string) {
		super(`No credential resolver is configured for credential "${credentialName}"`);
	}
}
