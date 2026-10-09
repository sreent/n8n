// Fork module (not in upstream n8n): the sign-in method of the instance and the SAML checks around
// it, in place of the enterprise `sso.ee/sso-helpers.ts`. The exports keep their names, so that the
// callers change only their import. packages/cli/src/sso/FORK.md describes it.
import type { AuthenticationMethod } from '@n8n/api-types';
import { LicenseState } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { SettingsRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { BadRequestError } from '@n8n/errors';

import config from '@/config';

/** The key of the sign-in method in the legacy config and in the settings table. */
const AUTHENTICATION_METHOD_KEY = 'userManagement.authenticationMethod';

/** The sign-in method of the instance, as the config holds it. */
export function getCurrentAuthenticationMethod(): AuthenticationMethod {
	return config.getEnv(AUTHENTICATION_METHOD_KEY);
}

/**
 * Set the sign-in method in the config, and keep it in the settings table, which loads it into
 * the config at the next start. It does not check the method.
 */
export async function setCurrentAuthenticationMethod(method: AuthenticationMethod): Promise<void> {
	config.set(AUTHENTICATION_METHOD_KEY, method);
	await Container.get(SettingsRepository).upsertByKey(AUTHENTICATION_METHOD_KEY, method, true, {});
}

/** True when users sign in through a directory or an identity provider: LDAP, SAML or OIDC. */
export function isSsoCurrentAuthenticationMethod(): boolean {
	const method = getCurrentAuthenticationMethod();
	return method === 'ldap' || method === 'saml' || method === 'oidc';
}

export function isSamlCurrentAuthenticationMethod(): boolean {
	return getCurrentAuthenticationMethod() === 'saml';
}

export function isOidcCurrentAuthenticationMethod(): boolean {
	return getCurrentAuthenticationMethod() === 'oidc';
}

export function isSamlLicensed(): boolean {
	return Container.get(LicenseState).isSamlLicensed();
}

/**
 * True when the SAML login is on, the licence has SAML, and SAML is the sign-in method. The checks
 * run in this order: with the SAML login off, the licence is not read.
 */
export function isSamlLicensedAndEnabled(): boolean {
	return (
		Container.get(GlobalConfig).sso.saml.loginEnabled &&
		isSamlLicensed() &&
		isSamlCurrentAuthenticationMethod()
	);
}

/** The label of the SAML button on the sign-in page. */
export function getSamlLoginLabel(): string {
	return Container.get(GlobalConfig).sso.saml.loginLabel;
}

/**
 * A sign-in method can change its login state only when the current method is email or the
 * method itself.
 */
export function assertAuthenticationMethodCanBeEnabled(method: AuthenticationMethod): void {
	const current = getCurrentAuthenticationMethod();
	if (current !== 'email' && current !== method) {
		throw new BadRequestError(
			`Cannot switch ${method} login enabled state when an authentication method other than email or ${method} is active (current: ${current})`,
		);
	}
}
