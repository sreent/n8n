import { UnexpectedError } from '@n8n/errors';

export class UnknownAuthTypeError extends UnexpectedError {
	constructor(authType: unknown) {
		super('Unknown auth type', { extra: { authType: String(authType) } });
	}
}
