import { createTestingPinia } from '@pinia/testing';
import { createComponentRenderer } from '@/__tests__/render';
import { mockedStore, waitAllPromises } from '@/__tests__/utils';
import { useUsageStore } from '../usage.store';
import SettingsUsageAndPlan from './SettingsUsageAndPlan.vue';
import { useUsersStore } from '@n8n/stores/users.store';
import type { IUser } from '@n8n/rest-api-client/api/users';
import { useToast } from '@n8n/composables/useToast';
import { waitFor } from '@testing-library/vue';
import { useRBACStore } from '@n8n/stores/rbac.store';

vi.mock('@n8n/composables/useToast', () => ({
	useToast: vi.fn(),
}));

vi.mock('@/app/composables/useDocumentTitle', () => ({
	useDocumentTitle: () => ({
		set: vi.fn(),
	}),
}));

let usageStore: ReturnType<typeof mockedStore<typeof useUsageStore>>;
let usersStore: ReturnType<typeof mockedStore<typeof useUsersStore>>;
let rbacStore: ReturnType<typeof mockedStore<typeof useRBACStore>>;
let mockToast: ReturnType<typeof useToast>;

const pinia = createTestingPinia({ stubActions: false });
const renderComponent = createComponentRenderer(SettingsUsageAndPlan, { pinia });

describe('SettingsUsageAndPlan', () => {
	beforeEach(() => {
		usageStore = mockedStore(useUsageStore);
		usersStore = mockedStore(useUsersStore);
		rbacStore = mockedStore(useRBACStore);

		rbacStore.setGlobalScopes([]);

		mockToast = {
			showMessage: vi.fn(),
			showError: vi.fn(),
		} as unknown as ReturnType<typeof useToast>;
		vi.mocked(useToast).mockReturnValue(mockToast);

		usageStore.isLoading = false;
		usageStore.setLoading = vi.fn((value: boolean) => {
			usageStore.isLoading = value;
		});
		usageStore.getLicenseInfo = vi.fn().mockResolvedValue(undefined);
	});

	it('should not throw errors when rendering', async () => {
		expect(() => renderComponent()).not.toThrow();
	});

	it('should render the title only while loading', async () => {
		usageStore.isLoading = true;
		const { getByRole } = renderComponent();
		expect(getByRole('heading', { level: 2 })).toBeInTheDocument();
		expect(getByRole('heading').nextElementSibling).toBeNull();
	});

	// Fork: the page has no unlock notice, also for a user who may register (FORK.md of
	// packages/cli/src/license).
	it('should show the Community edition without a badge or an unlock notice', async () => {
		usageStore.isLoading = false;
		usageStore.planName = 'Community';
		usersStore.currentUser = {
			globalScopes: ['community:register'],
		} as IUser;
		const { getByRole, queryByRole, container } = renderComponent();
		expect(getByRole('heading', { level: 3 })).toHaveTextContent('Community');
		expect(container.querySelector('.n8n-badge')).toBeNull();
		expect(queryByRole('button', { name: 'Unlock' })).toBeNull();
	});

	it('should show community registered badge', async () => {
		usageStore.isLoading = false;
		usageStore.planName = 'Registered Community';
		const { getByRole, getByText } = renderComponent();
		const heading = getByRole('heading', { level: 3 });
		const badgeLabel = getByText('Registered');
		expect(heading).toHaveTextContent('Community Edition');
		expect(heading).toContainElement(badgeLabel);
	});

	it('should render the community registered badge as a direct child of the centering container', async () => {
		usageStore.isLoading = false;
		usageStore.planName = 'Registered Community';
		const { container } = renderComponent();

		const badge = container.querySelector('.n8n-badge');
		// The element that centers the badge against the heading text
		// (`display: flex; align-items: center`).
		const centeringContainer = container.querySelector('.titleTooltip');

		expect(badge).not.toBeNull();
		expect(centeringContainer).not.toBeNull();

		// Only a direct child is a flex item. A tooltip trigger wrapper in between
		// would take the centering instead, and the inline-flex badge would sit on
		// the wrapper's line box baseline rather than on the optical center.
		expect(badge?.parentElement).toBe(centeringContainer);
	});

	// Fork: the fork has no registration of the Community Edition, no licence key entry and no plan
	// links (packages/cli/src/license/FORK.md).
	describe('without registration and licence keys', () => {
		it('should load the licence data on mount', async () => {
			renderComponent();
			await waitAllPromises();

			expect(usageStore.getLicenseInfo).toHaveBeenCalledTimes(1);
			expect(usageStore.isLoading).toBe(false);
		});

		it('should show no buttons, also to a user who may manage the licence', async () => {
			usersStore.currentUser = {
				globalScopes: ['license:manage', 'community:register'],
			} as IUser;
			rbacStore.setGlobalScopes(['license:manage', 'community:register']);

			const { queryAllByRole, queryByText } = renderComponent();
			await waitAllPromises();

			expect(queryAllByRole('button')).toHaveLength(0);
			expect(queryByText(/activation key/i)).toBeNull();
			expect(queryByText(/plans/i)).toBeNull();
		});

		it.each([
			[true, true],
			[false, false],
		])(
			'should tell that the fork switch turns the features on: %s',
			async (forkFeaturesEnabled, shown) => {
				usageStore.forkFeaturesEnabled = forkFeaturesEnabled;

				const { queryByTestId } = renderComponent();
				await waitAllPromises();

				expect(Boolean(queryByTestId('usage-fork-features'))).toBe(shown);
			},
		);

		it('should show an error when the licence data does not load', async () => {
			usageStore.getLicenseInfo = vi.fn().mockRejectedValue(new Error('Request failed'));

			renderComponent();

			await waitFor(() => {
				expect(mockToast.showError).toHaveBeenCalledWith(expect.any(Error), 'Error', {
					message: 'Request failed',
				});
			});
		});
	});
});
