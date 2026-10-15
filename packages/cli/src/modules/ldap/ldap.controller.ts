import { EventService } from '@n8n/backend-services';
import { Get, GlobalScope, Licensed, Post, Put, RestController } from '@n8n/decorators';
import { BadRequestError } from '@n8n/errors';
import pick from 'lodash/pick';

import { NON_SENSIBLE_LDAP_CONFIG_PROPERTIES } from './constants';
import { getLdapSynchronizations } from './helpers';
import { LdapService } from './ldap.service';
import { redactLdapConfig } from './redact-ldap-config';
import type { LdapRequest } from './types';

/** The message of a failure, for a 400 answer. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Fork code (not in upstream n8n): the REST API of LDAP (`/rest/ldap`), with the routes, the
 * answers and the access rules of the original. See `README.md` in this folder.
 */
@RestController('/ldap')
export class LdapController {
	constructor(
		private readonly ldapService: LdapService,
		private readonly eventService: EventService,
	) {}

	@Get('/config')
	@GlobalScope('ldap:manage')
	@Licensed('feat:ldap')
	async getConfig() {
		return redactLdapConfig(await this.ldapService.loadConfig());
	}

	@Post('/test-connection')
	@GlobalScope('ldap:manage')
	@Licensed('feat:ldap')
	async testConnection() {
		try {
			await this.ldapService.testConnection();
		} catch (error) {
			throw new BadRequestError(messageOf(error));
		}
	}

	@Put('/config')
	@GlobalScope('ldap:manage')
	@Licensed('feat:ldap')
	async updateConfig(req: LdapRequest.Update) {
		try {
			// The service checks the body against the schema of the configuration.
			await this.ldapService.updateConfig(req.body);
		} catch (error) {
			throw new BadRequestError(messageOf(error));
		}

		const config = await this.ldapService.loadConfig();
		this.eventService.emit('ldap-settings-updated', {
			userId: req.user.id,
			...pick(config, NON_SENSIBLE_LDAP_CONFIG_PROPERTIES),
		});
		return redactLdapConfig(config);
	}

	/** A page of the synchronization history: `page` from 0, `perPage` 20 by default. */
	@Get('/sync')
	@GlobalScope('ldap:sync')
	@Licensed('feat:ldap')
	async getLdapSync(req: LdapRequest.GetSync) {
		const { page = '0', perPage = '20' } = req.query;
		return await getLdapSynchronizations(parseInt(page, 10), parseInt(perPage, 10));
	}

	@Post('/sync')
	@GlobalScope('ldap:sync')
	@Licensed('feat:ldap')
	async syncLdap(req: LdapRequest.Sync) {
		try {
			await this.ldapService.runSync(req.body.type);
		} catch (error) {
			throw new BadRequestError(messageOf(error));
		}
	}
}
