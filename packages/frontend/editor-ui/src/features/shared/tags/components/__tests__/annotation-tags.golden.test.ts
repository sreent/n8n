// Fork test (not in upstream n8n): the annotation tags dropdown and the annotation tags manager,
// as black boxes. The two components wrap the ordinary `TagsDropdown` and `TagsManager`. Stubs
// of these two record what the wrappers give them, and the test calls the handlers that the
// wrappers give. The snapshot records the props, the store calls, the modals, the toasts and the
// events. packages/cli/src/executions/FORK.md tells how the fork made the snapshot.
import { createEventBus } from '@n8n/utils/event-bus';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { camelize } from 'vue';

import { renderComponent } from '@/__tests__/render';
import { mockedStore } from '@/__tests__/utils';
import { useUIStore } from '@/app/stores/ui.store';

import { useAnnotationTagsStore } from '../../tags.store';
// The modules under test.
import AnnotationTagsDropdown from '../AnnotationTagsDropdown.vue';
import AnnotationTagsManager from '../TagsManager/AnnotationTagsManager.vue';

const mocks = vi.hoisted(() => ({
	scopes: new Set<string>(),
	dropdownAttrs: [] as Array<Record<string, unknown>>,
	managerAttrs: [] as Array<Record<string, unknown>>,
	toasts: [] as Array<[string, unknown[]]>,
}));

vi.mock('@/app/utils/rbac/permissions', () => ({
	hasPermission: (_checks: unknown, options?: { rbac?: { scope?: string } }) =>
		!options?.rbac?.scope || mocks.scopes.has(options.rbac.scope),
}));

vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({
		showError: (...args: unknown[]) => mocks.toasts.push(['showError', args]),
		showMessage: (...args: unknown[]) => mocks.toasts.push(['showMessage', args]),
	}),
}));

vi.mock('../TagsDropdown.vue', async () => {
	const { defineComponent, h } = await import('vue');
	return {
		default: defineComponent({
			name: 'TagsDropdown',
			inheritAttrs: false,
			setup(_props, { attrs }) {
				mocks.dropdownAttrs.push(attrs);
				return () => h('div', { 'data-test-id': 'tags-dropdown-stub' });
			},
		}),
	};
});

vi.mock('../TagsManager/TagsManager.vue', async () => {
	const { defineComponent, h } = await import('vue');
	return {
		default: defineComponent({
			name: 'TagsManager',
			inheritAttrs: false,
			setup(_props, { attrs }) {
				mocks.managerAttrs.push(attrs);
				return () => h('div', { 'data-test-id': 'tags-manager-stub' });
			},
		}),
	};
});

const ALL_SCOPES = [
	'annotationTag:list',
	'annotationTag:create',
	'annotationTag:update',
	'annotationTag:delete',
];

const tags = [
	{ id: 'tag-1', name: 'Good', usageCount: 2 },
	{ id: 'tag-2', name: 'Bad', usageCount: 0 },
];

/** A plain copy of the attributes, with camel-case names, sorted, and functions as text. */
function describeAttrs(attrs: Record<string, unknown>) {
	return Object.fromEntries(
		Object.keys(attrs)
			.map((key) => [camelize(key), attrs[key]] as const)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => [
				key,
				typeof value === 'function'
					? '<function>'
					: value !== null && typeof value === 'object' && 'emit' in value
						? '<event bus>'
						: // The snapshot was recorded with a JSON copy, which drops the functions of an object.
							// eslint-disable-next-line n8n-local-rules/no-json-parse-json-stringify
							JSON.parse(JSON.stringify(value ?? null)),
			]),
	);
}

function handler(attrs: Record<string, unknown>, name: string) {
	const key = Object.keys(attrs).find((candidate) => camelize(candidate) === name);
	const value = key ? attrs[key] : undefined;
	if (typeof value !== 'function') throw new Error(`No handler ${name}`);
	return value as (...args: unknown[]) => unknown;
}

let store: ReturnType<typeof mockedStore<typeof useAnnotationTagsStore>>;
let uiStore: ReturnType<typeof mockedStore<typeof useUIStore>>;

beforeEach(() => {
	setActivePinia(createTestingPinia());
	store = mockedStore(useAnnotationTagsStore);
	uiStore = mockedStore(useUIStore);
	store.allTags = tags;
	store.tagsById = Object.fromEntries(tags.map((tag) => [tag.id, tag]));
	store.isLoading = false;
	mocks.scopes = new Set(ALL_SCOPES);
	mocks.dropdownAttrs.length = 0;
	mocks.managerAttrs.length = 0;
	mocks.toasts.length = 0;
});

