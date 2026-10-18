import { Config, Env } from '@n8n/config';

@Config
export class OpenTriggersConfig {
	/**
	 * Whether a publish stops for a Webhook, Form, public Chat or MCP Server Trigger node without
	 * authentication, until a workflow review approves the trigger.
	 */
	@Env('N8N_OPEN_TRIGGERS_NEED_APPROVAL')
	needApproval: boolean = false;
}
