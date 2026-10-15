import { Config, Env } from '@n8n/config';
import { z } from 'zod';

const keyPairTypeSchema = z.enum(['ed25519', 'rsa']);

@Config
export class SourceControlConfig {
	/** The type of a new SSH key pair, when the preferences name no type: `ed25519` or `rsa`. */
	@Env('N8N_SOURCECONTROL_DEFAULT_SSH_KEY_TYPE', keyPairTypeSchema)
	defaultKeyPairType: z.infer<typeof keyPairTypeSchema> = 'ed25519';
}
