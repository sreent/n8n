<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the modal that creates or edits a variable. A new variable is
 * global or belongs to a project: the project of the page, or the scope that the user chooses.
 * It replaces the enterprise component of the same name. See `../FORK.md`.
 */
import { useToast } from '@n8n/composables/useToast';
import {
	N8nButton,
	N8nFormInput,
	N8nIcon,
	N8nInputLabel,
	N8nOption,
	N8nSelect,
	N8nText,
	type IconOrEmoji,
	type Rule,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { getResourcePermissions } from '@n8n/permissions';
import { useUsersStore } from '@n8n/stores/users.store';
import { createEventBus } from '@n8n/utils/event-bus';
import { computed, nextTick, onMounted, ref } from 'vue';

import Modal from '@/app/components/Modal.vue';
import { useUIStore } from '@/app/stores/ui.store';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import { ProjectTypes } from '@/features/collaboration/projects/projects.types';

import { VARIABLE_MODAL_KEY } from '../environments.constants';
import { useEnvironmentsStore } from '../environments.store';
import type { EnvironmentVariable } from '../environments.types';

const props = defineProps<{
	mode: 'new' | 'edit';
	variable?: EnvironmentVariable;
	projectId?: string;
}>();

const KEY_MAX_LENGTH = 50;
const VALUE_MAX_LENGTH = 1000;
const GLOBAL_SCOPE = 'global';
const DEFAULT_SCOPE_ICON: IconOrEmoji = { type: 'icon', value: 'database' };

const i18n = useI18n();
const { showError } = useToast();
const uiStore = useUIStore();
const usersStore = useUsersStore();
const projectsStore = useProjectsStore();
const environmentsStore = useEnvironmentsStore();
const modalBus = createEventBus();

const key = ref(props.variable?.key ?? '');
const value = ref(props.variable?.value ?? '');
const chosenScope = ref<string>();
const isKeyValid = ref(false);
const isValueValid = ref(true);
const isSaving = ref(false);
const keyInput = ref<{ inputRef?: { focus?: () => void } | null } | null>(null);

const isEdit = computed(() => props.mode === 'edit');
const title = computed(() =>
	i18n.baseText(isEdit.value ? 'variables.modal.title.edit' : 'variables.modal.title.create'),
);
/** The user chooses the scope only for a new variable outside of a project page. */
const showScope = computed(() => !isEdit.value && !props.projectId);

/** The project of the variable, or `undefined` for a global variable. */
const projectId = computed(() => {
	if (isEdit.value) return props.variable?.project?.id;
	if (props.projectId) return props.projectId;
	return chosenScope.value && chosenScope.value !== GLOBAL_SCOPE ? chosenScope.value : undefined;
});

const canCreateGlobal = computed(
	() => getResourcePermissions(usersStore.currentUser?.globalScopes).variable.create ?? false,
);

const scopeOptions = computed(() => {
	const projectOption = (project: (typeof projectsStore.myProjects)[number], label: string) => ({
		value: project.id,
		label,
		icon: project.icon ?? { type: 'icon' as const, value: 'layer-group' },
		disabled: !getResourcePermissions(project.scopes).projectVariable.create,
	});
	return [
		{
			value: GLOBAL_SCOPE,
			label: i18n.baseText('variables.modal.scope.global'),
			icon: DEFAULT_SCOPE_ICON,
			disabled: !canCreateGlobal.value,
		},
		...projectsStore.myProjects
			.filter((project) => project.type === ProjectTypes.Personal)
			.map((project) => projectOption(project, i18n.baseText('projects.menu.personal'))),
		...projectsStore.myProjects
			.filter((project) => project.type === ProjectTypes.Team)
			.map((project) => projectOption(project, project.name ?? project.id)),
	];
});

const scopeIcon = computed<IconOrEmoji>(
	() =>
		scopeOptions.value.find((option) => option.value === chosenScope.value)?.icon ??
		DEFAULT_SCOPE_ICON,
);

/** The other variables: a variable may keep its own key. */
const otherVariables = computed(() =>
	environmentsStore.variables.filter((item) => item.id !== props.variable?.id),
);

const keyExistsInScope = computed(
	() =>
		!!key.value &&
		otherVariables.value.some(
			(item) =>
				item.key === key.value &&
				(projectId.value ? item.project?.id === projectId.value : !item.project),
		),
);

/** A project variable with the key of a global variable overrides it inside the project. */
const keyExistsGlobally = computed(
	() =>
		!!key.value &&
		!!projectId.value &&
		!keyExistsInScope.value &&
		otherVariables.value.some((item) => item.key === key.value && !item.project),
);

const keyRules = computed<Rule[]>(() => [
	{ name: 'MAX_LENGTH', config: { maximum: KEY_MAX_LENGTH } },
	{
		name: 'MATCH_REGEX',
		config: {
			regex: /^[A-Za-z0-9_]+$/,
			message: i18n.baseText('variables.editing.key.error.regex'),
		},
	},
	// An existing key may start with a number. A new key may not.
	...(isEdit.value && key.value === props.variable?.key
		? []
		: [
				{
					name: 'MATCH_REGEX',
					config: {
						regex: /^[A-Za-z_]/,
						message: i18n.baseText('variables.editing.key.error.regex-no-start-with-number'),
					},
				},
			]),
]);

const valueRules: Rule[] = [{ name: 'MAX_LENGTH', config: { maximum: VALUE_MAX_LENGTH } }];

const canSave = computed(
	() =>
		isKeyValid.value &&
		isValueValid.value &&
		!keyExistsInScope.value &&
		!isSaving.value &&
		(isEdit.value || !!projectId.value || canCreateGlobal.value),
);

function closeModal() {
	uiStore.closeModal(VARIABLE_MODAL_KEY);
}

async function onSubmit() {
	if (!canSave.value) return;

	isSaving.value = true;
	try {
		if (isEdit.value && props.variable) {
			await environmentsStore.updateVariable({
				id: props.variable.id,
				key: key.value,
				value: value.value,
				projectId: props.variable.project?.id,
			});
		} else {
			await environmentsStore.createVariable({
				key: key.value,
				value: value.value,
				projectId: projectId.value,
			});
		}
		closeModal();
	} catch (error) {
		showError(error, i18n.baseText('variables.errors.save'));
	} finally {
		isSaving.value = false;
	}
}

/** The modal stays open while it saves. */
function beforeClose() {
	return !isSaving.value;
}

onMounted(async () => {
	// The scope options come from the projects of the user.
	void projectsStore.getMyProjects();
	await nextTick();
	keyInput.value?.inputRef?.focus?.();
});
</script>

<template>
	<Modal
		:name="VARIABLE_MODAL_KEY"
		:title="title"
		width="600px"
		:event-bus="modalBus"
		:before-close="beforeClose"
		:show-close="!isSaving"
	>
		<template #content>
			<div :class="$style.form">
				<div>
					<N8nFormInput
						ref="keyInput"
						v-model="key"
						data-test-id="variable-modal-key-input"
						:label="i18n.baseText('variables.modal.key.label')"
						:placeholder="i18n.baseText('variables.editing.key.placeholder')"
						:required="true"
						:validation-rules="keyRules"
						@validate="isKeyValid = $event"
						@enter="onSubmit"
					/>
					<div
						v-if="keyExistsInScope"
						:class="[$style.notice, $style.error]"
						data-test-id="variable-modal-key-exists-error"
					>
						<N8nIcon icon="triangle-alert" size="small" />
						<N8nText size="small" color="danger">
							{{ i18n.baseText('variables.modal.error.keyExistsInProject') }}
						</N8nText>
					</div>
					<div
						v-else-if="keyExistsGlobally"
						:class="$style.notice"
						data-test-id="variable-modal-global-exists-warning"
					>
						<N8nIcon icon="triangle-alert" size="small" />
						<N8nText size="small" color="warning">
							{{ i18n.baseText('variables.modal.warning.globalKeyExists') }}
						</N8nText>
					</div>
				</div>
				<N8nFormInput
					v-model="value"
					data-test-id="variable-modal-value-input"
					type="textarea"
					:label="i18n.baseText('variables.modal.value.label')"
					:placeholder="i18n.baseText('variables.editing.value.placeholder')"
					:maxlength="VALUE_MAX_LENGTH"
					:validation-rules="valueRules"
					@validate="isValueValid = $event"
					@enter="onSubmit"
				/>
				<N8nInputLabel v-if="showScope" :label="i18n.baseText('variables.modal.scope.label')">
					<N8nSelect
						v-model="chosenScope"
						data-test-id="variable-modal-scope-select"
						size="large"
						filterable
					>
						<template #prefix>
							<N8nText v-if="scopeIcon.type === 'emoji'">{{ scopeIcon.value }}</N8nText>
							<N8nIcon v-else :icon="scopeIcon.value" />
						</template>
						<N8nOption
							v-for="option in scopeOptions"
							:key="option.value"
							:value="option.value"
							:label="option.label"
							:disabled="option.disabled"
						/>
					</N8nSelect>
				</N8nInputLabel>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton
					variant="subtle"
					data-test-id="variable-modal-cancel-button"
					:label="i18n.baseText('variables.modal.button.cancel')"
					@click="closeModal"
				/>
				<N8nButton
					data-test-id="variable-modal-save-button"
					:label="i18n.baseText('variables.modal.button.save')"
					:disabled="!canSave"
					@click="onSubmit"
				/>
			</div>
		</template>
	</Modal>
</template>

<style module lang="scss">
.form {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.notice {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
	margin-top: var(--spacing--3xs);
	color: var(--color--warning);
}

.error {
	color: var(--color--danger);
}

.footer {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--2xs);
}
</style>
