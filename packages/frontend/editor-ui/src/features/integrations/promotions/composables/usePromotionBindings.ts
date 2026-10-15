// Fork code (not in upstream n8n): the missing bindings of an apply. The dialog of the bindings
// lists the credentials and the variables that the workflows of the package need on this
// instance. A user creates each one with the ordinary credential editor or variable modal, in the
// destination scope of the binding. See `../FORK.md`.
import type {
	PromotionBindingConsumer,
	PromotionBindingProject,
	PromotionVariableScope,
} from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import { useI18n } from '@n8n/i18n';
import { getResourcePermissions } from '@n8n/permissions';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, ref, watch } from 'vue';

import { useUIStore } from '@/app/stores/ui.store';
import { createPublicProject } from '@/features/collaboration/projects/projects.api';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import type {
	Project,
	ResourceEditorDestination,
} from '@/features/collaboration/projects/projects.types';
import { createPublicCredential } from '@/features/credentials/credentials.api';
import { CREDENTIAL_EDIT_MODAL_KEY } from '@/features/credentials/credentials.constants';
import { useCredentialsStore } from '@/features/credentials/credentials.store';
import type { CredentialPayload } from '@/features/credentials/credentials.types';
import { VARIABLE_MODAL_KEY } from '@/features/settings/environments/environments.constants';
import { useEnvironmentsStore } from '@/features/settings/environments/environments.store';
import type {
	VariableBindingValues,
	VariableModalOptions,
} from '@/features/settings/environments/environments.types';

import type { BindingPreflight } from '../promotions.types';

type MissingBinding = BindingPreflight['missingBindings'][number];
type MissingCredential = Extract<MissingBinding, { kind: 'credential' }>;
type MissingVariable = Extract<MissingBinding, { kind: 'variable' }>;

export interface BindingItem {
	key: string;
	binding: MissingBinding;
	/** The name of the credential or the variable that the user created. */
	resolvedName?: string;
}

export interface BindingGroup {
	workflowId: string;
	workflowName: string;
	items: BindingItem[];
}

const keyOf = (binding: MissingBinding) =>
	binding.kind === 'credential'
		? `credential:${binding.sourceId}`
		: `variable:${binding.scope.kind === 'project' ? binding.scope.project.id : ''}:${binding.name}`;

/** The project of a binding, or `undefined` for a global variable. */
const projectOf = (binding: MissingBinding): PromotionBindingProject | undefined => {
	if (binding.kind === 'credential') return binding.ownerProject;
	return binding.scope.kind === 'project' ? binding.scope.project : undefined;
};

export function consumersText(consumers: PromotionBindingConsumer[], i18n = useI18n()) {
	return consumers.map((consumer) =>
		i18n.baseText('promotions.bindings.consumers', {
			interpolate: {
				project: consumer.project.name,
				workflows: consumer.workflows.map(({ name }) => name).join(', '),
			},
		}),
	);
}

