import { Config, Env } from '@n8n/config';

/** Fork config (not in upstream n8n) of the AI gateway module. See `README.md`. */
@Config
export class ForkAiGatewayConfig {
	/**
	 * The URL of the gateway that the nodes call. Empty: `http://127.0.0.1:<N8N_PORT>/ai-gateway`.
	 * Set it when the nodes run on other hosts, for example the workers of queue mode.
	 */
	@Env('N8N_AI_GATEWAY_BASE_URL')
	baseUrl: string = '';

	/** The largest request body of a call, in MB. `N8N_PAYLOAD_SIZE_MAX` also limits it. */
	@Env('N8N_AI_GATEWAY_MAX_REQUEST_MB')
	maxRequestMb: number = 16;
}
