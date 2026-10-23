import { ControllerRegistryMetadata } from '@n8n/decorators';
import { Container } from '@n8n/di';

import { GitSyncController } from '../git-sync.controller';

const metadata = Container.get(ControllerRegistryMetadata).getControllerMetadata(
	GitSyncController as never,
);
const routeCases = Array.from(metadata.routes.entries()).map(([handlerName, route]) => ({
	handlerName,
	route,
}));

describe('GitSyncController', () => {
	it('has the routes of Git sync', () => {
		expect(routeCases.map(({ handlerName }) => handlerName).sort()).toEqual([
			'disconnect',
			'getSettings',
			'getStatus',
			'listProjects',
			'pull',
			'push',
			'saveSettings',
			'testConnection',
		]);
	});

	it.each(routeCases)('$handlerName needs the global scope sourceControl:manage', ({ route }) => {
		expect(route.accessScope).toEqual({ scope: 'sourceControl:manage', globalOnly: true });
	});
});
