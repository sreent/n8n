// Fork module (not in upstream n8n): n8n as a SAML service provider, in place of the enterprise
// `service-provider.ee.ts`. The function names that ordinary code imports stay.
// packages/cli/src/modules/sso-saml/FORK.md describes them.
import type { SamlPreferences } from '@n8n/api-types';
import { UrlService } from '@n8n/backend-services';
import { GlobalConfig } from '@n8n/config';
import { Container } from '@n8n/di';
import type { ServiceProviderInstance } from 'samlify';

const POST_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
// The metadata of n8n writes the redirect binding in upper case. The spelling stays, so that the
// metadata stays the same for the identity providers that know it.
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-REDIRECT';
const EMAIL_NAME_ID_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

let serviceProviderInstance: ServiceProviderInstance | undefined;

function restUrl(path: string) {
	const baseUrl = Container.get(UrlService).getInstanceBaseUrl();
	return `${baseUrl}/${Container.get(GlobalConfig).endpoints.rest}${path}`;
}

/** The entity ID of n8n. It is also the URL of its metadata. */
export function getServiceProviderEntityId() {
	return restUrl('/sso/saml/metadata');
}

/** The assertion consumer service: the identity provider sends its responses here. */
export function getServiceProviderReturnUrl() {
	return restUrl('/sso/saml/acs');
}

/** The relay state of a connection test starts with this URL. */
export function getServiceProviderConfigTestReturnUrl() {
	return `${Container.get(UrlService).getInstanceBaseUrl()}/config/test/return`;
}

/**
 * The service provider of the process. The first call makes it from the preferences of that call,
 * and later calls give the same instance: a change of its settings applies after a restart.
 *
 * As in the original, the service provider gets `authnRequestsSigned`, but not the signing key and
 * certificate: a signed login request fails. FORK.md describes this.
 */
export function getServiceProviderInstance(
	preferences: SamlPreferences,
	samlify: typeof import('samlify'),
): ServiceProviderInstance {
	if (serviceProviderInstance) return serviceProviderInstance;

	const returnUrl = getServiceProviderReturnUrl();
	serviceProviderInstance = samlify.ServiceProvider({
		entityID: getServiceProviderEntityId(),
		authnRequestsSigned: preferences.authnRequestsSigned,
		wantAssertionsSigned: preferences.wantAssertionsSigned,
		wantMessageSigned: preferences.wantMessageSigned,
		signatureConfig: preferences.signatureConfig,
		nameIDFormat: [EMAIL_NAME_ID_FORMAT],
		assertionConsumerService: [
			{ isDefault: preferences.acsBinding === 'post', Binding: POST_BINDING, Location: returnUrl },
			{
				isDefault: preferences.acsBinding === 'redirect',
				Binding: REDIRECT_BINDING,
				Location: returnUrl,
			},
		],
	});
	return serviceProviderInstance;
}
