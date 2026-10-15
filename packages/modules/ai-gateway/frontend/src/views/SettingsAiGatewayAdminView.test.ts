import { createComponentRenderer } from '@n8n/frontend-test-utils';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { createTestingPinia } from '@pinia/testing';
import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/vue';

import { overview, priceTable, settingsResponse, topUps, usagePage } from '../__tests__/fixtures';
import type { AiGatewaySettings } from '../ai-gateway.api';
import SettingsAiGatewayAdminView from './SettingsAiGatewayAdminView.vue';

const showMessage = vi.fn();
const showError = vi.fn();
vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({ showMessage, showError }),
}));

const restApiContext = { baseUrl: '', pushRef: '' };
vi.mock('@n8n/stores/useRootStore', () => ({
	useRootStore: () => ({ restApiContext }),
}));

type ApiMock = (...args: unknown[]) => Promise<unknown>;
const api = {
	getAiGatewaySettings: vi.fn<ApiMock>(),
	updateAiGatewaySettings: vi.fn<ApiMock>(),
	getAiGatewayOverview: vi.fn<ApiMock>(),
	getAiGatewayTopUps: vi.fn<ApiMock>(),
	addAiGatewayTopUp: vi.fn<ApiMock>(),
	getAiGatewayPrices: vi.fn<ApiMock>(),
	getAiGatewayUsage: vi.fn<ApiMock>(),
};
vi.mock('../ai-gateway.api', () => ({
	getAiGatewaySettings: async (...args: unknown[]) => await api.getAiGatewaySettings(...args),
	updateAiGatewaySettings: async (...args: unknown[]) => await api.updateAiGatewaySettings(...args),
	getAiGatewayOverview: async (...args: unknown[]) => await api.getAiGatewayOverview(...args),
	getAiGatewayTopUps: async (...args: unknown[]) => await api.getAiGatewayTopUps(...args),
	addAiGatewayTopUp: async (...args: unknown[]) => await api.addAiGatewayTopUp(...args),
	getAiGatewayPrices: async (...args: unknown[]) => await api.getAiGatewayPrices(...args),
	getAiGatewayUsage: async (...args: unknown[]) => await api.getAiGatewayUsage(...args),
}));

function setUp() {
	const pinia = createTestingPinia({ stubActions: false });
	vi.spyOn(useSettingsStore(), 'getSettings').mockResolvedValue();
	createComponentRenderer(SettingsAiGatewayAdminView, { pinia })();
}

/** The settings of the last save. */
const lastSaved = () =>
	api.updateAiGatewaySettings.mock.lastCall?.[1] as Partial<AiGatewaySettings> | undefined;

async function openTab(label: string) {
	await userEvent.click(within(screen.getByTestId('ai-gateway-tabs')).getByText(label));
}

async function pickOption(testId: string, label: string) {
	await userEvent.click(within(screen.getByTestId(testId)).getByRole('combobox'));
	const findOption = () =>
		Array.from(document.querySelectorAll('li.el-select-dropdown__item')).find(
			(item) => item.textContent?.trim() === label,
		);
	await waitFor(() => expect(findOption()).toBeDefined());
	const option = findOption();
	if (option) await userEvent.click(option);
}

/** The text field of an `N8nInput`, which can carry the test id itself. */
function textField(testId: string) {
	const root = screen.getByTestId(testId);
	const input = root instanceof HTMLInputElement ? root : root.querySelector('input');
	if (!input) throw new Error(`No input in ${testId}`);
	return input;
}

/** Types a number into an `N8nInputNumber`, and leaves the field so that it keeps the value. */
async function typeNumber(testId: string, value: string) {
	const root = screen.getByTestId(testId);
	const input = root.querySelector('input');
	if (!input) throw new Error(`No input in ${testId}`);
	await userEvent.clear(input);
	await userEvent.type(input, value);
	await userEvent.tab();
}

beforeEach(() => {
	vi.clearAllMocks();
	api.getAiGatewaySettings.mockResolvedValue(settingsResponse());
	api.updateAiGatewaySettings.mockResolvedValue(settingsResponse());
	api.getAiGatewayOverview.mockResolvedValue(overview());
	api.getAiGatewayTopUps.mockResolvedValue(topUps());
	api.addAiGatewayTopUp.mockResolvedValue(overview());
	api.getAiGatewayPrices.mockResolvedValue(priceTable());
	api.getAiGatewayUsage.mockResolvedValue(usagePage());
});

