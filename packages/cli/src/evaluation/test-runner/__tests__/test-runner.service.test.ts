// Fork test (not in upstream n8n): the cancel of a run that another main instance runs.
import type { TestCaseExecutionRepository, TestRun, TestRunRepository } from '@n8n/db';
import { mock } from 'vitest-mock-extended';
import type { InstanceSettings } from 'n8n-core';

import type { Publisher } from '@/scaling/pubsub/publisher.service';

import { TestRunnerService } from '../test-runner.service';

describe('TestRunnerService', () => {
	const testRunRepository = mock<TestRunRepository>();
	const testCaseExecutionRepository = mock<TestCaseExecutionRepository>();
	const publisher = mock<Publisher>();

	const service = (isMultiMain: boolean) =>
		new TestRunnerService(
			mock(),
			mock(),
			mock(),
			mock(),
			mock(),
			mock(),
			testRunRepository,
			testCaseExecutionRepository,
			mock(),
			mock(),
			mock(),
			mock(),
			mock(),
			mock<InstanceSettings>({ isMultiMain }),
			publisher,
		);

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('cancelTestRun', () => {
		it('ends a run of another instance, and tells the other main instances', async () => {
			await service(true).cancelTestRun('run-1');

			expect(testRunRepository.requestCancellation).toHaveBeenCalledWith('run-1');
			expect(testRunRepository.markAsCancelled).toHaveBeenCalledWith('run-1');
			expect(testCaseExecutionRepository.markAllPendingAsCancelled).toHaveBeenCalledWith('run-1');
			expect(publisher.publishCommand).toHaveBeenCalledWith({
				command: 'cancel-test-run',
				payload: { testRunId: 'run-1' },
			});
		});

		it('sends no command with a single main instance', async () => {
			await service(false).cancelTestRun('run-1');

			expect(testRunRepository.markAsCancelled).toHaveBeenCalledWith('run-1');
			expect(publisher.publishCommand).not.toHaveBeenCalled();
		});
	});

	describe('cancelCollection', () => {
		it('ends the open runs of the collection, and tells the other main instances once', async () => {
			testRunRepository.findOneBy
				.mockResolvedValueOnce(mock<TestRun>({ status: 'running' }))
				.mockResolvedValueOnce(mock<TestRun>({ status: 'completed' }));

			await service(true).cancelCollection('collection-1', ['run-1', 'run-2']);

			expect(testRunRepository.markAsCancelled).toHaveBeenCalledTimes(1);
			expect(testRunRepository.markAsCancelled).toHaveBeenCalledWith('run-1');
			expect(publisher.publishCommand).toHaveBeenCalledTimes(1);
			expect(publisher.publishCommand).toHaveBeenCalledWith({
				command: 'cancel-collection',
				payload: { collectionId: 'collection-1' },
			});
		});
	});
});
