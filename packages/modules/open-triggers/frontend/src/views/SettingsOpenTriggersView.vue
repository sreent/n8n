<script lang="ts" setup>
import type { OpenTriggerItem, OpenTriggerKind } from '@n8n/api-types';
import { useDocumentTitle } from '@n8n/composables/useDocumentTitle';
import { useToast } from '@n8n/composables/useToast';
import {
	N8nBadge,
	N8nCallout,
	N8nDataTableServer,
	N8nSettingsLayout,
	N8nSettingsPageHeader,
	N8nText,
	type TableHeader,
} from '@n8n/design-system';
import { useI18n, type BaseTextKey } from '@n8n/i18n';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { getOpenTriggers } from '../open-triggers.api';
import { OPEN_TRIGGERS_MODULE_ID } from '../open-triggers.constants';

const PAGE_SIZES = [25, 50, 100];

const KIND_LABEL_KEY: Record<OpenTriggerKind, BaseTextKey> = {
	webhook: 'openTriggers.kind.webhook',
	form: 'openTriggers.kind.form',
	chat: 'openTriggers.kind.chat',
	mcp: 'openTriggers.kind.mcp',
};

const i18n = useI18n();
const toast = useToast();
const rootStore = useRootStore();
const settingsStore = useSettingsStore();
const documentTitle = useDocumentTitle({ releaseChannel: settingsStore.settings.releaseChannel });

const triggers = ref<OpenTriggerItem[]>([]);
const loading = ref(false);
const page = ref(0);
const itemsPerPage = ref(PAGE_SIZES[0]);

const needApproval = computed(
	() => settingsStore.moduleSettings[OPEN_TRIGGERS_MODULE_ID]?.needApproval === true,
);
const pageItems = computed(() =>
	triggers.value.slice(page.value * itemsPerPage.value, (page.value + 1) * itemsPerPage.value),
);
const notApprovedCount = computed(() => triggers.value.filter((item) => !item.approved).length);

const projectLabel = (item: OpenTriggerItem) =>
	item.homeProject?.type === 'personal'
		? i18n.baseText('openTriggers.settings.personalSpace', {
				interpolate: { owner: item.owner?.email ?? item.homeProject.name },
			})
		: (item.homeProject?.name ?? '—');

const headers = computed<Array<TableHeader<OpenTriggerItem>>>(() => [
	{
		title: i18n.baseText('openTriggers.settings.column.workflow'),
		key: 'workflowName',
		disableSort: true,
		minWidth: 220,
	},
	{
		title: i18n.baseText('openTriggers.settings.column.project'),
		key: 'project',
		value: projectLabel,
		disableSort: true,
		minWidth: 180,
	},
	{
		title: i18n.baseText('openTriggers.settings.column.trigger'),
		key: 'nodeName',
		disableSort: true,
		minWidth: 180,
	},
	{
		title: i18n.baseText('openTriggers.settings.column.kind'),
		key: 'kind',
		value: (item) => i18n.baseText(KIND_LABEL_KEY[item.kind]),
		disableSort: true,
		minWidth: 120,
	},
	{
		title: i18n.baseText('openTriggers.settings.column.path'),
		key: 'path',
		disableSort: true,
		minWidth: 160,
	},
	{
		title: i18n.baseText('openTriggers.settings.column.approval'),
		key: 'approved',
		disableSort: true,
		minWidth: 140,
	},
]);

async function load() {
	loading.value = true;
	try {
		triggers.value = await getOpenTriggers(rootStore.restApiContext);
		page.value = 0;
	} catch (error) {
		toast.showError(error, i18n.baseText('openTriggers.settings.loadError'));
	} finally {
		loading.value = false;
	}
}

onMounted(async () => {
	documentTitle.set(i18n.baseText('openTriggers.settings.title'));
	await load();
});
</script>

<template>
	<N8nSettingsLayout full-width data-test-id="settings-open-triggers">
		<N8nSettingsPageHeader
			:title="i18n.baseText('openTriggers.settings.title')"
			:description="i18n.baseText('openTriggers.settings.description')"
			:show-docs-link="false"
		/>

		<N8nCallout
			:theme="needApproval ? 'info' : 'warning'"
			:class="$style.callout"
			data-test-id="open-triggers-check-state"
		>
			{{
				i18n.baseText(
					needApproval ? 'openTriggers.settings.checkOn' : 'openTriggers.settings.checkOff',
				)
			}}
		</N8nCallout>

		<N8nText
			v-if="triggers.length"
			tag="p"
			size="small"
			color="text-light"
			:class="$style.summary"
			data-test-id="open-triggers-summary"
		>
			{{
				i18n.baseText('openTriggers.settings.summary', {
					adjustToNumber: triggers.length,
					interpolate: { count: triggers.length, notApproved: notApprovedCount },
				})
			}}
		</N8nText>

		<N8nDataTableServer
			v-model:page="page"
			v-model:items-per-page="itemsPerPage"
			:headers="headers"
			:items="pageItems"
			:items-length="triggers.length"
			:loading="loading"
			:page-sizes="PAGE_SIZES"
			data-test-id="open-triggers-table"
		>
			<template #[`item.workflowName`]="{ item }">
				<RouterLink :to="{ path: `/workflow/${item.workflowId}` }" :class="$style.link">
					{{ item.workflowName }}
				</RouterLink>
			</template>
			<template #[`item.path`]="{ item }">
				<code v-if="item.path">{{ item.path }}</code>
				<span v-else>—</span>
			</template>
			<template #[`item.approved`]="{ item }">
				<N8nBadge
					:variant="item.approved ? 'success' : 'warning'"
					:data-test-id="`open-trigger-approval-${item.nodeId}`"
				>
					{{
						i18n.baseText(
							item.approved
								? 'openTriggers.settings.approved'
								: 'openTriggers.settings.notApproved',
						)
					}}
				</N8nBadge>
			</template>
		</N8nDataTableServer>

		<div
			v-if="!loading && !triggers.length"
			:class="$style.emptyState"
			data-test-id="open-triggers-empty"
		>
			<N8nText tag="p" bold>{{ i18n.baseText('openTriggers.settings.empty.title') }}</N8nText>
			<N8nText tag="p" color="text-light">
				{{ i18n.baseText('openTriggers.settings.empty.description') }}
			</N8nText>
		</div>
	</N8nSettingsLayout>
</template>

<style lang="scss" module>
.callout {
	margin-bottom: var(--spacing--sm);
}

.summary {
	margin-bottom: var(--spacing--xs);
}

.link {
	color: var(--color--primary);
	text-decoration: none;

	&:hover {
		text-decoration: underline;
	}
}

.emptyState {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--spacing--4xs);
	padding: var(--spacing--xl) 0;
}
</style>