describe('SettingsAiGatewayAdminView', () => {
	it('shows the state of the gateway and the overview of the month', async () => {
		setUp();

		expect(await screen.findByTestId('ai-gateway-overview')).toBeInTheDocument();
		expect(screen.getByTestId('ai-gateway-status')).toHaveTextContent('On');
		expect(screen.getByTestId('ai-gateway-url')).toHaveTextContent(
			'http://127.0.0.1:5678/ai-gateway',
		);
		expect(screen.getByTestId('ai-gateway-overview-remaining')).toHaveTextContent('$112.6544');
		expect(screen.getByTestId('ai-gateway-overview-user-limit')).toHaveTextContent(
			'Users have no monthly limit.',
		);
		const projects = screen.getByTestId('ai-gateway-overview-projects');
		expect(within(projects).getByText('Team A')).toBeInTheDocument();
		expect(within(projects).getByText('Deleted project')).toBeInTheDocument();
	});

	it('turns the gateway off', async () => {
		setUp();
		// The test id is on the switch button itself.
		await userEvent.click(await screen.findByTestId('ai-gateway-enabled'));

		await waitFor(() => expect(lastSaved()).toMatchObject({ enabled: false }));
		expect(showMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
	});

	it('shows an error when the settings do not load', async () => {
		api.getAiGatewaySettings.mockRejectedValue(new Error('Forbidden'));
		setUp();

		await waitFor(() =>
			expect(showError).toHaveBeenCalledWith(
				expect.any(Error),
				'Could not load the settings of the AI gateway',
			),
		);
		expect(screen.queryByTestId('ai-gateway-tabs')).not.toBeInTheDocument();
	});

	it('saves the credential of a provider', async () => {
		setUp();
		await screen.findByTestId('ai-gateway-tabs');
		await openTab('Providers');

		const google = screen.getByTestId('ai-gateway-provider-google');
		expect(
			within(google).getByText('No credential of the type googlePalmApi / googleApi'),
		).toBeInTheDocument();
		expect(screen.getByTestId('ai-gateway-providers-save')).toBeDisabled();

		await pickOption('ai-gateway-provider-credential-anthropic', 'Org Anthropic');
		await userEvent.click(screen.getByTestId('ai-gateway-providers-save'));

		await waitFor(() =>
			expect(lastSaved()).toMatchObject({
				providers: {
					openai: { credentialId: 'cred-openai' },
					anthropic: { credentialId: 'cred-anthropic' },
				},
			}),
		);
	});

	it('saves an Azure OpenAI credential with its deployments', async () => {
		setUp();
		await screen.findByTestId('ai-gateway-tabs');
		await openTab('Providers');

		expect(screen.queryByTestId('ai-gateway-provider-azure-openai')).not.toBeInTheDocument();
		await pickOption('ai-gateway-provider-credential-openai', 'Org Azure (Azure OpenAI)');
		const deployments = textField('ai-gateway-provider-deployments-openai');
		await userEvent.type(deployments, 'bad/name');
		expect(screen.getByTestId('ai-gateway-provider-invalid-openai')).toBeInTheDocument();
		expect(screen.getByTestId('ai-gateway-providers-save')).toBeDisabled();

		await userEvent.clear(deployments);
		await userEvent.type(deployments, 'gpt-4o, chat-prod,gpt-4o');
		await userEvent.click(screen.getByTestId('ai-gateway-providers-save'));

		await waitFor(() =>
			expect(lastSaved()?.providers).toEqual({
				openai: { credentialId: 'cred-azure', deployments: ['gpt-4o', 'chat-prod'] },
			}),
		);
	});

	it('saves a Vertex AI credential with its project and location', async () => {
		const response = settingsResponse();
		const google = response.providers.find((provider) => provider.slug === 'google');
		google?.credentialOptions.push({
			id: 'cred-vertex',
			name: 'Vertex service account',
			type: 'googleApi',
		});
		api.getAiGatewaySettings.mockResolvedValue(response);
		setUp();
		await screen.findByTestId('ai-gateway-tabs');
		await openTab('Providers');

		await pickOption('ai-gateway-provider-credential-google', 'Vertex service account (Vertex AI)');
		expect(screen.getByTestId('ai-gateway-provider-vertex-google')).toHaveTextContent(
			'Vertex AI has no File API',
		);
		await userEvent.type(textField('ai-gateway-provider-project-google'), 'acme-ai');
		await userEvent.type(textField('ai-gateway-provider-location-google'), 'europe-west4');
		await userEvent.click(screen.getByTestId('ai-gateway-providers-save'));

		await waitFor(() =>
			expect(lastSaved()?.providers).toEqual({
				openai: { credentialId: 'cred-openai' },
				google: { credentialId: 'cred-vertex', projectId: 'acme-ai', location: 'europe-west4' },
			}),
		);
	});

	it('saves the open models of Vertex AI next to an OpenAI credential', async () => {
		setUp();
		await screen.findByTestId('ai-gateway-tabs');
		await openTab('Providers');

		await pickOption('ai-gateway-provider-open-models-credential-openai', 'Org service account');
		await userEvent.type(textField('ai-gateway-provider-open-models-project-openai'), 'acme-ai');
		await userEvent.click(screen.getByTestId('ai-gateway-providers-save'));

		await waitFor(() =>
			expect(lastSaved()?.providers?.openai).toEqual({
				credentialId: 'cred-openai',
				openModels: { credentialId: 'cred-sa', projectId: 'acme-ai' },
			}),
		);
	});

	it('sends all calls of the OpenAI nodes to Vertex AI with a service account', async () => {
		setUp();
		await screen.findByTestId('ai-gateway-tabs');
		await openTab('Providers');

		expect(screen.getByTestId('ai-gateway-provider-open-models-openai')).toBeInTheDocument();
		await pickOption('ai-gateway-provider-credential-openai', 'Org service account (Vertex AI)');
		expect(screen.queryByTestId('ai-gateway-provider-open-models-openai')).not.toBeInTheDocument();
		expect(screen.getByTestId('ai-gateway-provider-vertex-openai')).toHaveTextContent(
			'open models of Vertex AI',
		);
		await userEvent.click(screen.getByTestId('ai-gateway-providers-save'));

		await waitFor(() =>
			expect(lastSaved()?.providers?.openai).toEqual({ credentialId: 'cred-sa' }),
		);
	});

	it('saves the budgets', async () => {
		setUp();
		await screen.findByTestId('ai-gateway-tabs');
		await openTab('Budgets');

		await typeNumber('ai-gateway-monthly-budget', '250');
		await typeNumber('ai-gateway-user-limit', '5');
		await userEvent.click(screen.getByTestId('ai-gateway-budgets-save'));

		await waitFor(() =>
			expect(lastSaved()).toMatchObject({
				monthlyBudget: 250,
				userMonthlyLimit: 5,
				projectBudgets: { 'project-a': 20 },
			}),
		);
	});

	it('adds a top-up', async () => {
		setUp();
		await screen.findByTestId('ai-gateway-tabs');
		await openTab('Top-ups');

		expect(screen.getByTestId('ai-gateway-top-up-list')).toHaveTextContent('owner@example.com');
		expect(screen.getByTestId('ai-gateway-top-up-add')).toBeDisabled();

		await typeNumber('ai-gateway-top-up-amount', '40');
		await userEvent.type(screen.getByTestId('ai-gateway-top-up-note'), 'November');
		await userEvent.click(screen.getByTestId('ai-gateway-top-up-add'));

		await waitFor(() =>
			expect(api.addAiGatewayTopUp).toHaveBeenCalledWith(restApiContext, {
				amount: 40,
				note: 'November',
			}),
		);
		expect(showMessage).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'The top-up is added' }),
		);
	});

	it('lists the prices, sets a price and removes the price of the admin', async () => {
		setUp();
		await screen.findByTestId('ai-gateway-tabs');
		await openTab('Prices');

		const list = screen.getByTestId('ai-gateway-price-list');
		expect(within(list).getByText('gpt-4o')).toBeInTheDocument();
		expect(within(list).getByText('claude-sonnet-4-5')).toBeInTheDocument();
		expect(
			within(screen.getByTestId('ai-gateway-price-openai-gpt-custom')).getByText('Your price'),
		).toBeInTheDocument();
		expect(screen.getByTestId('ai-gateway-price-google-ocr-vision-ocr')).toHaveTextContent(
			'Prices for one million pages or images',
		);
		expect(screen.getByTestId('ai-gateway-price-openai-gpt-4o')).not.toHaveTextContent(
			'pages or images',
		);

		await pickOption('ai-gateway-price-provider', 'Anthropic');
		await userEvent.type(screen.getByTestId('ai-gateway-price-model'), 'claude-new');
		await typeNumber('ai-gateway-price-input', '4');
		await typeNumber('ai-gateway-price-output', '20');
		await userEvent.click(screen.getByTestId('ai-gateway-price-set'));

		await waitFor(() =>
			expect(lastSaved()?.prices).toEqual({
				openai: { 'gpt-custom': { input: 1, output: 2 } },
				anthropic: { 'claude-new': { input: 4, output: 20 } },
			}),
		);

		await userEvent.click(
			within(screen.getByTestId('ai-gateway-price-openai-gpt-custom')).getByRole('button', {
				name: 'Remove your price',
			}),
		);
		await waitFor(() => expect(lastSaved()?.prices).toEqual({}));
	});

	it('lists the calls and filters them by provider', async () => {
		setUp();
		await screen.findByTestId('ai-gateway-tabs');
		await openTab('Usage');

		const table = await screen.findByTestId('ai-gateway-usage-table');
		await within(table).findByText('member@example.com');
		expect(within(table).getByText('Team A')).toBeInTheDocument();
		expect(within(table).getByText('$0.0075')).toBeInTheDocument();

		await pickOption('ai-gateway-usage-provider', 'OpenAI');
		await waitFor(() =>
			expect(api.getAiGatewayUsage).toHaveBeenLastCalledWith(
				restApiContext,
				{ provider: 'openai' },
				0,
				50,
			),
		);
	});
});
