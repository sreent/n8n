// Fork code (not in upstream n8n): whether the licence allows evaluations. It replaces the
// enterprise composable of the same name. See `../FORK.md`.
import { computed, ref } from 'vue';

import { useUsageStore } from '@/features/settings/usage/usage.store';

// The licence loads once for the whole app, with one request at a time for all the panels that
// ask. The pages that load the licence on their own do not count.
const isLoaded = ref(false);
let licenseRequest: Promise<void> | undefined;

export function useEvaluationsLicense() {
	const usageStore = useUsageStore();

	/** A limit of 0 workflows with evaluations means that the licence has no evaluations. */
	const isLicensed = computed(() => usageStore.workflowsWithEvaluationsLimit !== 0);
	const isResolved = computed(() => isLoaded.value);

	async function ensureLicenseLoaded() {
		if (isLoaded.value) return;
		licenseRequest ??= usageStore
			.getLicenseInfo()
			.then(() => {
				isLoaded.value = true;
			})
			.finally(() => {
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
