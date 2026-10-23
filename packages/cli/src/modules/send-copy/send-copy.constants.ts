/** Length of the `workflow_entity.name` column. */
export const WORKFLOW_NAME_MAX_LENGTH = 128;

/**
 * Workflow settings that point to resources of the sender.
 * The recipient cannot use these resources, so the copy does not keep these settings.
 */
export const SENDER_BOUND_SETTINGS = [
	'errorWorkflow',
	'callerIds',
	'callerPolicy',
	'credentialResolverId',
	'availableInMCP',
] as const;

/** Value for `uiContext` on the `workflow-created` event of a copy. */
export const SEND_COPY_UI_CONTEXT = 'send-copy';
