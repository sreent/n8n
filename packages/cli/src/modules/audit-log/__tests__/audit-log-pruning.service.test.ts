import { mockLogger } from '@n8n/backend-test-utils';
import { mock } from 'vitest-mock-extended';

import { AuditLogPruningService } from '../audit-log-pruning.service';
import { AuditLogConfig } from '../audit-log.config';
import type { AuditLogEventRepository } from '../database/audit-log-event.repository';

describe('AuditLogPruningService', () => {
	const now = new Date('2026-10-11T12:00:00.000Z');
	let config: AuditLogConfig;
	let repository: ReturnType<typeof mock<AuditLogEventRepository>>;
	let service: AuditLogPruningService;

	beforeEach(() => {
		config = new AuditLogConfig();
		repository = mock<AuditLogEventRepository>();
		repository.deleteOlderThan.mockResolvedValue(3);
		service = new AuditLogPruningService(mockLogger(), repository, config);
	});

	it('keeps 90 days by default', async () => {
		expect(await service.prune(now)).toBe(3);
		expect(repository.deleteOlderThan).toHaveBeenCalledWith(new Date('2026-07-13T12:00:00.000Z'));
	});

	it('uses the configured retention', async () => {
		config.retentionDays = 1;
		await service.prune(now);
		expect(repository.deleteOlderThan).toHaveBeenCalledWith(new Date('2026-10-10T12:00:00.000Z'));
	});

	it.each([0, -1])('keeps all events with a retention of %s days', async (retentionDays) => {
		config.retentionDays = retentionDays;
		expect(await service.prune(now)).toBe(0);
		expect(repository.deleteOlderThan).not.toHaveBeenCalled();
	});
});
