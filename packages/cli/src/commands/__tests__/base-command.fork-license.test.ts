// Fork test (not in upstream n8n): the start-up activates no licence key, also when
// N8N_LICENSE_ACTIVATION_KEY is set (packages/cli/src/license/FORK.md).
import { LicenseState, Logger } from '@n8n/backend-common';
import { mockInstance } from '@n8n/backend-test-utils';
import { GlobalConfig } from '@n8n/config';
import { Container } from '@n8n/di';

import { License } from '@/license';

import { BaseCommand } from '../base-command';

class TestCommand extends BaseCommand {
	async run() {}
}

const logger = mockInstance(Logger);
const license = mockInstance(License);
mockInstance(LicenseState);

describe('initLicense', () => {
	const licenseConfig = Container.get(GlobalConfig).license;
	const originalKey = licenseConfig.activationKey;

	afterEach(() => {
		licenseConfig.activationKey = originalKey;
		vi.clearAllMocks();
	});

	it('does not activate the key of N8N_LICENSE_ACTIVATION_KEY, and warns', async () => {
		licenseConfig.activationKey = 'a-key';

		await new TestCommand().initLicense();

		expect(license.init).toHaveBeenCalledTimes(1);
		expect(license.activate).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('N8N_LICENSE_ACTIVATION_KEY is set'),
		);
	});

	it('does not warn without a key', async () => {
		licenseConfig.activationKey = '';

		await new TestCommand().initLicense();

		expect(license.init).toHaveBeenCalledTimes(1);
		expect(license.activate).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});
});
