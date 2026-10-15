// Fork code (not in upstream n8n): the form of the instance connection on the settings page of Git
// connections. It keeps a draft of the saved connection, saves the changes part by part and keeps
// the parts that failed for a retry. See `../FORK.md`.
import { useToast } from '@n8n/composables/useToast';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, reactive, ref } from 'vue';

import {
	cloneCheckout,
	createConnection,
	deleteConfig,
	disconnectCheckout,
	saveConfig,
	updateConnection,
} from '../promotions.api';
import type { PromotionConnection, PromotionDirection } from '../promotions.types';
import { clearInstanceConnection } from './usePromotionSources';

export interface ConnectionDraft {
	providerId: string;
	name: string;
	remoteUrl: string;
	apply: { enabled: boolean; branch: string };
	promote: { enabled: boolean; branch: string; createBranch: boolean };
}

/** A part of the connection that a save sends in its own request. */
export type ConnectionPart = 'connection' | PromotionDirection;

/** The state of the local copy of one direction. */
export type CheckoutState = 'unsaved' | 'connected' | 'stale' | 'none';

function draftOf(connection: PromotionConnection | null): ConnectionDraft {
	const apply = connection?.configs.apply;
	const promote = connection?.configs.promote;
	return {
		providerId: connection?.provider.id ?? '',
		name: connection?.name ?? '',
		remoteUrl: connection?.target.remoteUrl ?? '',
		apply: { enabled: !!apply, branch: apply?.settings.branchName ?? '' },
		promote: {
			enabled: !!promote,
			branch: promote?.settings.baseBranchName ?? '',
			createBranch: promote?.settings.createBranchOnPromotion ?? false,
		},
	};
}

const copyOf = (draft: ConnectionDraft): ConnectionDraft => ({
	...draft,
	apply: { ...draft.apply },
	promote: { ...draft.promote },
});

function isDraftChanged(draft: ConnectionDraft, baseline: ConnectionDraft) {
	if (
		draft.providerId !== baseline.providerId ||
		draft.name !== baseline.name ||
		draft.remoteUrl !== baseline.remoteUrl ||
		draft.apply.enabled !== baseline.apply.enabled ||
		draft.promote.enabled !== baseline.promote.enabled
	) {
		return true;
	}
	if (draft.apply.enabled && draft.apply.branch !== baseline.apply.branch) return true;
	return (
		draft.promote.enabled &&
		(draft.promote.branch !== baseline.promote.branch ||
			draft.promote.createBranch !== baseline.promote.createBranch)
	);
}

const applySettings = (draft: ConnectionDraft) => ({
	schemaVersion: 1 as const,
	branchName: draft.apply.branch.trim(),
});

const promoteSettings = (draft: ConnectionDraft) => ({
	schemaVersion: 1 as const,
	baseBranchName: draft.promote.branch.trim(),
	createBranchOnPromotion: draft.promote.createBranch,
});

