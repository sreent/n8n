// Fork store (not in upstream n8n): the sharing state of workflows, in place of the enterprise
// `workflows.ee.store.ts`. It keeps the store id and the name `useWorkflowsEEStore`, so that
// callers change only their import. packages/frontend/editor-ui/FORK.md describes it.
import { useI18n } from '@n8n/i18n';
import { STORES } from '@n8n/stores';
import { useRootStore } from '@n8n/stores/useRootStore';
import { defineStore } from 'pinia';
import { computed } from 'vue';

import { setWorkflowSharedWith as saveSharing } from '@/app/api/workflowSharing';
import {
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';
import { useWorkflowsListStore } from '@/app/stores/workflowsList.store';
import type { ProjectSharingData } from '@/features/collaboration/projects/projects.types';
import { splitName } from '@/features/collaboration/projects/projects.utils';

type SharingPayload = {
	workflowId: string;
	sharedWithProjects: ProjectSharingData[];
};

export const useWorkflowsEEStore = defineStore(STORES.WORKFLOWS_EE, () => {
	const i18n = useI18n();
	const rootStore = useRootStore();
	const workflowsListStore = useWorkflowsListStore();

	/**
	 * The name of the project that owns a workflow of the workflow list: "Name (email)" for a
	 * personal project, the project name for a team project, else the fallback.
	 */
	const getWorkflowOwnerName = computed(
		() =>
			(
				workflowId: string,
				fallback = i18n.baseText('workflows.shareModal.info.sharee.fallback'),
			): string => {
				const workflow = workflowsListStore.getWorkflowById(workflowId);
				const { name, email } = splitName(workflow?.homeProject?.name ?? '');
				if (!name) return email ?? fallback;
				return email ? `${name} (${email})` : name;
			},
	);

	/** Set the projects that a workflow is shared with, in the editor and in the workflow list. */
	function setWorkflowSharedWith({ workflowId, sharedWithProjects }: SharingPayload) {
		useWorkflowDocumentStore(createWorkflowDocumentId(workflowId)).setSharedWithProjects(
			sharedWithProjects,
		);
		workflowsListStore.updateWorkflowInCache(workflowId, { sharedWithProjects });
	}

	/** Save the projects that a workflow is shared with, then set them in the stores. */
	async function saveWorkflowSharedWith(payload: SharingPayload) {
		await saveSharing(rootStore.restApiContext, payload.workflowId, {
			shareWithIds: payload.sharedWithProjects.map(({ id }) => id),
		});
		setWorkflowSharedWith(payload);
	}

	return { getWorkflowOwnerName, setWorkflowSharedWith, saveWorkflowSharedWith };
});
