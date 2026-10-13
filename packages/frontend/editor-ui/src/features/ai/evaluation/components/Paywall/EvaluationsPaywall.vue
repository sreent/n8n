<script setup lang="ts">
// Fork code (not in upstream n8n): the empty state that asks a Community instance to register for
// evaluations. It replaces the enterprise component of the same name. See `../../FORK.md`.
import { N8nEmptyState } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';

import { useUIStore } from '@/app/stores/ui.store';
import { COMMUNITY_PLUS_ENROLLMENT_MODAL } from '@/features/settings/usage/usage.constants';

const i18n = useI18n();
const uiStore = useUIStore();

function openRegistration() {
	uiStore.openModalWithData({
		name: COMMUNITY_PLUS_ENROLLMENT_MODAL,
		data: { customHeading: undefined },
	});
}
</script>

<template>
	<N8nEmptyState
		data-test-id="evaluations-unlicensed"
		:heading="i18n.baseText('evaluations.paywall.title')"
		:description="i18n.baseText('evaluations.paywall.description')"
		:button-text="i18n.baseText('evaluations.paywall.cta')"
		@click:button="openRegistration"
	/>
</template>
