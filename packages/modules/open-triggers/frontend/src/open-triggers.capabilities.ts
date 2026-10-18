import { declareCapability } from '@n8n/frontend-module-sdk';

import type { OpenTriggerFix, OpenTriggerFixResult } from './open-triggers.fixes';

/**
 * Closes a modal in the shell modal registry. The shell provides it in
 * `capabilities.manifest.ts`, because a module cannot reach `ui.store`.
 */
export const openTriggersModalCloser = declareCapability<(modalKey: string) => void>(
	'open-triggers-modal-closer',
);

/** The actions of the modal on the workflow that is open on the canvas. */
export interface OpenTriggerActions {
	/**
	 * Changes the node on the canvas, and creates the credential of the fix in the project of the
	 * workflow. The workflow is not saved: the next publish or review saves it.
	 */
	applyFix: (
		workflowId: string,
		nodeId: string,
		fix: OpenTriggerFix,
	) => Promise<OpenTriggerFixResult>;
	/** Starts the publish again. */
	publish: (workflowId: string) => void;
	/** Opens the dialog of a workflow review for the saved version. */
	requestApproval: (workflowId: string) => void;
	/** Selects the node on the canvas. */
	showNode: (workflowId: string, nodeId: string) => void;
}

/** The shell provides the actions in `capabilities.manifest.ts`. */
export const openTriggerActions = declareCapability<OpenTriggerActions>('open-trigger-actions');
