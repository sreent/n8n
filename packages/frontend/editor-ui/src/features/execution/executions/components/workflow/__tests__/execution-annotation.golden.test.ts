// Fork test (not in upstream n8n): the annotation tags and the highlighted data of an execution in
// the execution preview, as black boxes. The inner `TagsDropdown` is a stub that records what it
// gets, and the test calls the handlers that it gets. The snapshot records the HTML, the store
// calls and the toasts. packages/cli/src/executions/FORK.md tells how the fork made the snapshot.
import { defaultSettings } from '@n8n/frontend-test-utils';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { createTestingPinia } from '@pinia/testing';
import { fireEvent } from '@testing-library/vue';
import { setActivePinia } from 'pinia';
import { camelize, computed, nextTick } from 'vue';

import { renderComponent } from '@/__tests__/render';
import { mockedStore } from '@/__tests__/utils';
import { WorkflowIdKey } from '@/app/constants/injectionKeys';
import { useWorkflowsListStore } from '@/app/stores/workflowsList.store';
import { useUIStore } from '@/app/stores/ui.store';
import { useExecutionsStore } from '@/features/execution/executions/executions.store';
import { useAnnotationTagsStore } from '@/features/shared/tags/tags.store';

// The modules under test.
import WorkflowExecutionAnnotationPanel from '../WorkflowExecutionAnnotationPanel.vue';
import WorkflowExecutionAnnotationTags from '../WorkflowExecutionAnnotationTags.vue';

const mocks = vi.hoisted(() => ({
	dropdownAttrs: [] as Array<Record<string, unknown>>,
	toasts: [] as Array<[string, unknown[]]>,
}));

vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({
		showError: (...args: unknown[]) => mocks.toasts.push(['showError', args]),
		showMessage: (...args: unknown[]) => mocks.toasts.push(['showMessage', args]),
	}),
}));

vi.mock('@/features/shared/tags/components/TagsDropdown.vue', async () => {
	const { defineComponent, h } = await import('vue');
	return {
		default: defineComponent({
			name: 'TagsDropdown',
			inheritAttrs: false,
			setup(_props, { attrs }) {
				mocks.dropdownAttrs.push(attrs);
				return () =>
					h('div', {
						'data-test-id': 'tags-dropdown-stub',
						'data-model-value': JSON.stringify(attrs.modelValue ?? attrs['model-value'] ?? null),
					});
			},
		}),
	};
});

const tags = [
	{ id: 'tag-1', name: 'Good' },
	{ id: 'tag-2', name: 'Bad' },
	{ id: 'tag-3', name: 'Later' },
];

const execution = {
	id: '42',
	finished: true,
	mode: 'manual',
	status: 'success',
	createdAt: '2026-01-02T03:04:05.000Z',
	startedAt: '2026-01-02T03:04:05.000Z',
	stoppedAt: '2026-01-02T03:04:06.000Z',
	workflowId: 'wf-1',
	scopes: [],
	annotation: { vote: 'up', tags: [tags[0], tags[1]] },
	customData: { orderId: 'A-1', customer: 'Acme Corp' },
};

/**
 * The HTML without the generated element ids, and without `outline="false"`: an attribute that
 * the button does not use, so it changes nothing that a user sees.
 */
function html(value: string) {
	return value
		.replace(/el-id-\d+-\d+/g, 'el-id-*')
		.replace(/el-popper-container-\d+/g, 'el-popper-*')
		.replace(/ outline="false"/g, '');
}

/** The attributes, without the ones that are `undefined`: the dropdown treats them as absent. */
function describeAttrs(attrs: Record<string, unknown>) {
	return Object.fromEntries(
		Object.keys(attrs)
			.filter((key) => attrs[key] !== undefined)
			.map((key) => [camelize(key), attrs[key]] as const)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => [
				key,
				// The snapshot was recorded with a JSON copy, which drops the functions of an object.
				// eslint-disable-next-line n8n-local-rules/no-json-parse-json-stringify
				typeof value === 'function' ? '<function>' : JSON.parse(JSON.stringify(value ?? null)),
			]),
	);
}