export function usePromotionBindings(getPreflight: () => BindingPreflight | undefined) {
	const i18n = useI18n();
	const toast = useToast();
	const rootStore = useRootStore();
	const uiStore = useUIStore();
	const usersStore = useUsersStore();
	const settingsStore = useSettingsStore();
	const projectsStore = useProjectsStore();
	const credentialsStore = useCredentialsStore();
	const environmentsStore = useEnvironmentsStore();

	const items = ref<BindingItem[]>([]);
	/** The editor of a binding is open. */
	const busy = ref(false);
	/** The binding that the open editor creates, and the name of what it created. */
	let editing: { item: BindingItem; createdName?: string; modal: string } | undefined;

	watch(
		getPreflight,
		(preflight) => {
			for (const binding of preflight?.missingBindings ?? []) {
				const key = keyOf(binding);
				if (!items.value.some((item) => item.key === key)) items.value.push({ key, binding });
			}
		},
		{ immediate: true },
	);

	/** The bindings, by the workflows that use them. */
	const groups = computed<BindingGroup[]>(() => {
		const byWorkflow = new Map<string, BindingGroup>();
		for (const item of items.value) {
			for (const consumer of item.binding.consumers) {
				for (const workflow of consumer.workflows) {
					let group = byWorkflow.get(workflow.id);
					if (!group) {
						group = { workflowId: workflow.id, workflowName: workflow.name, items: [] };
						byWorkflow.set(workflow.id, group);
					}
					if (!group.items.includes(item)) group.items.push(item);
				}
			}
		}
		return [...byWorkflow.values()];
	});

	const unresolvedCount = computed(() => {
		const preflight = getPreflight();
		return (
			items.value.filter((item) => !item.resolvedName).length +
			(preflight?.accessRequirements.length ?? 0) +
			(preflight?.conflicts.length ?? 0)
		);
	});

	const hasSavedResources = computed(() => items.value.some((item) => !!item.resolvedName));

	function scopeLabel(binding: MissingBinding) {
		return projectOf(binding)?.name ?? i18n.baseText('promotions.bindings.global');
	}

	/** The destination project of a binding. A project that is not on this instance yet is pending. */
	async function destinationOf(
		project: PromotionBindingProject,
	): Promise<ResourceEditorDestination> {
		let found: Project | undefined;
		try {
			found = await projectsStore.fetchProject(project.id);
		} catch {
			found = undefined;
		}
		await projectsStore.getMyProjects();
		if (found) return { kind: 'resolved', project: found };
		return {
			kind: 'pending',
			id: project.id,
			name: project.name,
			permissions: { create: projectsStore.hasPermissionToCreateProjects },
		};
	}

	/** The project of a pending destination exists before the item is saved. */
	async function ensureProject(destination: ResourceEditorDestination) {
		if (destination.kind === 'resolved') return;
		const missing = getPreflight()?.missingProjects.find(({ id }) => id === destination.id);
		await createPublicProject(rootStore.publicApiContext, {
			id: destination.id,
			name: destination.name,
			...(missing?.icon ? { icon: missing.icon } : {}),
			...(missing?.description !== undefined ? { description: missing.description } : {}),
		});
	}

	function canCreateIn(
		destination: ResourceEditorDestination,
		resource: 'credential' | 'projectVariable',
	) {
		if (destination.kind === 'pending') return destination.permissions.create;
		const project = projectsStore.myProjects.find(({ id }) => id === destination.project.id);
		return (
			getResourcePermissions(project?.scopes ?? destination.project.scopes)[resource].create ===
			true
		);
	}

	function finishEditing() {
		const current = editing;
		editing = undefined;
		busy.value = false;
		if (current?.createdName) current.item.resolvedName = current.createdName;
	}

	watch(
		() =>
			uiStore.modalsById[CREDENTIAL_EDIT_MODAL_KEY]?.open === true ||
			uiStore.modalsById[VARIABLE_MODAL_KEY]?.open === true,
		(open, wasOpen) => {
			if (editing && wasOpen && !open) finishEditing();
		},
	);

	function fail(error: unknown, title: string) {
		busy.value = false;
		editing = undefined;
		toast.showError(error, title);
	}

	async function createCredential(item: BindingItem, binding: MissingCredential) {
		const destination = await destinationOf(binding.ownerProject);
		if (!canCreateIn(destination, 'credential')) {
			throw new Error(i18n.baseText('promotions.bindings.destinationDenied'));
		}
		await credentialsStore.fetchCredentialTypes(false);
		const current = { item, modal: CREDENTIAL_EDIT_MODAL_KEY } as NonNullable<typeof editing>;
		editing = current;
		uiStore.openNewCredential(
			binding.credentialType,
			false,
			true,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				hideAskAssistant: true,
				appendToBody: true,
				closeOnSave: false,
				usageScope: 'project',
				initialName: binding.name,
				destination,
				createCredential: async (details: CredentialPayload, projectId: string) => {
					if (details.type !== binding.credentialType) {
						throw new Error(i18n.baseText('promotions.bindings.error.creationMismatch'));
					}
					const target = await destinationOf(binding.ownerProject);
					await ensureProject(target);
					const created = await createPublicCredential(rootStore.publicApiContext, {
						id: binding.sourceId,
						name: details.name,
						type: details.type,
						data: details.data ?? {},
						projectId,
						description: details.description,
						isResolvable: details.isResolvable ?? false,
					});
					current.createdName = created.name;
					return created.id;
				},
				onInitializeError: (error: unknown) => {
					uiStore.closeModal(CREDENTIAL_EDIT_MODAL_KEY);
					fail(error, i18n.baseText('promotions.bindings.error.setup'));
				},
			},
		);
	}

	async function createVariable(item: BindingItem, binding: MissingVariable) {
		if (!settingsStore.isEnterpriseFeatureEnabled.variables) {
			throw new Error(i18n.baseText('promotions.bindings.variablesUnavailable'));
		}
		const project = projectOf(binding);
		const destination = project ? await destinationOf(project) : undefined;
		if (destination && !canCreateIn(destination, 'projectVariable')) {
			throw new Error(i18n.baseText('promotions.bindings.destinationDenied'));
		}
		if (
			!destination &&
			getResourcePermissions(usersStore.currentUser?.globalScopes).variable.create !== true
		) {
			throw new Error(i18n.baseText('promotions.bindings.destinationDenied'));
		}
		await environmentsStore.fetchAllVariables();
		const current = { item, modal: VARIABLE_MODAL_KEY } as NonNullable<typeof editing>;
		editing = current;
		const data: VariableModalOptions = {
			mode: 'new',
			projectId: project?.id ?? null,
			fixedKey: true,
			initialValues: { key: binding.name, value: '' },
			appendToBody: true,
			...(destination ? { destination } : {}),
			onCreate: async (values: VariableBindingValues) => {
				if (destination) {
					const target = await destinationOf(project ?? { id: values.projectId ?? '', name: '' });
					await ensureProject(target);
				}
				const created = await environmentsStore.createVariable({
					key: values.key,
					value: values.value,
					projectId: values.projectId ?? undefined,
				});
				current.createdName = created.key;
				return project ? { ...created, project: { id: project.id, name: project.name } } : created;
			},
		};
		uiStore.openModalWithData({ name: VARIABLE_MODAL_KEY, data });
	}

	/** Opens the editor of a binding, in the destination scope of the binding. */
	async function create(item: BindingItem) {
		if (busy.value) return;
		busy.value = true;
		try {
			if (item.binding.kind === 'credential') await createCredential(item, item.binding);
			else await createVariable(item, item.binding);
		} catch (error) {
			fail(error, i18n.baseText('promotions.bindings.error.setup'));
		}
	}

	return { items, groups, busy, unresolvedCount, hasSavedResources, scopeLabel, create };
}

export type { MissingBinding, PromotionVariableScope };