describe('AnnotationTagsDropdown', () => {
	const lastAttrs = () => mocks.dropdownAttrs[mocks.dropdownAttrs.length - 1];

	it('passes its props, the store state and the permissions to the dropdown', () => {
		const records: Record<string, unknown> = {};

		renderComponent(AnnotationTagsDropdown);
		records.defaults = describeAttrs(lastAttrs());

		renderComponent(AnnotationTagsDropdown, {
			props: {
				placeholder: 'Filter',
				modelValue: ['tag-1'],
				createEnabled: false,
				eventBus: createEventBus(),
			},
			attrs: { id: 'filter-tags', 'data-test-id': 'filter-tags-select' },
		});
		records.withProps = describeAttrs(lastAttrs());

		renderComponent(AnnotationTagsDropdown, { props: { createEnabled: true } });
		records.createEnabled = describeAttrs(lastAttrs());

		mocks.scopes = new Set(['annotationTag:list']);
		renderComponent(AnnotationTagsDropdown);
		records.listOnly = describeAttrs(lastAttrs());

		renderComponent(AnnotationTagsDropdown, { props: { createEnabled: true } });
		records.listOnlyCreateEnabled = describeAttrs(lastAttrs());

		mocks.scopes = new Set(['annotationTag:list', 'annotationTag:delete']);
		renderComponent(AnnotationTagsDropdown, { props: { createEnabled: false } });
		records.deleteOnlyNoCreate = describeAttrs(lastAttrs());

		records.fetchAllCalls = store.fetchAll.mock.calls;

		expect(records).toMatchSnapshot();
	});

	it('creates tags in the store, opens the manager, and passes on the events', async () => {
		const created = { id: 'tag-3', name: 'New' };
		store.create.mockResolvedValue(created);
		const { emitted } = renderComponent(AnnotationTagsDropdown);
		const attrs = lastAttrs();

		const createResult = await handler(attrs, 'createTag')('New');
		handler(attrs, 'onManageTags')();
		handler(attrs, 'onEsc')();
		handler(attrs, 'onBlur')();
		handler(attrs, 'onUpdate:modelValue')(['tag-2']);

		expect({
			createResult,
			createCalls: store.create.mock.calls,
			openModalCalls: uiStore.openModal.mock.calls,
			openModalWithDataCalls: uiStore.openModalWithData.mock.calls,
			emitted: emitted(),
		}).toMatchSnapshot();
	});
});

describe('AnnotationTagsManager', () => {
	const lastAttrs = () => mocks.managerAttrs[mocks.managerAttrs.length - 1];

	it('passes the tags, the texts and the permissions to the manager', () => {
		const records: Record<string, unknown> = {};

		renderComponent(AnnotationTagsManager);
		records.allScopes = describeAttrs(lastAttrs());

		mocks.scopes = new Set(['annotationTag:list', 'annotationTag:update']);
		renderComponent(AnnotationTagsManager);
		records.updateOnly = describeAttrs(lastAttrs());

		store.isLoading = true;
		renderComponent(AnnotationTagsManager);
		records.loading = describeAttrs(lastAttrs());

		expect(records).toMatchSnapshot();
	});

	it('fetches, creates, renames and deletes tags, with the toasts', async () => {
		renderComponent(AnnotationTagsManager);
		const attrs = lastAttrs();
		const outcome = async (call: () => unknown) => {
			try {
				return { result: await call() };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		};
		const records: Record<string, unknown> = {};

		store.fetchAll.mockResolvedValueOnce(tags);
		records.fetch = await outcome(async () => await handler(attrs, 'onFetchTags')());
		store.fetchAll.mockRejectedValueOnce(new Error('fetch failed'));
		records.fetchError = await outcome(async () => await handler(attrs, 'onFetchTags')());

		store.create.mockResolvedValueOnce({ id: 'tag-3', name: 'New' });
		records.create = await outcome(async () => await handler(attrs, 'onCreateTag')('New'));
		store.create.mockRejectedValueOnce(new Error('create failed'));
		records.createError = await outcome(
			async () => await handler(attrs, 'onCreateTag')('<b>Bold</b>'),
		);

		store.rename.mockResolvedValueOnce({ id: 'tag-1', name: 'Great' });
		records.rename = await outcome(
			async () => await handler(attrs, 'onUpdateTag')('tag-1', 'Great'),
		);
		store.rename.mockRejectedValueOnce(new Error('rename failed'));
		records.renameError = await outcome(
			async () => await handler(attrs, 'onUpdateTag')('tag-1', 'Great & Co'),
		);

		store.deleteTagById.mockResolvedValueOnce(true);
		records.delete = await outcome(async () => await handler(attrs, 'onDeleteTag')('tag-2'));
		store.deleteTagById.mockResolvedValueOnce(false);
		records.deleteFalse = await outcome(async () => await handler(attrs, 'onDeleteTag')('tag-1'));
		store.deleteTagById.mockRejectedValueOnce(new Error('delete failed'));
		records.deleteError = await outcome(async () => await handler(attrs, 'onDeleteTag')('unknown'));

		records.fetchAllCalls = store.fetchAll.mock.calls;
		records.createCalls = store.create.mock.calls;
		records.renameCalls = store.rename.mock.calls;
		records.deleteCalls = store.deleteTagById.mock.calls;
		records.toasts = JSON.parse(
			JSON.stringify(mocks.toasts, (_key, value: unknown) =>
				value instanceof Error ? `<Error ${value.message}>` : value,
			),
		);

		expect(records).toMatchSnapshot();
	});
});
