import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { useTelemetry } from '@n8n/composables/useTelemetry';
import { useCloudPlanStore } from '@n8n/stores/cloudPlan.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';
import { AI_GATEWAY_ADMIN_VIEW } from '@n8n/frontend-module-ai-gateway';
import { useRouter } from 'vue-router';
import { AI_GATEWAY_TOP_UP_MODAL_KEY, CLOUD_N8N_CONNECT_TOP_UP_PATH } from '@/app/constants';
import { usePageRedirectionHelper } from '@/app/composables/usePageRedirectionHelper';
import { useUIStore } from '@/app/stores/ui.store';
import { hasPermission } from '@/app/utils/rbac/permissions';

export type AiGatewayTopUpSource = 'settings_page' | 'credential_selector';

export type AiGatewayTopUpVariant = 'member' | 'memberTrial' | 'ownerTrial';

export function useAiGatewayTopUp() {
	const uiStore = useUIStore();
	const usersStore = useUsersStore();
	const cloudPlanStore = useCloudPlanStore();
	const telemetry = useTelemetry();
	const toast = useToast();
	const i18n = useI18n();
	const { goToCloudDashboard } = usePageRedirectionHelper();
	const settingsStore = useSettingsStore();
	const router = useRouter();

	/**
	 * Fork: the self-hosted AI gateway (`packages/cli/src/modules/ai-gateway`) has no Cloud Admin
	 * Panel. An admin adds top-ups on its settings page. Other users get the dialog of n8n that asks
	 * them to contact an admin, with the text of the self-hosted gateway.
	 */
	async function openForkTopUp() {
		if (hasPermission(['rbac'], { rbac: { scope: 'aiAssistant:manage' } })) {
			await router.push({ name: AI_GATEWAY_ADMIN_VIEW });
			return;
		}
		uiStore.openModalWithData({ name: AI_GATEWAY_TOP_UP_MODAL_KEY, data: { variant: 'member' } });
	}

	function resolveVariant(): AiGatewayTopUpVariant {
		if (usersStore.isInstanceOwner && cloudPlanStore.userIsTrialing) return 'ownerTrial';
		if (cloudPlanStore.userIsTrialing) return 'memberTrial';
		return 'member';
	}

	async function openTopUp(options: {
		source: AiGatewayTopUpSource;
		credentialType?: string;
	}): Promise<void> {
		telemetry.track('User clicked ai gateway top up', {
			source: options.source,
			credential_type: options.credentialType,
		});

		if (
			settingsStore.moduleSettings['ai-gateway']?.selfHosted === true &&
			!settingsStore.isCloudDeployment
		) {
			await openForkTopUp();
			return;
		}

		if (usersStore.isInstanceOwner && !cloudPlanStore.userIsTrialing) {
			try {
				await goToCloudDashboard({
					redirectionPath: CLOUD_N8N_CONNECT_TOP_UP_PATH,
					mode: 'open',
				});
			} catch (error) {
				toast.showError(error, i18n.baseText('aiGateway.topUp.modal.cta.openAdminPanelError'));
			}
			return;
		}

		uiStore.openModalWithData({
			name: AI_GATEWAY_TOP_UP_MODAL_KEY,
			data: { variant: resolveVariant() },
		});
	}

	return { openTopUp };
}
