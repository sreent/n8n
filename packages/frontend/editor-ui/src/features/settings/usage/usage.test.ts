import { createPinia, setActivePinia } from 'pinia';
import { useUsageStore } from '@/features/settings/usage/usage.store';

vi.mock('@n8n/rest-api-client/api/usage');

describe('Usage and plan store', () => {
	let usageStore: ReturnType<typeof useUsageStore>;

	beforeEach(() => {
		setActivePinia(createPinia());
		usageStore = useUsageStore();
		vi.clearAllMocks();
	});

	test.each([
		[5, 3, 0.8, false],
		[5, 4, 0.8, true],
		[5, 4, 0.9, false],
		[10, 5, 0.8, false],
		[10, 8, 0.8, true],
		[10, 9, 0.8, true],
		[-1, 99, 0.8, false],
		[-1, 99, 0.1, false],
	])(
		'should check if workflow usage is close to limit',
		(limit, value, warningThreshold, expectation) => {
			usageStore.setData({
				usage: {
					activeWorkflowTriggers: {
						limit,
						value,
						warningThreshold,
					},
					workflowsHavingEvaluations: {
						value: 0,
						limit: 0,
					},
				},
				license: {
					planId: '',
					planName: '',
				},
			});
			expect(usageStore.isCloseToLimit).toBe(expectation);
		},
	);
});
