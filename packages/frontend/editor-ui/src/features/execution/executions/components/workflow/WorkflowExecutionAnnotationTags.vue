<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the tags of an execution in the execution preview. A click on
 * a tag or on the add button opens the annotation tags dropdown. A blur saves a changed
 * selection, and escape cancels it. It replaces the enterprise component of the same name. See
 * `packages/cli/src/executions/FORK.md`.
 */
import { useToast } from '@n8n/composables/useToast';
import { N8nButton } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { createEventBus } from '@n8n/utils/event-bus';
import { ElTag } from 'element-plus';
import type { ExecutionSummary } from 'n8n-workflow';
import { computed, nextTick, ref } from 'vue';

import AnnotationTagsDropdown from '@/features/shared/tags/components/AnnotationTagsDropdown.vue';

import { useExecutionsStore } from '../../executions.store';

const props = defineProps<{
	execution: ExecutionSummary;
}>();

const i18n = useI18n();
const { showError } = useToast();
const executionsStore = useExecutionsStore();

const tagsEventBus = createEventBus();
const isTagsEditEnabled = ref(false);
const appliedTagIds = ref<string[]>([]);

const tags = computed(() => props.execution.annotation?.tags ?? []);
const tagIds = computed(() => tags.value.map((tag) => tag.id));

const sameTags = (a: string[], b: string[]) =>
	a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

async function onTagsEditEnable() {
	appliedTagIds.value = tagIds.value;
	isTagsEditEnabled.value = true;

	await nextTick();
	tagsEventBus.emit('focus');
}

async function onTagsBlur() {
	const selectedTagIds = appliedTagIds.value;
	isTagsEditEnabled.value = false;

	if (sameTags(selectedTagIds, tagIds.value)) return;

	try {
		await executionsStore.annotateExecution(props.execution.id, { tags: selectedTagIds });
	} catch (error) {
		// The original passed the raw key as the title. The fork shows the text.
		showError(error, i18n.baseText('executionAnnotationView.tag.error'));
	}
}

function onTagsEditEsc() {
	isTagsEditEnabled.value = false;
}
</script>

<template>
	<div :class="$style.executionDetailsTags">
		<span :class="$style.tags" data-test-id="annotation-tags-container">
			<AnnotationTagsDropdown
				v-if="isTagsEditEnabled"
				v-model="appliedTagIds"
				:create-enabled="true"
				:event-bus="tagsEventBus"
				:placeholder="i18n.baseText('executionAnnotationView.chooseOrCreateATag')"
				class="tags-edit"
				data-test-id="workflow-tags-dropdown"
				@blur="onTagsBlur"
				@esc="onTagsEditEsc"
			/>
			<div v-else-if="tagIds.length === 0">
				<N8nButton
					:label="i18n.baseText('executionAnnotationView.addTag')"
					variant="ghost"
					size="xsmall"
					icon="plus"
					data-test-id="new-tag-link"
					:class="[$style.addTagButton, 'clickable']"
					@click="onTagsEditEnable"
				/>
			</div>
			<span
				v-else
				:class="['tags-container', $style.tagsContainer]"
				data-test-id="execution-annotation-tags"
			>
				<span v-for="tag in tags" :key="tag.id" class="clickable" @click="onTagsEditEnable">
					<ElTag :title="tag.name" type="info" size="small" :disable-transitions="true">
						{{ tag.name }}
					</ElTag>
				</span>
				<span :class="$style.addTagWrapper">
					<N8nButton
						variant="ghost"
						size="xsmall"
						icon="plus"
						data-test-id="new-tag-link"
						:class="[$style.addTagButton, $style.addTagButtonIconOnly, 'clickable']"
						@click="onTagsEditEnable"
					/>
				</span>
			</span>
		</span>
	</div>
</template>

<style module lang="scss">
.executionDetailsTags {
	margin-top: var(--spacing--4xs);
}

.tags {
	display: block;
	margin-top: var(--spacing--4xs);
}

.tagsContainer {
	display: inline-flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--spacing--4xs);
}

.addTagWrapper {
	display: inline-flex;
	align-items: center;
}

.addTagButton {
	color: var(--color--text--tint-1);
}

.addTagButtonIconOnly {
	padding: 0 var(--spacing--4xs);
}
</style>
