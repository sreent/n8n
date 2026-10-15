import type { LdapConfig } from '@n8n/constants';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';

/**
 * The configuration as the APIs give it: a binding password shows as the blanking value, and an
 * empty one stays empty. A save of the blanking value keeps the stored password.
 */
export function redactLdapConfig(config: LdapConfig): LdapConfig {
	return {
		...config,
		bindingAdminPassword: config.bindingAdminPassword ? CREDENTIAL_BLANKING_VALUE : '',
	};
}
