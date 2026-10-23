import { createComponentRenderer } from '@n8n/frontend-test-utils';
import type { Scope } from '@n8n/permissions';
import type { IUser } from '@n8n/rest-api-client/api/users';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';
import { createTestingPinia } from '@pinia/testing';
import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/vue';

import type { AuditLogEvent, AuditLogEventsPage } from '../audit-log.api';
import { useAuditLogStore } from '../audit-log.store';
import SettingsAuditLogView from './SettingsAuditLogView.vue';

const showError = vi.fn();
vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({ showMessage: vi.fn(), showError }),
}));

const restApiContext = { baseUrl: '', pushRef: '' };
vi.mock('@n8n/stores/useRootStore', () => ({
	useRootStore: () => ({ restApiContext }),
}));

type ApiMock = (...args: unknown[]) => Promise<unknown>;
const getEventsMock = vi.fn<ApiMock>();
const getEventNamesMock = vi.fn<ApiMock>();
const exportMock = vi.fn<ApiMock>();
vi.mock('../audit-log.api', () => ({
	getAuditLogEvents: async (...args: unknown[]) => await getEventsMock(...args),
	getAuditLogEventNames: async (...args: unknown[]) => await getEventNamesMock(...args),
	exportAuditLog: async (...args: unknown[]) => await exportMock(...args),
}));

const saveFileMock = vi.fn();
vi.mock('../audit-log.utils', async (importOriginal) => ({
	...(await importOriginal<object>()),
	saveFile: (...args: unknown[]) => saveFileMock(...args),
}));

const login: AuditLogEvent = {
	id: 'e2',
	eventName: 'n8n.audit.user.login.success',
	timestamp: '2026-10-02T08:00:00.000Z',
	userId: 'user-1',
	userEmail: 'ann@example.com',
	projectId: null,
	projectType: null,
	payload: { userId: 'user-1', _email: 'ann@example.com', authenticationMethod: 'email' },
};

const installed: AuditLogEvent = {
	id: 'e1',
	eventName: 'n8n.audit.package.installed',
	timestamp: '2026-10-01T08:00:00.000Z',
	userId: null,
	userEmail: null,
	projectId: null,
	projectType: null,
	payload: {},
};

const workflowUpdated: AuditLogEvent = {
	id: 'e3',
	eventName: 'n8n.audit.workflow.updated',
	timestamp: '2026-10-03T08:00:00.000Z',
	userId: 'user-1',
	userEmail: 'ann@example.com',
	projectId: 'project-1',
	projectType: 'personal',
	payload: { userId: 'user-1', workflowId: 'wf-1' },
};

const page = (events: AuditLogEvent[]): AuditLogEventsPage => ({ count: events.length, events });

const ann = {
	id: 'user-1',
	firstName: 'Ann',
	lastName: 'Lee',
	email: 'ann@example.com',
	isPending: false,
} as IUser;

function setUp({
	scopes = ['auditLogs:manage'],
	retentionDays,
}: { scopes?: Scope[]; retentionDays?: number } = {}) {
	const pinia = createTestingPinia({ stubActions: false });
	useRBACStore().setGlobalScopes(scopes);
	if (retentionDays !== undefined) {
		useSettingsStore().$patch({ moduleSettings: { 'audit-log': { retentionDays } } });
	}
	const usersStore = useUsersStore();
	usersStore.addUsers([ann]);
	const fetchUsers = vi.fn(async () => {});
	usersStore.fetchUsers = fetchUsers;
	return { pinia, fetchUsers };
}

const render = (pinia: ReturnType<typeof createTestingPinia>) =>
	createComponentRenderer(SettingsAuditLogView, { pinia })();

/** Waits until the table shows the first event. */
async function waitForList() {
	const table = await screen.findByTestId('audit-log-table');
	await within(table).findByText(login.eventName);
}

/** The filters of the last request for the list. */
const lastFilters = () => getEventsMock.mock.lastCall?.[1];