function handler(attrs: Record<string, unknown>, name: string) {
	const key = Object.keys(attrs).find((candidate) => camelize(candidate) === name);
	const value = key ? attrs[key] : undefined;
	if (typeof value !== 'function') throw new Error(`No handler ${name}`);
	return value as (...args: unknown[]) => unknown;
}

const provideWorkflowId = { [WorkflowIdKey as unknown as string]: computed(() => 'wf-1') };

let executionsStore: ReturnType<typeof mockedStore<typeof useExecutionsStore>>;
let tagsStore: ReturnType<typeof mockedStore<typeof useAnnotationTagsStore>>;
let uiStore: ReturnType<typeof mockedStore<typeof useUIStore>>;

function setUp({ canUpdate = true, featureEnabled = true } = {}) {
	setActivePinia(createTestingPinia());
	const settingsStore = useSettingsStore();
	settingsStore.settings = {
		...defaultSettings,
		enterprise: { ...defaultSettings.enterprise, advancedExecutionFilters: featureEnabled },
	};
	tagsStore = mockedStore(useAnnotationTagsStore);
	uiStore = mockedStore(useUIStore);
	tagsStore.allTags = tags;
	tagsStore.tagsById = Object.fromEntries(tags.map((tag) => [tag.id, tag]));
	const workflowsListStore = mockedStore(useWorkflowsListStore);
	workflowsListStore.getWorkflowById.mockReturnValue({
		id: 'wf-1',
		name: 'Invoices',
		scopes: canUpdate ? ['workflow:read', 'workflow:update'] : ['workflow:read'],
	} as never);
	executionsStore = mockedStore(useExecutionsStore);
	mocks.dropdownAttrs.length = 0;
	mocks.toasts.length = 0;
}

