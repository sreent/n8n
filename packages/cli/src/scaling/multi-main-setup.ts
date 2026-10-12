import { Service } from '@n8n/di';
import { UserError } from 'n8n-workflow';

/**
 * Fork stand-in (not in upstream n8n) for the enterprise multi-main setup, which the fork removed.
 * The fork runs one main instance. n8n uses this class only in queue mode with
 * `N8N_MULTI_MAIN_SETUP_ENABLED=true`: then `init()` stops the start. Without a licence, upstream
 * n8n also stops such a start, at its licence check. See `./FORK.md`.
 */
@Service()
export class MultiMainSetup {
	async init(): Promise<void> {
		throw new UserError(
			'Multi-main setup is not in this build of n8n. Set N8N_MULTI_MAIN_SETUP_ENABLED to false, and run one main instance.',
		);
	}

	registerEventHandlers(): void {
		// The instance never joins a multi-main setup, so it has no handlers to register.
	}

	async shutdown(): Promise<void> {
		// The instance never joins a multi-main setup, so it has nothing to leave.
	}

	/** The instance never takes part in a leader election, so there is no leader key. */
	async fetchLeaderKey(): Promise<string | null> {
		return null;
	}
}
