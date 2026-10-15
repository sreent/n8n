import { Config, Env } from '@n8n/config';

/** Fork code (not in upstream n8n). The settings of the dynamic credential endpoints. */
@Config
export class DynamicCredentialsConfig {
	/** The origins that may call the endpoints from a browser, separated by commas. Empty: none. */
	@Env('N8N_DYNAMIC_CREDENTIALS_CORS_ORIGIN')
	corsOrigin: string = '';

	/** Whether a browser may send its credentials (cookies) with a call from another origin. */
	@Env('N8N_DYNAMIC_CREDENTIALS_CORS_ALLOW_CREDENTIALS')
	corsAllowCredentials: boolean = false;

	/**
	 * The token that a caller without an n8n session sends in the header
	 * `X-Authorization: Bearer <token>`. Empty: only callers with a session can use the endpoints.
	 */
	@Env('N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN')
	endpointAuthToken: string = '';

	/** The calls of one IP address in each minute to the status and revoke endpoints. */
	@Env('N8N_DYNAMIC_CREDENTIALS_RATE_LIMIT_PER_MINUTE')
	rateLimitPerMinute: number = 60;

	/** The calls of one IP address in each minute to the authorize endpoints. */
	@Env('N8N_DYNAMIC_CREDENTIALS_AUTHORIZE_RATE_LIMIT_PER_MINUTE')
	rateLimitAuthorizePerMinute: number = 60;
}
