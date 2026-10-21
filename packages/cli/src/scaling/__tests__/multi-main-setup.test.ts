import { mockLogger } from '@n8n/backend-test-utils';
import type { GlobalConfig } from '@n8n/config';
import type { MultiMainMetadata } from '@n8n/decorators';
import type { ErrorReporter, InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import type { LeaderElectionClient } from '@/scaling/leader-election-client';
import { MultiMainSetup } from '@/scaling/multi-main-setup';

describe('MultiMainSetup', () => {
	it('has no listener limit, because n8n has more leader handlers than the default of 10', () => {
		const multiMainSetup = new MultiMainSetup(
			mockLogger(),
			mock<InstanceSettings>(),
			mock<GlobalConfig>(),
			mock<MultiMainMetadata>(),
			mock<ErrorReporter>(),
			mock<LeaderElectionClient>(),
		);

		for (let i = 0; i < 20; i++) multiMainSetup.on('leader-takeover', () => {});

		expect(multiMainSetup.listenerCount('leader-takeover')).toBe(20);
		expect(multiMainSetup.getMaxListeners()).toBe(0);
	});
});
