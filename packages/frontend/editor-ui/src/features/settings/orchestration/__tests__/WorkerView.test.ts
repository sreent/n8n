import type { WorkerStatus } from '@n8n/api-types';
import { createTestingPinia } from '@pinia/testing';
import { screen } from '@testing-library/vue';
import { createPinia, setActivePinia } from 'pinia';
import { mock } from 'vitest-mock-extended';

import { renderComponent } from '@/__tests__/render';

import { useOrchestrationStore } from '../orchestration.store';
import WorkerView from '../views/WorkerView.vue';

describe('WorkerView (fork stand-in)', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia());
	});

	it('tells that the worker view is not in this build', () => {
		renderComponent(WorkerView);

		const box = screen.getByTestId('worker-view-unlicensed');
		expect(box).toHaveTextContent('The worker view is not available');
		expect(box).toHaveTextContent(
			'This build of n8n does not show the status of the queue mode workers.',
		);
		expect(screen.getByText('Workers')).toBeInTheDocument();
	});
});

describe('useOrchestrationStore (fork stand-in)', () => {
	it('takes a worker status and keeps nothing', () => {
		setActivePinia(createPinia());
		const store = useOrchestrationStore();

		expect(() => store.updateWorkerStatus(mock<WorkerStatus>())).not.toThrow();
		expect(store.$state).toEqual({});
	});
});
