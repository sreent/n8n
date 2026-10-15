<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the results of the automatic publishing of a pull. The pull
 * modal opens it with the workflows that the pull tried to publish. A workflow with a
 * `publishingError` failed. `../FORK.md` describes it.
 */
import { N8nButton, N8nInfoTip, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref } from 'vue';

import Modal from '@/app/components/Modal.vue';
import { VIEWS } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';

import { SOURCE_CONTROL_PULL_RESULT_MODAL_KEY } from '../sourceControl.constants';
import type { SourceControlledFile } from '../sourceControl.types';

type Tab = 'failed' | 'published';

const props = defineProps<{
	modalName: string;
	data: { workflows: SourceControlledFile[] };
}>();

const i18n = useI18n();
const uiStore = useUIStore();

const failed = computed(() => props.data.workflows.filter((file) => !!file.publishingError));
const published = computed(() => props.data.workflows.filter((file) => !file.publishingError));

const activeTab = ref<Tab>(failed.value.length > 0 ? 'failed' : 'published');

const tabs = computed(() => {
	const all: Array<{ value: Tab; label: string; count: number }> = [];
	if (failed.value.length > 0) {
		all.push({
			value: 'failed',
			label: i18n.baseText('settings.sourceControl.modals.pullResult.tabs.failed'),
			count: failed.value.length,
		});
	}
	all.push({
		value: 'published',
		label: i18n.baseText('settings.sourceControl.modals.pullResult.tabs.published'),
		count: published.value.length,
	});
	return all;
});

const rows = computed(() => (activeTab.value === 'failed' ? failed.value : published.value));

function itemCount(count: number) {
	return i18n.baseText('settings.sourceControl.modals.pullResult.itemCount', {
		adjustToNumber: count,
		interpolate: { count: String(count) },
	});
}

function close() {
	uiStore.closeModal(SOURCE_CONTROL_PULL_RESULT_MODAL_KEY);
}
</script>

<template>
	<Modal
		width="812px"
		:title="i18n.baseText('settings.sourceControl.modals.pullResult.title')"
		:name="modalName"
	>
		<template #content>
			<div :class="$style.container">
				<div :class="$style.tabs">
					<button
						v-for="tab in tabs"
						:key="tab.value"
						type="button"
						:class="[$style.tab, { [$style.tabActive]: activeTab === tab.value }]"
						:data-test-id="`pull-result-modal-tab-${tab.value}`"
						@click="activeTab = tab.value"
					>
						<div>{{ tab.label }}</div>
						<N8nText tag="div" size="small" color="text-light">{{ itemCount(tab.count) }}</N8nText>
					</button>
				</div>
				<div :class="$style.table">
					<div :class="$style.tableHeader">
						<N8nText size="small" bold>{{
							i18n.baseText('settings.sourceControl.modals.pullResult.tableHeader.title')
						}}</N8nText>
					</div>
					<div v-if="rows.length === 0" :class="$style.empty">
						<N8nInfoTip :bold="false">{{
							i18n.baseText('settings.sourceControl.modals.pullResult.noWorkflows')
						}}</N8nInfoTip>
					</div>
					<div v-for="file in rows" v-else :key="file.id" :class="$style.row">
						<N8nText tag="div" :class="$style.name">
							<RouterLink
								:to="{ name: VIEWS.WORKFLOW, params: { workflowId: file.id } }"
								target="_blank"
								>{{ file.name }}</RouterLink
							>
						</N8nText>
						<N8nText v-if="file.publishingError" tag="p" size="small" color="danger">{{
							file.publishingError
						}}</N8nText>
					</div>
				</div>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton variant="subtle" @click="close">{{
					i18n.baseText('settings.sourceControl.modals.pullResult.buttons.close')
				}}</N8nButton>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.tabs {
	display: flex;
	gap: var(--spacing--2xs);
}

.tab {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--spacing--5xs);
	padding: var(--spacing--2xs) var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius);
	background: transparent;
	color: var(--color--text);
	font-size: var(--font-size--sm);
	cursor: pointer;
}

.tabActive {
	border-color: var(--color--primary);
	background: var(--color--background--light-2);
}

.table {
	border: var(--border);
	border-radius: var(--radius);
	max-height: 400px;
	overflow-y: auto;
}

.tableHeader {
	padding: var(--spacing--2xs) var(--spacing--sm);
	border-bottom: var(--border);
}

.row {
	padding: var(--spacing--2xs) var(--spacing--sm);
	border-bottom: var(--border);

	&:last-child {
		border-bottom: none;
	}

	p {
		margin: var(--spacing--5xs) 0 0;
	}
}

.name a {
	color: var(--color--text--shade-1);
}

.empty {
	padding: var(--spacing--sm);
}

.footer {
	display: flex;
	justify-content: flex-end;
}
</style>
