/**
 * Fork code (not in upstream n8n): the completions of `$vars` in the Code node. They offer the
 * global variables and the variables of the current project. See `../FORK.md`.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';

import { matchBeforeCursor } from '@/features/shared/editors/components/CodeNodeEditor/completions/utils';

import { useEnvironmentsStore } from '../environments.store';

const escape = (text: string) => text.replace('$', '\\$');

/** Marks a completion as a variable. */
export function addVarType(option: Completion): Completion {
	return { ...option, type: 'variable' };
}

export function useVariablesCompletions() {
	const environmentsStore = useEnvironmentsStore();

	/** Completes `$vars.` to the keys of the variables, with their values as info. */
	const variablesCompletions = (
		context: CompletionContext,
		matcher = '$vars',
	): CompletionResult | null => {
		const preCursor = matchBeforeCursor(context, new RegExp(`${escape(matcher)}\\..*`));
		if (!preCursor) return null;

		return {
			from: preCursor.from,
			options: environmentsStore.scopedVariables.map((variable) =>
				addVarType({ label: `${matcher}.${variable.key}`, info: variable.value }),
			),
		};
	};

	return { variablesCompletions };
}
