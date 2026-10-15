import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';

/**
 * Fork module (not in upstream n8n): LDAP sign-in and the synchronization of LDAP users, in place
 * of the enterprise module `ldap.ee`. It starts only on a main instance and with the licence value
 * `feat:ldap`, which the fork switch gives. The sign-in handler of the service loads the
 * configuration when the handlers start. See `README.md` in this folder.
 */
@BackendModule({ name: 'ldap', licenseFlag: 'feat:ldap', instanceTypes: ['main'] })
export class LdapModule implements ModuleInterface {
	async init() {
		await import('./ldap.controller.js');
	}
}
