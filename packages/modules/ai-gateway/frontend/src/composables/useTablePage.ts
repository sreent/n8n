import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue';

import { DEFAULT_TABLE_PAGE_SIZE } from '../ai-gateway.constants';

/**
 * One page of a list that the page holds in full. `N8nDataTableServer` shows all the items that it
 * gets, so a table gives it only the items of the current page.
 */
export function useTablePage<T>(items: MaybeRefOrGetter<T[]>) {
	const page = ref(0);
	const itemsPerPage = ref(DEFAULT_TABLE_PAGE_SIZE);

	const pageItems = computed(() => {
		const start = page.value * itemsPerPage.value;
		return toValue(items).slice(start, start + itemsPerPage.value);
	});

	// A shorter list, for example after a removal, can end before the current page.
	watch(
		() => toValue(items).length,
		(length) => {
			const lastPage = Math.max(0, Math.ceil(length / itemsPerPage.value) - 1);
			if (page.value > lastPage) page.value = lastPage;
		},
	);

	return { page, itemsPerPage, pageItems };
}