async function pickOption(testId: string, label: string) {
	await userEvent.click(within(screen.getByTestId(testId)).getByRole('combobox'));
	await waitFor(() => {
		const option = Array.from(document.querySelectorAll('li.el-select-dropdown__item')).find(
			(item) => item.textContent?.trim() === label,
		);
		expect(option).toBeDefined();
	});
	const option = Array.from(document.querySelectorAll('li.el-select-dropdown__item')).find(
		(item) => item.textContent?.trim() === label,
	);
	if (option) await userEvent.click(option);
}

beforeEach(() => {
	vi.clearAllMocks();
	getEventsMock.mockResolvedValue(page([login, installed]));
	getEventNamesMock.mockResolvedValue([
		'n8n.audit.user.login.success',
		'n8n.audit.user.login.failed',
		'n8n.audit.package.installed',
	]);
});

describe('SettingsAuditLogView', () => {
	it('lists the events, newest first, with the event and the user', async () => {
		const { pinia } = setUp();
		render(pinia);

		const table = await screen.findByTestId('audit-log-table');
		await waitFor(() => expect(within(table).getByText(login.eventName)).toBeInTheDocument());
		expect(getEventsMock).toHaveBeenCalledWith(restApiContext, {}, 0, 50);

		const rows = within(table).getAllByRole('row').slice(1);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toHaveTextContent('n8n.audit.user.login.success');
		expect(rows[0]).toHaveTextContent('ann@example.com');
		expect(rows[0]).toHaveTextContent('2026');
		expect(rows[1]).toHaveTextContent('n8n.audit.package.installed');
		expect(rows[1]).toHaveTextContent('—');
	});

	it('reads the next page', async () => {
		getEventsMock.mockResolvedValue({ count: 120, events: [login, installed] });
		const { pinia } = setUp();
		render(pinia);
		await waitForList();

		await userEvent.click(screen.getByTestId('pagination-next'));

		await waitFor(() => expect(getEventsMock).toHaveBeenLastCalledWith(restApiContext, {}, 50, 50));
		expect(getEventsMock).toHaveBeenCalledTimes(2);
	});

	it.each([
		[90, 'n8n keeps each event for 90 days.'],
		[1, 'n8n keeps each event for 1 day.'],
		[0, 'n8n keeps all events.'],
	])('tells how long the audit log keeps an event: %s days', async (retentionDays, text) => {
		const { pinia } = setUp({ retentionDays });
		render(pinia);

		expect(await screen.findByText(text, { exact: false })).toBeInTheDocument();
	});

	it('filters by an event group and clears the filters', async () => {
		const { pinia } = setUp();
		render(pinia);
		await waitForList();

		await pickOption('audit-log-event-filter', 'n8n.audit.user.*');

		await waitFor(() => expect(lastFilters()).toEqual({ eventName: 'n8n.audit.user.' }));
		expect(getEventsMock.mock.lastCall?.[2]).toBe(0);

		await userEvent.click(screen.getByTestId('audit-log-clear-filters'));

		await waitFor(() => expect(lastFilters()).toEqual({}));
		expect(screen.queryByTestId('audit-log-clear-filters')).not.toBeInTheDocument();
	});

	it('filters by a user', async () => {
		const { pinia, fetchUsers } = setUp({ scopes: ['auditLogs:manage', 'user:list'] });
		render(pinia);
		await waitForList();
		expect(fetchUsers).toHaveBeenCalledWith({ take: 20, filter: undefined });

		await pickOption('audit-log-user-filter', 'Ann Lee (ann@example.com)');

		await waitFor(() => expect(lastFilters()).toEqual({ userId: 'user-1' }));
	});

	it('shows the project of each event, and filters by personal spaces', async () => {
		getEventsMock.mockResolvedValue(page([workflowUpdated, login]));
		const { pinia } = setUp();
		render(pinia);
		const table = await screen.findByTestId('audit-log-table');
		await within(table).findByText(workflowUpdated.eventName);

		const rows = within(table).getAllByRole('row').slice(1);
		expect(rows[0]).toHaveTextContent('Personal space');
		expect(within(rows[0]).getByTitle('project-1')).toBeInTheDocument();
		expect(rows[1]).not.toHaveTextContent('Personal space');

		await pickOption('audit-log-project-filter', 'Personal spaces');

		await waitFor(() => expect(lastFilters()).toEqual({ projectType: 'personal' }));

		await pickOption('audit-log-project-filter', 'Team projects');

		await waitFor(() => expect(lastFilters()).toEqual({ projectType: 'team' }));
	});

	it('hides the user filter from a user who cannot list users', async () => {
		const { pinia, fetchUsers } = setUp();
		render(pinia);
		await waitForList();

		expect(screen.queryByTestId('audit-log-user-filter')).not.toBeInTheDocument();
		expect(fetchUsers).not.toHaveBeenCalled();
	});

	it('shows the date range of the filter', async () => {
		const { pinia } = setUp();
		render(pinia);

		expect(await screen.findByTestId('audit-log-date-filter')).toHaveTextContent('Any time');
	});

	it('shows the details of an event', async () => {
		const { pinia } = setUp();
		render(pinia);

		await userEvent.click(await screen.findByTestId('audit-log-details-e2'));

		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText('Event details')).toBeInTheDocument();
		expect(within(dialog).getByTestId('audit-log-event-details-email')).toHaveTextContent(
			'ann@example.com',
		);
		expect(within(dialog).getByTestId('audit-log-event-details-id')).toHaveTextContent('e2');
		expect(within(dialog).getByTestId('audit-log-event-details-project')).toHaveTextContent('—');
		expect(within(dialog).getByTestId('audit-log-event-details-payload')).toHaveTextContent(
			'"authenticationMethod": "email"',
		);
	});

	it('exports the events that match the filters', async () => {
		const file = { blob: new Blob(['[]']), fileName: 'audit-log-2026-10-11.csv' };
		exportMock.mockResolvedValue(file);
		const { pinia } = setUp();
		useAuditLogStore(pinia).setFilters({ eventName: 'n8n.audit.user.' });
		render(pinia);

		await userEvent.click(await screen.findByTestId('audit-log-export-button'));
		await userEvent.click(await screen.findByTestId('audit-log-export-item-csv'));

		await waitFor(() => expect(saveFileMock).toHaveBeenCalledWith(file.blob, file.fileName));
		expect(exportMock).toHaveBeenCalledWith(
			restApiContext,
			{ eventName: 'n8n.audit.user.' },
			'csv',
		);
	});

	it('shows an error when the export fails', async () => {
		const error = new Error('Forbidden');
		exportMock.mockRejectedValue(error);
		const { pinia } = setUp();
		render(pinia);

		await userEvent.click(await screen.findByTestId('audit-log-export-button'));
		await userEvent.click(await screen.findByTestId('audit-log-export-item-json'));

		await waitFor(() =>
			expect(showError).toHaveBeenCalledWith(error, "Couldn't export the audit log"),
		);
		expect(saveFileMock).not.toHaveBeenCalled();
	});

	it('shows an error when the list cannot load', async () => {
		const error = new Error('Database is down');
		getEventsMock.mockRejectedValue(error);
		const { pinia } = setUp();
		render(pinia);

		await waitFor(() =>
			expect(showError).toHaveBeenCalledWith(error, "Couldn't load the audit log"),
		);
	});

	it('tells when there are no events yet', async () => {
		getEventsMock.mockResolvedValue(page([]));
		const { pinia } = setUp();
		render(pinia);

		expect(await screen.findByTestId('audit-log-empty')).toHaveTextContent('No audit events yet');
	});

	it('tells when no events match the filters', async () => {
		getEventsMock.mockResolvedValue(page([]));
		const { pinia } = setUp();
		useAuditLogStore(pinia).setFilters({ eventName: 'n8n.audit.user.' });
		render(pinia);

		expect(await screen.findByTestId('audit-log-empty')).toHaveTextContent(
			'No events match the filters',
		);
	});
});
