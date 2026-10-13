// Fork code (not in upstream n8n): whether the licence allows evaluations. It replaces the
// enterprise composable of the same name. See `../FORK.md`.
import { computed } from 'vue';

import { useUsageStore } from '@/features/settings/usage/usage.store';

// One request for the licence at a time, for all the panels that ask.
let licenseRequest: Promise<void> | undefined;

export function useEvaluationsLicense() {
	const usageStore = useUsageStore();

	/** A limit of 0 workflows with evaluations means that the licence has no evaluations. */
	const isLicensed = computed(() => usageStore.workflowsWithEvaluationsLimit !== 0);
	const isResolved = computed(() => usageStore.hasLoadedLicense);

	async function ensureLicenseLoaded() {
		if (usageStore.hasLoadedLicense) return;
		licenseRequest ??= usageStore.getLicenseInfo().finally(() => {
			licenseRequest = undefined;
		});
		try {
			await licenseRequest;
		} catch {
			// Without the licence, the panels show the paywall.
		}
	}

	return { isLicensed, isResolved, ensureLicenseLoaded };
}
