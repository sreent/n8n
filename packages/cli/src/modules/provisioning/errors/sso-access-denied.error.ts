import { ForbiddenError } from '@n8n/errors';

/**
 * The role provisioning refuses a sign-in: the role that it gives is `block:access`. The SSO
 * callbacks redirect to the sign-in page with `ssoError=access-denied`.
 */
export class SsoAccessDeniedError extends ForbiddenError {
	constructor() {
		super('The role mapping of the instance does not give access to this account');
	}
}
