/** Maximum number of recipients in one send request. */
export const SEND_COPY_MAX_RECIPIENTS = 20;

/** Number of recipient candidates that the recipients endpoint returns by default. */
export const SEND_COPY_RECIPIENTS_DEFAULT_LIMIT = 20;

/** Maximum number of recipient candidates that one recipients request can return. */
export const SEND_COPY_RECIPIENTS_MAX_LIMIT = 50;

/** Maximum length of the recipient search text. */
export const SEND_COPY_SEARCH_MAX_LENGTH = 100;

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
