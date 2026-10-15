import { OperationalError, type OperationalErrorOptions } from 'n8n-workflow';

/** A private credential could not be resolved for a run. */
export class CredentialResolutionError extends OperationalError {
	constructor(message: string, options?: OperationalErrorOptions) {
		super(message, options);
	}
}
