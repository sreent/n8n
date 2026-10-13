// Fork code (not in upstream n8n): hands the work of the Tests panel to its parts. See
// `../../FORK.md`.
import type { InjectionKey } from 'vue';
import { inject } from 'vue';

import type { TestsPanelContext } from '../../composables/useTestsPanel';

export const TestsPanelKey: InjectionKey<TestsPanelContext> = Symbol('TestsPanel');

export function injectTestsPanel(): TestsPanelContext {
	const context = inject(TestsPanelKey);
	if (!context) throw new Error('The parts of the Tests panel need the Tests panel');
	return context;
}
