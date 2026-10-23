import { nextTick, ref } from 'vue';

import { useTablePage } from './useTablePage';

describe('useTablePage', () => {
	const numbers = (count: number) => Array.from({ length: count }, (_, index) => index);

	it('gives the items of the current page', () => {
		const { page, itemsPerPage, pageItems } = useTablePage(numbers(60));

		expect(itemsPerPage.value).toBe(25);
		expect(pageItems.value).toEqual(numbers(25));

		page.value = 2;
		expect(pageItems.value).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
	});

	it('goes to the last page when the list gets shorter than the current page', async () => {
		const items = ref(numbers(60));
		const { page, pageItems } = useTablePage(items);
		page.value = 2;

		items.value = numbers(30);
		await nextTick();

		expect(page.value).toBe(1);
		expect(pageItems.value).toEqual([25, 26, 27, 28, 29]);
	});
});
