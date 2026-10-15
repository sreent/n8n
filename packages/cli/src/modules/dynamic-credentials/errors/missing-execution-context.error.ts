import { CredentialResolutionError } from './credential-resolution.error';

/** The run has no identity, so the private credential cannot be resolved for a user. */
export class MissingExecutionContextError extends CredentialResolutionError {
	constructor() {
		super(
			"This node uses an end-user credential, but no user could be identified for this run, so the credential for it couldn't be resolved",
		);
	}
}
