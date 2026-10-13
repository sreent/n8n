<script setup lang="ts">
// Fork code (not in upstream n8n): the empty state of an instance without evaluations. It replaces
// the enterprise component of the same name. The fork has no registration of the Community Edition,
// so it has no button (packages/cli/src/license/FORK.md). See `../../FORK.md`.
import { N8nEmptyState } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';

const i18n = useI18n();
</script>

<template>
	<N8nEmptyState
		data-test-id="evaluations-unlicensed"
		:heading="i18n.baseText('evaluations.paywall.fork.title')"
		:description="i18n.baseText('evaluations.paywall.fork.description')"
	/>
</template>
