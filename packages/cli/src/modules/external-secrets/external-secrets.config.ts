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
}
