import { Config, Env } from '@n8n/config';

/** Fork code (not in upstream n8n). The settings of external secrets. */
@Config
export class ExternalSecretsConfig {
	/** How often n8n reads the secrets of each vault again, in seconds. */
	@Env('N8N_EXTERNAL_SECRETS_UPDATE_INTERVAL')
	updateInterval: number = 300;

	/** The maximum time that n8n waits for a vault to connect, in seconds. */
	@Env('N8N_EXTERNAL_SECRETS_CONNECT_TIMEOUT')
	connectTimeout: number = 20;

	/** The maximum time that n8n waits for a vault to deliver its secrets, in seconds. */
	@Env('N8N_EXTERNAL_SECRETS_REFRESH_TIMEOUT')
	refreshTimeout: number = 20;

	/** Vaults of projects: the connections can belong to projects. */
	@Env('N8N_ENV_FEAT_EXTERNAL_SECRETS_FOR_PROJECTS')
	externalSecretsForProjects: boolean = true;

	/** More than one vault for each provider type: the connections in place of one setting for each type. */
	@Env('N8N_ENV_FEAT_EXTERNAL_SECRETS_MULTIPLE_CONNECTIONS')
	externalSecretsMultipleConnections: boolean = true;

	/** The access of project roles to the vaults of their projects. */
	@Env('N8N_ENV_FEAT_EXTERNAL_SECRETS_ROLE_BASED_ACCESS')
	externalSecretsRoleBasedAccess: boolean = true;
}
