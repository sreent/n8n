/**
 * Fork code (not in upstream n8n): the types of the variables (`$vars`) in the editor. See
 * `FORK.md` in this folder.
 */

import type { ResourceEditorDestination } from '@/features/collaboration/projects/projects.types';

/** A variable as the REST API gives it. A variable without a project is global. */
export interface EnvironmentVariable {
	id: string;
	key: string;
	value: string;
	type?: string;
	project?: { id: string; name: string | null } | null;
}

/** The data of the variable modal: a new variable, optionally in a project, or a variable to edit. */
export type VariableModalOptions = {
	mode: 'new' | 'edit';
	variable?: EnvironmentVariable;
	/** The project of a new variable. `null` is a global variable. */
	projectId?: string | null;
	/** The key cannot change. */
	fixedKey?: boolean;
	initialValues?: { key?: string; value?: string };
	/** The project that the new variable goes to. */
	destination?: ResourceEditorDestination;
	/** Creates the variable in place of the store, for example for a binding of Git connections. */
	onCreate?: (values: VariableBindingValues) => Promise<unknown>;
	appendToBody?: boolean;
};

/** The fields of a new variable that the modal gives to `onCreate`. */
export interface VariableBindingValues {
	key: string;
	value: string;
	projectId: string | null;
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
