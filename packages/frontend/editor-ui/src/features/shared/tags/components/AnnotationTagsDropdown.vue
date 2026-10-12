<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the dropdown of the tags of execution annotations. It replaces
 * the enterprise component of the same name, and wraps `TagsDropdown` as `WorkflowTagsDropdown`
 * does, with the annotation tags store and permissions. See
 * `packages/cli/src/executions/FORK.md`.
 */
import type { EventBus } from '@n8n/utils/event-bus';
import { computed } from 'vue';

import { useUIStore } from '@/app/stores/ui.store';

import { ANNOTATION_TAGS_MANAGER_MODAL_KEY } from '../tags.constants';
import { useAnnotationTagsStore } from '../tags.store';
import { useAnnotationTagPermissions } from '../useTagPermissions';
import TagsDropdown from './TagsDropdown.vue';

interface AnnotationTagsDropdownProps {
	placeholder?: string;
	modelValue?: string[];
	createEnabled?: boolean;
	eventBus?: EventBus | null;
}

const props = withDefaults(defineProps<AnnotationTagsDropdownProps>(), {
	placeholder: '',
	modelValue: () => [],
	createEnabled: false,
	eventBus: null,
});

const emit = defineEmits<{
	'update:modelValue': [selected: string[]];
	esc: [];
	blur: [];
}>();

const tagsStore = useAnnotationTagsStore();
const uiStore = useUIStore();
const { canCreate, canManage } = useAnnotationTagPermissions();

const selectedTags = computed({
	get: () => props.modelValue,
	set: (value) => emit('update:modelValue', value),
});

const allTags = computed(() => tagsStore.allTags);
const isLoading = computed(() => tagsStore.isLoading);
const tagsById = computed(() => tagsStore.tagsById);

const isCreateEnabled = computed(() => props.createEnabled && canCreate.value);
const isManageEnabled = computed(() => canManage.value);

async function createTag(name: string) {
	return await tagsStore.create(name);
}

function handleManageTags() {
	uiStore.openModal(ANNOTATION_TAGS_MANAGER_MODAL_KEY);
}

function handleEsc() {
	emit('esc');
}

function handleBlur() {
	emit('blur');
}

// Fetch all tags when the component is created
void tagsStore.fetchAll();
</script>

<template>
	<TagsDropdown
		v-model="selectedTags"
		:placeholder="placeholder"
		:create-enabled="isCreateEnabled"
		:manage-enabled="isManageEnabled"
		:event-bus="eventBus"
		:all-tags="allTags"
		:is-loading="isLoading"
		:tags-by-id="tagsById"
		:create-tag="createTag"
		@manage-tags="handleManageTags"
		@esc="handleEsc"
		@blur="handleBlur"
	/>
</template>
