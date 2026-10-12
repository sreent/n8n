import { Logger } from '@n8n/backend-common';
import { TestRunRepository } from '@n8n/db';
import { Service } from '@n8n/di';

/**
 * Fork code (not in upstream n8n): when n8n starts, it marks the test runs that a stopped
 * instance left `new` or `running` as failed with the error code `INTERRUPTED`. See `../FORK.md`.
 */
@Service()
export class TestRunCleanupService {
	constructor(
		private readonly logger: Logger,
		private readonly testRunRepository: TestRunRepository,
	) {}

	async cleanupIncompleteRuns(): Promise<void> {
		const count = await this.testRunRepository.markAllIncompleteAsFailed();
		if (count > 0) this.logger.info(`Marked ${count} interrupted test runs as failed`);
	}
}
