import { UserError, type UserErrorOptions } from 'n8n-workflow';

/** The data of a private credential could not be stored for a user. */
export class CredentialStorageError extends UserError {
	constructor(message: string, options?: UserErrorOptions) {
		super(message, options);
	}
}
