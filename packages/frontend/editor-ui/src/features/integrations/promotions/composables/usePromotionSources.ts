// Fork code (not in upstream n8n): the instance connection that the banners of a project use. The
// editor loads it once, and the settings page clears it after a change. See `../FORK.md`.
import { useRootStore } from '@n8n/stores/useRootStore';

import { getInstanceConnections } from '../promotions.api';
import type { PromotionApplySource, PromotionConnectionSummary } from '../promotions.types';

let instanceConnection: Promise<PromotionConnectionSummary | null> | undefined;

/** The instance connection, from the first call of the editor. */
export async function loadInstanceConnection(): Promise<PromotionConnectionSummary | null> {
	instanceConnection ??= getInstanceConnections(useRootStore().publicApiContext).then(
		(connections) => connections[0] ?? null,
		() => {
			instanceConnection = undefined;
			return null;
		},
	);
	return await instanceConnection;
}

/** The next call loads the instance connection again. */
export function clearInstanceConnection() {
	instanceConnection = undefined;
}

/** The configuration of Apply of a connection, for the selection modal. */
export function applySourceOf(
	connection: PromotionConnectionSummary | null,
): PromotionApplySource | undefined {
	const apply = connection?.configs.apply;
	if (!connection || !apply) return undefined;
	return { connectionId: connection.id, configId: apply.id, branchName: apply.settings.branchName };
}
