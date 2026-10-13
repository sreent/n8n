// Fork code (not in upstream n8n): whether the collections of evaluations are on. The setting
// `N8N_EVAL_COLLECTIONS_ENABLED` or the PostHog flag turns them on. It replaces the enterprise
// composable of the same name. See `../FORK.md`.
import { EVAL_COLLECTIONS_FLAG } from '@n8n/api-types';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { computed } from 'vue';

import { usePostHog } from '@/app/stores/posthog.store';

export function useEvalCollectionsFlag() {
	const settingsStore = useSettingsStore();
	const posthogStore = usePostHog();

	return computed(
		() =>
			settingsStore.settings.evaluation?.collectionsEnabled === true ||
			posthogStore.getVariant(EVAL_COLLECTIONS_FLAG) === true,
	);
}
