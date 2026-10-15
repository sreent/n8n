import { CredentialResolutionError } from './credential-resolution.error';

/**
 * The run carries an n8n identity, but the resolver of the credential keys its data by the
 * identity of an external user.
 */
export class N8nIdentityNotSupportedError extends CredentialResolutionError {
	constructor(credentialName: string) {
		super(
			`"${credentialName}" resolves credentials per external user, so it can only be resolved by a request carrying that user's token`,
		);
	}
}
