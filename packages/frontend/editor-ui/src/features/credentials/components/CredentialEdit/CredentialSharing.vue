<script setup lang="ts">
// Fork component (not in upstream n8n): the sharing tab of the credential modal, in place of the
// enterprise `CredentialSharing.ee.vue`. packages/frontend/editor-ui/FORK.md describes it.
import type { ResolvedDependency } from '@n8n/api-types';
import { N8nButton, N8nEmptyState, N8nText, N8nTooltip } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { getResourcePermissions, type PermissionsRecord } from '@n8n/permissions';
import { useRolesStore } from '@n8n/stores/roles.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';
import type { EventBus } from '@n8n/utils/event-bus';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';
import { computed, onMounted, ref } from 'vue';

import { useDependencies } from '@/app/composables/useDependencies';
import { usePageRedirectionHelper } from '@/app/composables/usePageRedirectionHelper';
import { EnterpriseEditionFeature } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';
import ProjectSharing from '@/features/collaboration/projects/components/ProjectSharing.vue';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import {
	ProjectTypes,
	type ProjectListItem,
	type ProjectSharingData,
} from '@/features/collaboration/projects/projects.types';
import {
	splitName,
	useRemoteProjectSearch,
} from '@/features/collaboration/projects/projects.utils';

import type { ICredentialsDecryptedResponse, ICredentialsResponse } from '../../credentials.types';

const props = defineProps<{
	credential: ICredentialsResponse | ICredentialsDecryptedResponse | null;
	credentialData: ICredentialDataDecryptedObject;
	credentialId: string;
	credentialPermissions: PermissionsRecord['credential'];
	isSharedGlobally?: boolean;
	modalBus: EventBus;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: ProjectSharingData[]];
	'update:shareWithAllUsers': [value: boolean];
}>();

const i18n = useI18n();
const settingsStore = useSettingsStore();
const usersStore = useUsersStore();
const rolesStore = useRolesStore();
const projectsStore = useProjectsStore();
const uiStore = useUIStore();
const pageRedirectionHelper = usePageRedirectionHelper();
const searchProjects = useRemoteProjectSearch();
/** The workflows that use each resource. It keeps the last result of each one for the session. */
const { fetchDependencies, getDependencies } = useDependencies();

const sharedWithProjects = ref<ProjectSharingData[]>([
	...(props.credential?.sharedWithProjects ?? []),
]);

const isSharingEnabled = computed(
	() => settingsStore.isEnterpriseFeatureEnabled[EnterpriseEditionFeature.Sharing],
);
const homeProject = computed(() => props.credential?.homeProject);
const canShare = computed(() => props.credentialPermissions.share === true);
const globalCredentialPermissions = computed(
	() => getResourcePermissions(usersStore.currentUser?.globalScopes).credential,
);
/** Sharing with all users needs the global scope of the user, not a scope of the credential. */
const canShareGlobally = computed(() => globalCredentialPermissions.value.shareGlobally === true);
/** The owner and admins can use every credential, so their personal space needs no share. */
const canUseEveryCredential = computed(() => globalCredentialPermissions.value.use === true);
const isOwnCredential = computed(
	() => !!homeProject.value && homeProject.value.id === projectsStore.personalProject?.id,
);
/** A user without the share scope in their own personal space: sharing is off there. */
const isPersonalSpaceRestricted = computed(() => !canShare.value && isOwnCredential.value);

const infoText = computed(() => {
	if (canShare.value || isPersonalSpaceRestricted.value) {
		return i18n.baseText('credentialEdit.credentialSharing.info.owner');
	}
	if (homeProject.value?.type === ProjectTypes.Team) {
		return i18n.baseText('credentialEdit.credentialSharing.info.sharee.team');
	}
	const { name } = splitName(homeProject.value?.name ?? '');
	return i18n.baseText('credentialEdit.credentialSharing.info.sharee.personal', {
		interpolate: {
			credentialOwnerName:
				name ?? i18n.baseText('credentialEdit.credentialSharing.info.sharee.fallback'),
		},
	});
});

/** The credential roles that a share can have, with the names of the credential modal. */
const roles = computed(() => {
	const names: Record<string, string> = {
		'credential:user': i18n.baseText('credentialEdit.credentialSharing.role.user.canUse'),
	};
	return rolesStore.processedCredentialRoles.map((role) => ({
		...role,
		displayName: names[role.slug],
	}));
});

const roleDescriptions = computed(() => ({
	'credential:user': i18n.baseText('credentialEdit.credentialSharing.role.user.canUse.description'),
}));

function projectName(project: ProjectSharingData) {
	const { name, email } = splitName(project.name ?? '');
	return name ?? email ?? '';
}

function confirmRemoval(project: ProjectSharingData) {
	return {
		title: i18n.baseText('credentialEdit.credentialSharing.unshare.confirm.title'),
		message: i18n.baseText('credentialEdit.credentialSharing.unshare.confirm.message', {
			interpolate: { name: projectName(project) },
		}),
		confirmButtonText: i18n.baseText(
			'credentialEdit.credentialSharing.unshare.confirm.confirmButtonText',
		),
		cancelButtonText: i18n.baseText(
			'credentialEdit.credentialSharing.unshare.confirm.cancelButtonText',
		),
	};
}

/**
 * The projects of the user that have workflows that use the credential, but no share of it.
 * The sharing list shows each one with a subtitle, and each one can get a share with one click.
 */
