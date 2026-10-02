import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Connects one project to a branch of a Git repository. The instance owner and admins
 * push the workflows of the project to Git and pull changes from Git.
 */
@BackendModule({ name: 'git-sync', instanceTypes: ['main'] })
export class GitSyncModule implements ModuleInterface {
	async init() {
		await import('./git-sync.controller.js');

		const { GitSyncService } = await import('./git-sync.service.js');
		await Container.get(GitSyncService).init();
	}
}
