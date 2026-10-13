/**
 * Fork code (not in upstream n8n): the types of the variables (`$vars`) in the editor. See
 * `FORK.md` in this folder.
 */

/** A variable as the REST API gives it. A variable without a project is global. */
export interface EnvironmentVariable {
	id: string;
	key: string;
	value: string;
	type?: string;
	project?: { id: string; name: string | null } | null;
}

/** The data of the variable modal: a new variable, optionally in a project, or a variable to edit. */
export interface VariableModalOptions {
	mode: 'new' | 'edit';
	variable?: EnvironmentVariable;
	projectId?: string;
}

/** The fields that the modal sends for a new variable. */
export interface CreateVariablePayload {
	key: string;
	value: string;
	projectId?: string;
}

/** The fields that the modal sends to change a variable. */
export interface UpdateVariablePayload {
	id: string;
	key?: string;
	value?: string;
	projectId?: string | null;
}
