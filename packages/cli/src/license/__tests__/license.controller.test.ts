// Fork: the licence controller has only the route that reads the licence data. The fork has no
// routes that register the Community Edition, request a trial, or activate or renew a licence key
// (packages/cli/src/license/FORK.md).
import { ControllerRegistryMetadata, type Controller } from '@n8n/decorators';
import { Container } from '@n8n/di';

import { LicenseController } from '../license.controller';

describe('LicenseController routes', () => {
	const metadata = Container.get(ControllerRegistryMetadata).getControllerMetadata(
		LicenseController as Controller,
	);

	it('has only the route that reads the licence data', () => {
		const routes = [...metadata.routes.entries()].map(([handler, route]) => ({
			handler,
			method: route.method,
			path: route.path,
		}));
		expect(routes).toEqual([{ handler: 'getLicenseData', method: 'get', path: '/' }]);
	});
});
