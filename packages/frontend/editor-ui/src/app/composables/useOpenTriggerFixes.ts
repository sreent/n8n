// Fork code (not in upstream n8n): the one-click fixes of the publish check of open triggers. The
// modal is in the frontend module `@n8n/frontend-module-open-triggers`. See
// packages/modules/open-triggers/frontend/README.md.
import { OPEN_TRIGGER_VIOLATION_KIND, type PolicyViolation } from '@n8n/api-types';
import {
	createTriggerToken,
	OPEN_TRIGGER_FIXES_MODAL_KEY,
	openTriggerFixFor,
	type OpenTriggerFix,
	type OpenTriggerFixesModalData,
	type OpenTriggerFixResult,
} from '@n8n/frontend-module-open-triggers';
import { useI18n } from '@n8n/i18n';

import { WORKFLOW_PUBLISH_MODAL_KEY } from '@/app/constants';
import { nodeViewEventBus } from '@/app/event-bus';
import { useUIStore } from '@/app/stores/ui.store';
import {
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { useCredentialsStore } from '@/features/credentials/credentials.store';
import { useWorkflowReviewsFeature } from '@/features/workflow-reviews/composables/useWorkflowReviewsFeature';
import { canvasEventBus } from '@/features/workflows/canvas/canvas.eventBus';

/** The `authentication` value of the node for each fix. */
const AUTHENTICATION: Record<OpenTriggerFix, string> = {
	signIn: 'n8nUserAuth',
	headerAuth: 'headerAuth',
	bearerAuth: 'bearerAuth',
};

const documentOf = (workflowId: string) =>
	useWorkflowDocumentStore(createWorkflowDocumentId(workflowId));

/** The fixes change the nodes on the canvas, so the workflow must be open there. */
function isOpenOnCanvas(workflowId: string): boolean {
	return !useUIStore().isReadOnlyView && useWorkflowsStore().workflowId === workflowId;
}

/**
 * Opens the modal of the fixes when the publish check stops open triggers of the workflow on the
 * canvas, and closes the publish modal: the fixed workflow must be saved before a new publish.
 * Returns false when there is nothing to show, so the caller shows its usual toast.
 */
function showFixes(workflowId: string, violations: PolicyViolation[]): boolean {
	const open = violations.filter((violation) => violation.kind === OPEN_TRIGGER_VIOLATION_KIND);
	if (open.length === 0 || !isOpenOnCanvas(workflowId)) return false;

	const document = documentOf(workflowId);
	const data: OpenTriggerFixesModalData = {
		workflowId,
		items: open.map((violation) => {
			const node = violation.subject ? document.getNodeById(violation.subject) : undefined;
			return {
				nodeId: violation.subject ?? '',
				nodeName: node?.name ?? violation.subject ?? '',
				message: violation.message,
				fix: node ? openTriggerFixFor(node) : null,
			};
		}),
		otherMessages: violations
			.filter((violation) => violation.kind !== OPEN_TRIGGER_VIOLATION_KIND)
			.map((violation) => violation.message),
		canRequestApproval: useWorkflowReviewsFeature().isWorkflowReviewsEnabled.value,
	};

	const uiStore = useUIStore();
	uiStore.closeModal(WORKFLOW_PUBLISH_MODAL_KEY);
	uiStore.openModalWithData({ name: OPEN_TRIGGER_FIXES_MODAL_KEY, data });
	return true;
}

/**
 * Applies a fix to a node on the canvas. A token fix creates a credential with a random token in
 * the project of the workflow, and gives the token back once. The workflow stays unsaved.
 */
async function applyFix(
	workflowId: string,
	nodeId: string,
	fix: OpenTriggerFix,
): Promise<OpenTriggerFixResult> {
	const document = documentOf(workflowId);
	const node = document.getNodeById(nodeId);
	if (!node) throw new Error(useI18n().baseText('openTriggers.fixes.nodeMissing'));

	let result: OpenTriggerFixResult = {};
	if (fix !== 'signIn') {
		const token = createTriggerToken();
		const credentialType = fix === 'headerAuth' ? 'httpHeaderAuth' : 'httpBearerAuth';
		const credential = await useCredentialsStore().createNewCredential(
			{
				id: '',
				name: useI18n().baseText('openTriggers.fixes.credentialName', {
					interpolate: { node: node.name, workflow: document.name },
				}),
				type: credentialType,
				data:
					fix === 'headerAuth' ? { name: 'Authorization', value: `Bearer ${token}` } : { token },
			},
			document.homeProject?.id,
		);
		document.updateNodeProperties({
			name: node.name,
			properties: {
				credentials: {
					...node.credentials,
					[credentialType]: { id: credential.id, name: credential.name },
				},
			},
		});
		result = { secret: { header: 'Authorization', value: `Bearer ${token}` } };
	}

	document.setNodeParameters(
		{ name: node.name, value: { authentication: AUTHENTICATION[fix] } },
		true,
	);
	return result;
}

/** Starts the publish again. The header saves the changed workflow first. */
function publish(): void {
	nodeViewEventBus.emit('publishWorkflow');
}

/** Opens the dialog of a workflow review. The header saves the changed workflow first. */
function requestApproval(): void {
	nodeViewEventBus.emit('submitWorkflowForReview');
}

function showNode(nodeId: string): void {
	canvasEventBus.emit('nodes:select', { ids: [nodeId], panIntoView: true });
}

export function useOpenTriggerFixes() {
	return { showFixes, applyFix, publish, requestApproval, showNode };
}