describe('WorkflowExecutionAnnotationTags', () => {
	const render = (props: Record<string, unknown>) =>
		renderComponent(WorkflowExecutionAnnotationTags, {
			props,
			global: { provide: provideWorkflowId },
		});
	const lastAttrs = () => mocks.dropdownAttrs[mocks.dropdownAttrs.length - 1];

	it('shows the tags, or a button to add the first one', () => {
		setUp();
		const records: Record<string, unknown> = {};

		records.withTags = html(render({ execution }).html());
		records.withoutAnnotation = html(
			render({ execution: { ...execution, annotation: undefined } }).html(),
		);
		records.withoutTags = html(
			render({ execution: { ...execution, annotation: { vote: null, tags: [] } } }).html(),
		);

		setUp({ canUpdate: false });
		records.withoutUpdateScope = html(render({ execution }).html());

		setUp({ featureEnabled: false });
		records.featureOff = html(render({ execution }).html());

		expect(records).toMatchSnapshot();
	});

	it('edits the tags in the dropdown, and saves them on blur', async () => {
		setUp();
		const view = render({ execution });
		const records: Record<string, unknown> = {};

		await fireEvent.click(view.getByTestId('new-tag-link'));
		records.editing = html(view.html());
		records.dropdownAttrs = describeAttrs(lastAttrs());

		handler(lastAttrs(), 'onUpdate:modelValue')(['tag-2', 'tag-3']);
		await nextTick();
		records.afterChange = html(view.html());

		await handler(lastAttrs(), 'onBlur')();
		await nextTick();
		records.afterBlur = html(view.html());
		records.annotateCalls = executionsStore.annotateExecution.mock.calls;
		records.toasts = mocks.toasts;

		expect(records).toMatchSnapshot();
	});

	it('creates and manages tags from the dropdown, and saves on blur without a change', async () => {
		setUp();
		tagsStore.create.mockResolvedValue({ id: 'tag-4', name: 'New' });
		const view = render({ execution });
		const records: Record<string, unknown> = {};
		records.fetchAllCallsBeforeEdit = [...tagsStore.fetchAll.mock.calls];

		await fireEvent.click(view.getByTestId('new-tag-link'));
		records.fetchAllCallsAfterEdit = [...tagsStore.fetchAll.mock.calls];
		records.createResult = await handler(lastAttrs(), 'createTag')('New');
		records.createCalls = tagsStore.create.mock.calls;
		handler(lastAttrs(), 'onManageTags')();
		records.openModalCalls = uiStore.openModal.mock.calls;
		records.openModalWithDataCalls = uiStore.openModalWithData.mock.calls;

		await handler(lastAttrs(), 'onBlur')();
		await nextTick();
		records.annotateCallsWithoutChange = executionsStore.annotateExecution.mock.calls;
		records.afterBlur = html(view.html());

		expect(records).toMatchSnapshot();
	});

	it('cancels the edit on escape, and edits on a click on a tag', async () => {
		setUp();
		const view = render({ execution });
		const records: Record<string, unknown> = {};

		await fireEvent.click(view.getByTestId('new-tag-link'));
		handler(lastAttrs(), 'onUpdate:modelValue')(['tag-3']);
		await handler(lastAttrs(), 'onEsc')();
		await nextTick();
		records.afterEscape = html(view.html());
		records.annotateCallsAfterEscape = [...executionsStore.annotateExecution.mock.calls];

		const firstTag = view.container.querySelector('.clickable');
		if (firstTag) await fireEvent.click(firstTag);
		await nextTick();
		records.afterTagClick = html(view.html());

		expect(records).toMatchSnapshot();
	});

	it('shows a toast when the save fails', async () => {
		setUp();
		executionsStore.annotateExecution.mockRejectedValueOnce(new Error('save failed'));
		const view = render({ execution: { ...execution, annotation: undefined } });

		await fireEvent.click(view.getByTestId('new-tag-link'));
		handler(lastAttrs(), 'onUpdate:modelValue')(['tag-1']);
		await handler(lastAttrs(), 'onBlur')();
		await nextTick();

		expect({
			afterFailedSave: html(view.html()),
			annotateCalls: executionsStore.annotateExecution.mock.calls,
			toasts: JSON.parse(
				JSON.stringify(mocks.toasts, (_key, value: unknown) =>
					value instanceof Error ? `<Error ${value.message}>` : value,
				),
			),
		}).toMatchSnapshot();
	});
});

describe('WorkflowExecutionAnnotationPanel', () => {
	const render = (props: Record<string, unknown>) =>
		renderComponent(WorkflowExecutionAnnotationPanel, {
			props,
			global: { provide: provideWorkflowId },
		});

	it('shows the button with the number of highlighted values', () => {
		const records: Record<string, unknown> = {};

		setUp();
		records.withData = html(render({ execution }).html());
		records.withoutData = html(render({ execution: { ...execution, customData: {} } }).html());
		records.noCustomDataKey = html(
			render({ execution: { ...execution, customData: undefined } }).html(),
		);

		setUp({ canUpdate: false });
		records.withoutUpdateScope = html(render({ execution }).html());

		setUp({ featureEnabled: false });
		records.featureOff = html(render({ execution }).html());

		expect(records).toMatchSnapshot();
	});

	it('lists the highlighted values when open', async () => {
		const records: Record<string, unknown> = {};

		setUp();
		const view = render({ execution });
		await fireEvent.click(view.getByTestId('execution-preview-ellipsis-button'));
		await new Promise((resolve) => setTimeout(resolve, 300));
		records.button = html(view.html());
		records.panel = html(
			document.querySelector('[data-test-id="execution-annotation-panel"]')?.outerHTML ?? '<none>',
		);
		view.unmount();

		setUp();
		const empty = render({ execution: { ...execution, customData: {} } });
		await fireEvent.click(empty.getByTestId('execution-preview-ellipsis-button'));
		await new Promise((resolve) => setTimeout(resolve, 300));
		records.emptyPanel = html(
			document.querySelector('[data-test-id="execution-annotation-panel"]')?.outerHTML ?? '<none>',
		);

		expect(records).toMatchSnapshot();
	});
});
