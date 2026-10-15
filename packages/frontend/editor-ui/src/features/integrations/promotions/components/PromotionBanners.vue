<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the banners of a team project. One banner counts the changes
 * of the project that a promote sends to Git, the other the incoming changes that an apply
 * brings. A link opens the selection modal. See `../FORK.md`.
 */
import { N8nIcon, N8nLink, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { getResourcePermissions } from '@n8n/permissions';
import { useUsersStore } from '@n8n/stores/users.store';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { VIEWS } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import { usePromotionsEnabled } from '@/features/shared/promotions/usePromotionsEnabled';

import { applySourceOf, loadInstanceConnection } from '../composables/usePromotionSources';
import { getProjectChanges } from '../promotions.api';
import { PROMOTION_SELECT_MODAL_KEY } from '../promotions.constants';
import { promotionEventBus, type PromotionEvents } from '../promotions.eventBus';
import type { PromotionApplySource, PromotionSelectModalData } from '../promotions.types';

const i18n = useI18n();
const rootStore = useRootStore();
const usersStore = useUsersStore();
const projectsStore = useProjectsStore();
const uiStore = useUIStore();
const router = useRouter();
const { isEnabled } = usePromotionsEnabled();

const promoteCount = ref(0);
const applyCount = ref(0);
const applyFailed = ref(false);
const applySource = ref<PromotionApplySource>();

const project = computed(() => projectsStore.currentProject);

const isVisible = computed(
	() =>
		isEnabled.value &&
		project.value?.type === 'team' &&
		getResourcePermissions(project.value.scopes).project.export === true &&
		getResourcePermissions(usersStore.currentUser?.globalScopes).gitConnection.read === true,
);

const promoteText = computed(() =>
	promoteCount.value === 1
		? i18n.baseText('promotions.banner.singleChangeAvailable')
		: i18n.baseText('promotions.banner.changesAvailable', {
				interpolate: { count: String(promoteCount.value) },
			}),
);

const incomingText = computed(() => {
	if (applyFailed.value) return i18n.baseText('promotions.banner.incoming.error');
	return applyCount.value === 1
		? i18n.baseText('promotions.banner.incoming.singleChangeAvailable')
		: i18n.baseText('promotions.banner.incoming.changesAvailable', {
				interpolate: { count: String(applyCount.value) },
			});
});

async function countChanges(projectId: string) {
	const [promote, apply] = await Promise.allSettled([
		getProjectChanges(rootStore.restApiContext, projectId, 'promote'),
		getProjectChanges(rootStore.restApiContext, projectId, 'apply'),
	]);
	promoteCount.value = promote.status === 'fulfilled' ? promote.value.changes.length : 0;
	applyCount.value = apply.status === 'fulfilled' ? apply.value.changes.length : 0;
	applyFailed.value = apply.status === 'rejected';
}

async function load() {
	promoteCount.value = 0;
	applyCount.value = 0;
	applyFailed.value = false;
	const projectId = project.value?.id;
	if (!isVisible.value || !projectId) return;
	applySource.value = applySourceOf(await loadInstanceConnection());
	await countChanges(projectId);
}

function open(direction: 'promote' | 'apply') {
	const projectId = project.value?.id;
	if (!projectId) return;
	const data: PromotionSelectModalData = { projectId, direction };
	if (direction === 'apply' && applySource.value) data.apply = applySource.value;
	uiStore.openModalWithData({ name: PROMOTION_SELECT_MODAL_KEY, data });
}

function onApplied(payload: PromotionEvents['applied']) {
	const projectId = project.value?.id;
	if (!payload || !projectId || payload.projectId !== projectId || !isVisible.value) return;
	void countChanges(projectId);
}

function onProjectRemoved(payload: PromotionEvents['projectRemoved']) {
	if (payload.projectId !== project.value?.id) return;
	void router.push({ name: VIEWS.HOMEPAGE });
}

watch(() => `${project.value?.id ?? ''}:${isVisible.value}`, load);

onMounted(() => {
	promotionEventBus.on('applied', onApplied);
	promotionEventBus.on('projectRemoved', onProjectRemoved);
	void load();
});

onBeforeUnmount(() => {
	promotionEventBus.off('applied', onApplied);
	promotionEventBus.off('projectRemoved', onProjectRemoved);
});
</script>

<template>
	<div
		v-if="isVisible && (promoteCount > 0 || applyCount > 0 || applyFailed)"
		:class="$style.banners"
	>
		<div v-if="promoteCount > 0" :class="$style.banner" data-test-id="promotion-banner">
			<N8nIcon icon="upload" size="small" />
			<N8nText size="small">{{ promoteText }}</N8nText>
			<N8nLink size="small" data-test-id="promotion-banner-link" @click="open('promote')">
				{{ i18n.baseText('promotions.banner.viewChanges') }}
			</N8nLink>
		</div>
		<div
			v-if="applyCount > 0 || applyFailed"
			:class="$style.banner"
			data-test-id="promotion-incoming-banner"
		>
			<N8nIcon :icon="applyFailed ? 'triangle-alert' : 'download'" size="small" />
			<N8nText size="small">{{ incomingText }}</N8nText>
			<N8nLink size="small" data-test-id="promotion-incoming-banner-link" @click="open('apply')">
				{{ i18n.baseText('promotions.banner.viewChanges') }}
			</N8nLink>
		</div>
	</div>
</template>

<style module lang="scss">
.banners {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--2xs);
	margin-top: var(--spacing--xs);
}

.banner {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--3xs);
	padding: var(--spacing--3xs) var(--spacing--2xs);
	border: var(--border);
	border-radius: var(--radius);
	background-color: var(--color--background--light-2);
}
</style>