export function usePromotionConnectionForm() {
	const i18n = useI18n();
	const toast = useToast();
	const rootStore = useRootStore();

	/** The connection as the server saved it. `null` before a connection exists. */
	const saved = ref<PromotionConnection | null>(null);
	const draft = reactive<ConnectionDraft>(draftOf(null));
	/**
	 * The values of the form without changes. A part that saves takes the values of the draft as
	 * they are, so the form keeps what the user typed.
	 */
	const baseline = ref<ConnectionDraft>(draftOf(null));
	const failedParts = ref<ConnectionPart[]>([]);
	const saving = ref(false);
	const busyDirections = ref<PromotionDirection[]>([]);

	const isDirty = computed(() => isDraftChanged(draft, baseline.value));

	const canSave = computed(
		() =>
			!!draft.providerId &&
			!!draft.name.trim() &&
			!!draft.remoteUrl.trim() &&
			(!draft.apply.enabled || !!draft.apply.branch.trim()) &&
			(!draft.promote.enabled || !!draft.promote.branch.trim()),
	);

	function resetDraft() {
		baseline.value = draftOf(saved.value);
		Object.assign(draft, copyOf(baseline.value));
	}

	function acceptPart(part: ConnectionPart) {
		if (part === 'connection') {
			const { providerId, name, remoteUrl } = draft;
			baseline.value = { ...baseline.value, providerId, name, remoteUrl };
		} else if (part === 'apply') {
			baseline.value = { ...baseline.value, apply: { ...draft.apply } };
		} else {
			baseline.value = { ...baseline.value, promote: { ...draft.promote } };
		}
	}

	/** Takes a connection that the page loaded. A draft with changes stays. */
	function replaceSaved(connection: PromotionConnection | null) {
		const keepDraft = isDirty.value;
		saved.value = connection;
		if (!keepDraft) resetDraft();
	}

	function discard() {
		failedParts.value = [];
		Object.assign(draft, copyOf(baseline.value));
	}

	async function create() {
		const configs: Parameters<typeof createConnection>[1]['configs'] = {};
		if (draft.apply.enabled) configs.apply = { name: undefined, settings: applySettings(draft) };
		if (draft.promote.enabled) {
			configs.promote = { name: undefined, settings: promoteSettings(draft) };
		}
		try {
			saved.value = await createConnection(rootStore.publicApiContext, {
				configs,
				name: draft.name.trim(),
				providerId: draft.providerId,
				scope: 'instance',
				target: { schemaVersion: 1, remoteUrl: draft.remoteUrl.trim() },
			});
			clearInstanceConnection();
			failedParts.value = [];
			resetDraft();
			toast.showMessage({
				title: i18n.baseText('settings.promotions.connection.toast.created'),
				type: 'success',
			});
		} catch (error) {
			toast.showError(error, i18n.baseText('settings.promotions.connection.toast.error.save'));
		}
	}

	function isConfigChanged(connection: PromotionConnection, direction: PromotionDirection) {
		if (direction === 'apply') {
			return connection.configs.apply?.settings.branchName !== draft.apply.branch.trim();
		}
		const settings = connection.configs.promote?.settings;
		return (
			settings?.baseBranchName !== draft.promote.branch.trim() ||
			settings.createBranchOnPromotion !== draft.promote.createBranch
		);
	}

	/** Sends one part. Returns the error of a failed request. */
	async function savePart(connection: PromotionConnection, part: ConnectionPart) {
		const context = rootStore.publicApiContext;
		try {
			if (part === 'connection') {
				const changes: Parameters<typeof updateConnection>[2] = {};
				if (draft.name.trim() !== connection.name) changes.name = draft.name.trim();
				if (draft.providerId !== connection.provider.id) changes.providerId = draft.providerId;
				if (draft.remoteUrl.trim() !== connection.target.remoteUrl) {
					changes.target = { schemaVersion: 1, remoteUrl: draft.remoteUrl.trim() };
				}
				if (Object.keys(changes).length === 0) return undefined;
				saved.value = await updateConnection(context, connection.id, changes);
				return undefined;
			}
			const current = connection.configs[part];
			const enabled = draft[part].enabled;
			if (!enabled) {
				if (!current) return undefined;
				await deleteConfig(context, connection.id, part);
				const { [part]: _removed, ...configs } = connection.configs;
				saved.value = { ...connection, configs };
				return undefined;
			}
			if (current && !isConfigChanged(connection, part)) return undefined;
			const settings = part === 'apply' ? applySettings(draft) : promoteSettings(draft);
			const config = await saveConfig(context, connection.id, part, {
				name: current?.name,
				settings,
			});
			saved.value = { ...connection, configs: { ...connection.configs, [part]: config } };
			return undefined;
		} catch (error) {
			return error;
		}
	}

	async function update() {
		const failures: Array<{ part: ConnectionPart; error: unknown }> = [];
		for (const part of ['connection', 'apply', 'promote'] as const) {
			const connection = saved.value;
			if (!connection) return;
			const error = await savePart(connection, part);
			if (error === undefined) acceptPart(part);
			else failures.push({ part, error });
		}
		clearInstanceConnection();
		failedParts.value = failures.map(({ part }) => part);
		if (failures.length > 0) {
			toast.showError(
				failures[0].error,
				i18n.baseText('settings.promotions.connection.toast.error.save'),
			);
			return;
		}
		toast.showMessage({
			title: i18n.baseText('settings.promotions.connection.toast.updated'),
			type: 'success',
		});
	}

	async function save() {
		if (saving.value || !canSave.value) return;
		saving.value = true;
		try {
			if (saved.value) await update();
			else await create();
		} finally {
			saving.value = false;
		}
	}

	function checkoutState(direction: PromotionDirection): CheckoutState {
		const config = saved.value?.configs[direction];
		if (!config) return 'unsaved';
		if (!config.checkout.hasCheckout) return 'none';
		return config.checkout.matchesConfig ? 'connected' : 'stale';
	}

	function savedBranch(direction: PromotionDirection) {
		const configs = saved.value?.configs;
		if (direction === 'apply') return configs?.apply?.settings.branchName ?? '';
		return configs?.promote?.settings.baseBranchName ?? '';
	}

	function setCheckout(direction: PromotionDirection, hasCheckout: boolean) {
		const connection = saved.value;
		const config = connection?.configs[direction];
		if (!connection || !config) return;
		saved.value = {
			...connection,
			configs: {
				...connection.configs,
				[direction]: { ...config, checkout: { hasCheckout, matchesConfig: hasCheckout } },
			},
		};
	}

	async function runCheckout(direction: PromotionDirection, connect: boolean) {
		const connection = saved.value;
		if (!connection || busyDirections.value.includes(direction)) return;
		busyDirections.value = [...busyDirections.value, direction];
		try {
			if (connect) await cloneCheckout(rootStore.publicApiContext, connection.id, direction);
			else await disconnectCheckout(rootStore.publicApiContext, connection.id, direction);
			setCheckout(direction, connect);
			toast.showMessage({
				title: i18n.baseText(
					connect
						? 'settings.promotions.connection.checkout.toast.connected'
						: 'settings.promotions.connection.checkout.toast.disconnected',
				),
				type: 'success',
			});
		} catch (error) {
			toast.showError(
				error,
				i18n.baseText(
					connect
						? 'settings.promotions.connection.checkout.toast.connectError'
						: 'settings.promotions.connection.checkout.toast.disconnectError',
				),
			);
		} finally {
			busyDirections.value = busyDirections.value.filter((busy) => busy !== direction);
		}
	}

	return {
		saved,
		draft,
		failedParts,
		saving,
		busyDirections,
		isDirty,
		canSave,
		replaceSaved,
		discard,
		save,
		checkoutState,
		savedBranch,
		connect: async (direction: PromotionDirection) => await runCheckout(direction, true),
		disconnect: async (direction: PromotionDirection) => await runCheckout(direction, false),
	};
}
