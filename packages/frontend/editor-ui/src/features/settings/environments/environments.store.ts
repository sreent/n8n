/**
 * Fork code (not in upstream n8n): the store of the variables (`$vars`). It replaces the
 * enterprise store of the same name. See `FORK.md` in this folder.
 */
import { useRootStore } from '@n8n/stores/useRootStore';
import { resolveVariables } from 'n8n-workflow';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { useProjectsStore } from '@/features/collaboration/projects/projects.store';

import * as environmentsApi from './environments.api';
import type {
	CreateVariablePayload,
	EnvironmentVariable,
	UpdateVariablePayload,
} from './environments.types';

export const useEnvironmentsStore = defineStore('environments', () => {
	const rootStore = useRootStore();
	const projectsStore = useProjectsStore();

	const allVariables = ref<EnvironmentVariable[]>([]);

	/** The variables of a project, or the global variables when there is no project. */
	function getVariablesInScope(projectId?: string | null) {
		return allVariables.value.filter((variable) =>
			projectId ? variable.project?.id === projectId : !variable.project,
		);
	}

	const currentProjectId = computed(() => projectsStore.currentProject?.id);

	/** The global variables and the variables of the current project. */
	const scopedVariables = computed(() =>
		allVariables.value.filter(
			(variable) =>
				!variable.project ||
				(!!currentProjectId.value && variable.project.id === currentProjectId.value),
		),
	);

	/**
	 * The variables that the editor shows: with a current project, the global variables and the
	 * variables of that project; without one, all variables that the user may read.
	 */
	const variables = computed(() =>
		currentProjectId.value ? scopedVariables.value : allVariables.value,
	);

	/** The values of `$vars`: a variable of the current project wins over a global variable. */
	const variablesAsObject = computed(() =>
		resolveVariables(allVariables.value, currentProjectId.value),
	);

	/** The project of a variable as the list of projects knows it, with its name. */
	function knownProject(projectId?: string | null) {
		if (!projectId) return undefined;
		const project = projectsStore.availableProjects.find((item) => item.id === projectId);
		return project ? { id: project.id, name: project.name } : undefined;
	}

	async function fetchAllVariables() {
		const data = await environmentsApi.getVariables(rootStore.restApiContext);
		allVariables.value = data;
		return data;
	}

	async function createVariable(variable: CreateVariablePayload) {
		const data = await environmentsApi.createVariable(rootStore.restApiContext, variable);
		const project = knownProject(variable.projectId);
		if (project) data.project = project;
		allVariables.value.unshift(data);
		return data;
	}

	async function updateVariable(variable: UpdateVariablePayload) {
		const data = await environmentsApi.updateVariable(rootStore.restApiContext, variable);
		const project = knownProject(variable.projectId);
		if (project) data.project = project;
		allVariables.value = allVariables.value.map((item) => (item.id === data.id ? data : item));
		return data;
	}

	async function deleteVariable(
		variable: Pick<EnvironmentVariable, 'id'> & Partial<EnvironmentVariable>,
	) {
		const data = await environmentsApi.deleteVariable(rootStore.restApiContext, variable.id);
		allVariables.value = allVariables.value.filter((item) => item.id !== variable.id);
		return data;
	}

	return {
		variables,
		getVariablesInScope,
		scopedVariables,
		variablesAsObject,
		fetchAllVariables,
		createVariable,
		updateVariable,
		deleteVariable,
	};
});

export default useEnvironmentsStore;
