<script setup lang="ts">
import { N8nBadge, N8nText } from '@n8n/design-system';
import type { BadgeVariant } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';

import type { GitSyncWorkflowChange } from '../git-sync.api';

defineProps<{
	title: string;
	emptyText: string;
	changes: GitSyncWorkflowChange[];
}>();

const i18n = useI18n();

const CHANGE_VARIANTS: Record<GitSyncWorkflowChange['change'], BadgeVariant> = {
	created: 'success',
	modified: 'info',
	deleted: 'danger',
};

const changeLabel = (change: GitSyncWorkflowChange['change']) =>
	i18n.baseText(`settings.gitSync.change.${change}`);
</script>

<template>
	<div :class="$style.list">
		<N8nText bold size="small" color="text-dark">{{ title }}</N8nText>
		<N8nText v-if="changes.length === 0" size="small" color="text-light">
			{{ emptyText }}
		</N8nText>
		<ul v-else :class="$style.items">
			<li
				v-for="item in changes"
				:key="item.id"
				:class="$style.item"
				data-test-id="git-sync-change"
			>
				<N8nBadge :variant="CHANGE_VARIANTS[item.change]" size="small">
					{{ changeLabel(item.change) }}
				</N8nBadge>
				<N8nText size="small">{{ item.name }}</N8nText>
			</li>
		</ul>
	</div>
</template>

<style lang="scss" module>
.list {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	min-width: 0;
}

.items {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
	margin: 0;
	padding: 0;
	list-style: none;
}

.item {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	min-width: 0;
}
</style>