const unsharedProjects = computed(() => {
	const usage = getDependencies(props.credentialId, 'credential')?.dependencies ?? [];
	const workflowsByProject = new Map<string, ResolvedDependency[]>();
	for (const dependency of usage) {
		if (!dependency.projectId) continue;
		const workflows = workflowsByProject.get(dependency.projectId) ?? [];
		workflows.push(dependency);
		workflowsByProject.set(dependency.projectId, workflows);
	}
	return [...workflowsByProject.entries()].flatMap(([projectId, workflows]) => {
		const project = projectsStore.myProjects.find(({ id }) => id === projectId);
		if (
			!project ||
			project.id === homeProject.value?.id ||
			sharedWithProjects.value.some(({ id }) => id === project.id)
		) {
			return [];
		}
		const subtitle =
			workflows.length === 1
				? i18n.baseText('credentialEdit.credentialSharing.usedIn', {
						interpolate: { workflowName: workflows[0].name },
					})
				: i18n.baseText('credentialEdit.credentialSharing.usedIn.count', {
						interpolate: { count: String(workflows.length) },
					});
		return [{ project, subtitle }];
	});
});

/** The own personal space of a user who can use every credential: a share adds team projects only. */
const usesInPersonalSpace = (project: ProjectSharingData) =>
	project.type === ProjectTypes.Personal && canUseEveryCredential.value;

/** The select offers every project except the one that owns the credential. */
const filterProject = (project: ProjectListItem) => project.id !== homeProject.value?.id;

/** `ProjectSharing` gives a list here: the tab passes a list of projects as its model. */
function onModelUpdate(projects: ProjectSharingData | ProjectSharingData[] | null) {
	if (!Array.isArray(projects)) return;
	sharedWithProjects.value = projects;
	emit('update:modelValue', projects);
}

function shareWithProject(project: ProjectSharingData) {
	onModelUpdate([...sharedWithProjects.value, project]);
}

async function goToUpgrade() {
	await pageRedirectionHelper.goToUpgrade('credential_sharing', 'upgrade-credentials-sharing');
}

onMounted(async () => {
	await fetchDependencies([props.credentialId], 'credential');
});
</script>

<template>
	<div :class="$style.container">
		<N8nEmptyState
			v-if="!isSharingEnabled"
			:heading="
				i18n.baseText(uiStore.contextBasedTranslationKeys.credentials.sharing.unavailable.title)
			"
			:description="
				i18n.baseText(
					uiStore.contextBasedTranslationKeys.credentials.sharing.unavailable.description,
				)
			"
			:button-text="
				i18n.baseText(uiStore.contextBasedTranslationKeys.credentials.sharing.unavailable.button)
			"
			@click:button="goToUpgrade"
		/>
		<div v-else :class="$style.content">
			<N8nText tag="p" :class="$style.info">{{ infoText }}</N8nText>
			<ProjectSharing
				:model-value="sharedWithProjects"
				:home-project="homeProject"
				:roles="roles"
				:role-descriptions="roleDescriptions"
				:confirm-removal="confirmRemoval"
				:search-fn="searchProjects"
				:filter-fn="filterProject"
				:readonly="!canShare"
				:static="!canShare"
				:placeholder="i18n.baseText('projects.sharing.select.placeholder.project')"
				:can-share-globally="canShareGlobally"
				:is-shared-globally="isSharedGlobally"
				:disabled-tooltip="
					isPersonalSpaceRestricted
						? i18n.baseText('credentialEdit.credentialSharing.info.personalSpaceRestricted')
						: undefined
				"
				:teleported="false"
				:show-suffix="true"
				sort-selected
				:unshared-projects="unsharedProjects"
				@update:model-value="onModelUpdate"
				@update:share-with-all-users="emit('update:shareWithAllUsers', $event)"
			>
				<template #unshared-actions="{ project }">
					<span :class="$style.unsharedActions">
						<N8nTooltip
							v-if="usesInPersonalSpace(project)"
							:content="
								i18n.baseText('credentialEdit.credentialSharing.usedIn.personalSpace.tooltip', {
									interpolate: { name: projectName(project) },
								})
							"
							placement="top"
						>
							<N8nText
								size="small"
								color="text-light"
								data-test-id="credential-used-in-personal-space"
							>
								{{ i18n.baseText('credentialEdit.credentialSharing.usedIn.personalSpace') }}
							</N8nText>
						</N8nTooltip>
						<N8nTooltip
							v-else
							:content="i18n.baseText('credentialEdit.credentialSharing.canView.tooltip')"
							placement="top"
						>
							<N8nText size="small" color="text-light" data-test-id="credential-used-in-can-view">
								{{ i18n.baseText('credentialEdit.credentialSharing.canView') }}
							</N8nText>
						</N8nTooltip>
						<N8nTooltip
							:content="
								usesInPersonalSpace(project)
									? i18n.baseText('credentialEdit.credentialSharing.share.teamProjects.tooltip', {
											interpolate: { name: projectName(project) },
										})
									: i18n.baseText('credentialEdit.credentialSharing.share.tooltip', {
											interpolate: { project: projectName(project) },
										})
							"
							placement="top"
						>
							<N8nButton
								variant="outline"
								size="small"
								:disabled="!canShare"
								data-test-id="credential-used-in-project-share"
								@click="shareWithProject(project)"
							>
								{{ i18n.baseText('credentialEdit.credentialSharing.share') }}
							</N8nButton>
						</N8nTooltip>
					</span>
				</template>
			</ProjectSharing>
		</div>
	</div>
</template>

<style lang="scss" module>
.container {
	width: 100%;
}

.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.info {
	margin: 0;
}

.unsharedActions {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}
</style>
