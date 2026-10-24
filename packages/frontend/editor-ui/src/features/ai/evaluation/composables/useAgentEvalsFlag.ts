// Fork code (not in upstream n8n): whether the evaluations of agents are on. The setting
// `N8N_AGENT_EVALS_ENABLED` or the PostHog flag turns them on. It replaces the enterprise
// composable of the same name. See `../FORK.md`.
import { AGENT_EVALS_FLAG } from '@n8n/api-types';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { computed } from 'vue';

import { usePostHog } from '@/app/stores/posthog.store';

export function useAgentEvalsFlag() {
	const settingsStore = useSettingsStore();
	const posthogStore = usePostHog();

	return computed(
		() =>
			settingsStore.settings.evaluation?.agentEvalsEnabled === true ||
			posthogStore.isFeatureEnabled(AGENT_EVALS_FLAG),
	);
}
