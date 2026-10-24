import { componentRegistry } from '@n8n/frontend-module-sdk';
import { defineAsyncComponent } from 'vue';

/**
 * Shell-hosted components that modules render but do not own — the counterpart to
 * `modals.manifest.ts` for the `componentRegistry` slots.
 *
 * Async on purpose: registering these eagerly would pull the owning feature into
 * the boot chunk (the project filter reaches the projects store and ProjectSharing's
 * design-system tree), which is exactly what a module renders a slot to avoid.
 */
export const registerComponentSlots = () => {
	componentRegistry.register(
		'workflow-diff',
		defineAsyncComponent(
			async () => await import('@/features/workflows/workflowDiff/WorkflowDiffSlot.vue'),
		),
	);

	// Fork: no 'promotion-changes' slot. Its component is in the enterprise folder `promotions.ee`,
	// which the fork removed. The fork has no promotion reviews in the inbox, so nothing renders it.

	componentRegistry.register(
		'project-filter',
		defineAsyncComponent(
			async () => await import('@/features/collaboration/projects/components/ProjectFilter.vue'),
		),
	);
};
