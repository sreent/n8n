<script setup lang="ts">
// Fork component (not in upstream n8n): the modal that shares a workflow with users, in place of
// the enterprise `WorkflowShareModal.ee.vue`. packages/frontend/editor-ui/FORK.md describes it.
import { useToast } from '@n8n/composables/useToast';
import { N8nButton, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { getResourcePermissions } from '@n8n/permissions';
import { useRolesStore } from '@n8n/stores/roles.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { createEventBus } from '@n8n/utils/event-bus';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import Modal from '@/app/components/Modal.vue';
// The editor's path of `useMessage`, as the original modal uses: component tests mock this path.
import { useMessage } from '@/app/composables/useMessage';
import { usePageRedirectionHelper } from '@/app/composables/usePageRedirectionHelper';
import { useWorkflowSaving } from '@/app/composables/useWorkflowSaving';
import { EnterpriseEditionFeature, MODAL_CONFIRM, WORKFLOW_SHARE_MODAL_KEY } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';
import {
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';
import { useWorkflowsEEStore } from '@/app/stores/workflowSharing.store';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { useWorkflowsListStore } from '@/app/stores/workflowsList.store';
import ProjectSharing from '@/features/collaboration/projects/components/ProjectSharing.vue';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import {
	ProjectTypes,
	type Project,
	type ProjectListItem,
	type ProjectSharingData,
} from '@/features/collaboration/projects/projects.types';
import { useRemoteProjectSearch } from '@/features/collaboration/projects/projects.utils';

const props = defineProps<{
	/** `ModalRoot` passes it. The modal uses its own key. */
	modalName: string;
	isActive?: boolean;
	data: { id: string };
}>();

const i18n = useI18n();
const toast = useToast();
const message = useMessage();
const route = useRoute();
const router = useRouter();
const settingsStore = useSettingsStore();
const rolesStore = useRolesStore();
const uiStore = useUIStore();
const projectsStore = useProjectsStore();
const workflowsStore = useWorkflowsStore();
const workflowsListStore = useWorkflowsListStore();
const workflowsEEStore = useWorkflowsEEStore();
const workflowSaving = useWorkflowSaving({ router });
const pageRedirectionHelper = usePageRedirectionHelper();
const searchProjects = useRemoteProjectSearch({ type: ProjectTypes.Personal });

const modalBus = createEventBus();
const isDirty = ref(false);
const isSaving = ref(false);
/** True while the first load runs. It stays true when the load fails: the modal cannot save then. */
const isLoading = ref(false);
/** The first load. A save waits for it. */
let loaded: Promise<void> = Promise.resolve();
const teamProject = ref<Project | null>(null);

const isSharingEnabled = computed(
	() => settingsStore.isEnterpriseFeatureEnabled[EnterpriseEditionFeature.Sharing],
);

/**
 * The workflow list has the saved workflows, and the first load refreshes the workflow there. The
 * editor document has the workflow when the editor opened it. The owner project and the scopes
 * come from the list first, the shares from the editor document first.
 */
const workflowDocumentStore = useWorkflowDocumentStore(createWorkflowDocumentId(props.data.id));
const listedWorkflow = computed(() => workflowsListStore.workflowsById[props.data.id]);
/** A workflow that is not saved yet is new: a save saves the workflow first. */
const isNewWorkflow = computed(() => !workflowsStore.isWorkflowSaved[props.data.id]);

const sharedWithProjects = ref<ProjectSharingData[]>([
	...(workflowDocumentStore.sharedWithProjects ?? listedWorkflow.value?.sharedWithProjects ?? []),
]);

const workflowPermissions = computed(
	() =>
		getResourcePermissions(listedWorkflow.value?.scopes ?? workflowDocumentStore.scopes).workflow,
);
const homeProject = computed(
	() => listedWorkflow.value?.homeProject ?? workflowDocumentStore.homeProject ?? undefined,
);
const isHomeTeamProject = computed(() => homeProject.value?.type === ProjectTypes.Team);
/** A user without the share scope in their own personal space: sharing is off there. */
const isPersonalSpaceRestricted = computed(
	() =>
		!workflowPermissions.value.share &&
		!!homeProject.value &&
		homeProject.value.id === projectsStore.personalProject?.id,
);
const showShareeInfo = computed(
	() =>
		!workflowPermissions.value.share &&
		!isHomeTeamProject.value &&
		!isPersonalSpaceRestricted.value,
);
/** Who can change the shares: the owner, from the workflow list. */
const shareeInfo = computed(() =>
	i18n.baseText('workflows.shareModal.info.sharee', {
		interpolate: { workflowOwnerName: workflowsEEStore.getWorkflowOwnerName(props.data.id) },
	}),
);

const modalTitle = computed(() => {
	if (isHomeTeamProject.value) {
		return i18n.baseText('workflows.shareModal.title.static', {
			interpolate: { projectName: homeProject.value?.name ?? '' },
		});
	}
	return i18n.baseText(
		isSharingEnabled.value
			? uiStore.contextBasedTranslationKeys.workflows.sharing.title
			: uiStore.contextBasedTranslationKeys.workflows.sharing.unavailable.title,
	);
});

const membersText = computed(() => {
	const count = teamProject.value?.relations.length ?? 0;
	return i18n.baseText('workflows.shareModal.info.members', {
		interpolate: {
			projectName: homeProject.value?.name ?? '',
			members: i18n.baseText('workflows.shareModal.info.members.number', {
				adjustToNumber: count,
				interpolate: { number: String(count) },
			}),
		},
	});
});

/** The workflow roles that a share can have. The editor role has the name of the modal. */
const roles = computed(() =>
	rolesStore.processedWorkflowRoles.map((role) =>
		role.slug === 'workflow:editor'
			? { ...role, displayName: i18n.baseText('workflows.shareModal.role.editor') }
			: role,
	),
);

/** The select offers personal projects only, not the project that owns the workflow. */
const filterProject = (project: ProjectListItem) =>
	project.type === ProjectTypes.Personal && project.id !== homeProject.value?.id;

function onChanged() {
	isDirty.value = true;
}

/**
 * Save the shares, and a new workflow before them. Gives whether the save worked. The save waits
 * for the first load, and fails with its error when the load failed.
 */
async function save() {
	await loaded;
	isSaving.value = true;
	try {
		let workflowId = props.data.id;
		if (isNewWorkflow.value) {
			// A new workflow in a folder has the folder in the route.
			const folderId = route.query.folderId;
			const savedId = await workflowSaving.saveAsNewWorkflow({
				parentFolderId: typeof folderId === 'string' ? folderId : undefined,
			});
			if (!savedId) throw new Error(i18n.baseText('workflows.shareModal.onSave.error.title'));
			workflowId = savedId;
		}
		await workflowsEEStore.saveWorkflowSharedWith({
			workflowId,
			sharedWithProjects: sharedWithProjects.value,
		});
		useWorkflowDocumentStore(createWorkflowDocumentId(workflowId)).setSharedWithProjects(
			sharedWithProjects.value,
		);
		toast.showMessage({ title: i18n.baseText('workflows.shareModal.onSave.success.title') });
		isDirty.value = false;
		return true;
	} catch (error) {
		toast.showError(error, i18n.baseText('workflows.shareModal.onSave.error.title'));
		return false;
	} finally {
		isSaving.value = false;
	}
}

/** Save, then close. A click while the modal loads or saves does nothing. */
async function onSave() {
	if (isLoading.value || isSaving.value) return;
	if (await save()) modalBus.emit('close');
}

/**
 * Ask to save unsaved changes. After a save, the modal closes itself and gives `false`, so that
 * `Modal` does not close it again. It stays open when the save fails.
 */
async function onBeforeClose() {
	if (!isDirty.value) return true;
	const answer = await message.confirm(
		i18n.baseText('workflows.shareModal.saveBeforeClose.message'),
		i18n.baseText('workflows.shareModal.saveBeforeClose.title'),
		{
			type: 'warning',
			confirmButtonText: i18n.baseText('workflows.shareModal.saveBeforeClose.confirmButtonText'),
			cancelButtonText: i18n.baseText('workflows.shareModal.saveBeforeClose.cancelButtonText'),
		},
	);
	if (answer !== MODAL_CONFIRM) return true;
	if (await save()) uiStore.closeModal(WORKFLOW_SHARE_MODAL_KEY);
	return false;
}

function onClose() {
	modalBus.emit('close');
}

async function goToUpgrade() {
	await pageRedirectionHelper.goToUpgrade('workflow_sharing', 'upgrade-workflow-sharing');
}

/**
 * Refresh a saved workflow in the workflow list, then load the members of a team project that
 * owns the workflow. The projects in the select stay as they were when the modal opened.
 */
async function load() {
	if (!isNewWorkflow.value) {
		await workflowsListStore.fetchWorkflow(props.data.id);
	}
	if (homeProject.value && isHomeTeamProject.value) {
		teamProject.value = await projectsStore.fetchProject(homeProject.value.id);
	}
}

onMounted(async () => {
	if (!isSharingEnabled.value) return;
	isLoading.value = true;
	loaded = load();
	await loaded;
	isLoading.value = false;
});
</script>

<template>
	<Modal
		width="460px"
		max-height="75%"
		:name="WORKFLOW_SHARE_MODAL_KEY"
		:title="modalTitle"
		:event-bus="modalBus"
		:before-close="onBeforeClose"
	>
		<template #content>
			<div v-if="!isSharingEnabled" :class="$style.content">
				<N8nText>
					{{
						i18n.baseText(
							uiStore.contextBasedTranslationKeys.workflows.sharing.unavailable.description.modal,
						)
					}}
				</N8nText>
			</div>
			<div v-else :class="$style.content">
				<N8nText v-if="showShareeInfo" tag="p" :class="$style.info">
					{{ shareeInfo }}
				</N8nText>
				<ProjectSharing
					v-if="homeProject"
					v-model="sharedWithProjects"
					:home-project="homeProject"
					:roles="roles"
					:search-fn="searchProjects"
					:filter-fn="filterProject"
					:readonly="!workflowPermissions.share"
					:static="isHomeTeamProject || !workflowPermissions.share"
					:placeholder="i18n.baseText('workflows.shareModal.select.placeholder')"
					:empty-options-text="i18n.baseText('workflows.shareModel.select.notFound')"
					:disabled-tooltip="
						isPersonalSpaceRestricted
							? i18n.baseText('workflows.shareModal.info.personalSpaceRestricted')
							: undefined
					"
					@project-added="onChanged"
					@project-removed="onChanged"
				/>
				<N8nText v-if="isHomeTeamProject" tag="p" :class="$style.info">
					{{ membersText }}
				</N8nText>
			</div>
		</template>
		<template #footer>
			<div v-if="!isSharingEnabled" :class="$style.footer">
				<N8nButton @click="goToUpgrade">
					{{
						i18n.baseText(uiStore.contextBasedTranslationKeys.workflows.sharing.unavailable.button)
					}}
				</N8nButton>
			</div>
			<div v-else :class="$style.footer">
				<N8nText v-show="isDirty" color="text-light" size="small">
					{{ i18n.baseText('workflows.shareModal.changesHint') }}
				</N8nText>
				<N8nButton v-if="isHomeTeamProject" @click="onClose">
					{{ i18n.baseText('generic.close') }}
				</N8nButton>
				<N8nButton
					v-else
					v-show="workflowPermissions.share"
					:disabled="!isDirty"
					:loading="isLoading || isSaving"
					data-test-id="workflow-sharing-modal-save-button"
					@click="onSave"
				>
					{{ i18n.baseText('workflows.shareModal.save') }}
				</N8nButton>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.info {
	margin: 0;
}

.footer {
	display: flex;
	justify-content: flex-end;
	align-items: center;
	gap: var(--spacing--sm);
}
</style>
