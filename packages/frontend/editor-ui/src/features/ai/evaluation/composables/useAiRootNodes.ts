// Fork code (not in upstream n8n): the AI nodes of the current workflow that the Tests panel can
// test: agents, chains and the model nodes of vendors. It replaces the enterprise composable of
// the same name. See `../FORK.md`.
import { computed } from 'vue';

import { injectWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';

import { isAiRootNodeType } from '../wizard.constants';

export function useAiRootNodes() {
	const workflowDocumentStore = injectWorkflowDocumentStore();
	return computed(() =>
		workflowDocumentStore.value.allNodes
			.filter((node) => isAiRootNodeType(node.type))
			.map((node) => ({ name: node.name, type: node.type })),
	);
}
