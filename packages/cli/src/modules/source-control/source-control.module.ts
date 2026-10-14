import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';

/**
 * Fork module (not in upstream n8n): source control with a Git branch, in place of the
 * enterprise module `source-control.ee`. It starts only with the licence value
 * `feat:sourceControl`, which the fork switch gives. A main instance runs the REST API and the
 * work folder. Other instances read only the preferences, for the read-only flag of a protected
 * instance. See `README.md` in this folder.
 */
@BackendModule({ name: 'source-control', licenseFlag: 'feat:sourceControl' })
export class SourceControlModule implements ModuleInterface {
	async init() {
		if (Container.get(InstanceSettings).instanceType === 'main') {
			await import('./source-control.controller.js');
			const { SourceControlService } = await import('./source-control.service.js');
			await Container.get(SourceControlService).init();
			return;
		}
		const { SourceControlPreferencesService } = await import(
			'./source-control-preferences.service.js'
		);
		await Container.get(SourceControlPreferencesService).loadPreferences();
	}
}
