// Fork test (not in upstream n8n): a black-box record of the parts of the source control editor that
// ordinary code uses: the store, the modal keys, the event bus, the settings page without the
// licence feature and the start-up error message. The snapshot was recorded against the
// enterprise files, and the fork files give the same snapshot. See `../../FORK.md`.
import { fireEvent } from '@testing-library/vue';

import { createComponentRenderer } from '@/__tests__/render';
import {
	describeDom,
	finishPages,
	installRecorders,
	pinia,
	plain,
	route,
	router,
	ServerError,
	settle,
	setUnmount,
	setup,
	takeLog,
} from '@/features/ai/evaluation/__tests__/golden/harness';

import * as subject from './subject';

const PREFERENCES = {
	branchName: 'main',
	branchReadOnly: true,
	branchColor: '#ff0000',
	connected: true,
	repositoryUrl: 'git@github.com:acme/flows.git',
	publicKey: 'ssh-ed25519 AAA',
	keyGeneratorType: 'ed25519',
	connectionType: 'ssh',
	branches: ['main', 'dev'],
};

const licence = (sourceControl?: boolean) => ({
	enterprise: sourceControl === undefined ? {} : { sourceControl },
});

async function outcome(run: () => unknown) {
	try {
		return { result: plain(await run()) };
	} catch (error) {
		return {
			error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
		};
	}
}

/** The requests and the other effects since the last call. */
const effects = () => takeLog();

let container: Element;

async function mount(component: Parameters<typeof createComponentRenderer>[0]) {
	const rendered = createComponentRenderer(component, { global: { plugins: [router] } })({ pinia });
	setUnmount(rendered.unmount);
	container = rendered.container;
	await settle();
}

const button = (text: string) =>
	[...container.querySelectorAll('button, a')].find(
		(element) => element.textContent?.trim() === text,
	);

beforeEach(() => {
	installRecorders();
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(finishPages);

describe('the source control editor', () => {
	test('the store', async () => {
		const result: Record<string, unknown> = {};

		for (const [name, flag] of [
			['without enterprise settings', undefined],
			['without the licence feature', false],
			['with the licence feature', true],
		] as const) {
			await setup({ settings: licence(flag) });
			const store = subject.useSourceControlStore();
			result[name] = {
				id: store.$id,
				isEnterpriseSourceControlEnabled: store.isEnterpriseSourceControlEnabled,
				preferences: plain(store.preferences),
			};
		}

		await setup({ settings: licence(true) });
		const store = subject.useSourceControlStore();
		route('GET', /^\/source-control\/preferences$/, () => PREFERENCES);
		result['getPreferences'] = {
			outcome: await outcome(async () => await store.getPreferences()),
			preferences: plain(store.preferences),
			effects: effects(),
		};
		route('GET', /^\/source-control\/preferences$/, () => ({ branchName: 'dev' }));
		result['getPreferences with some fields'] = {
			outcome: await outcome(async () => await store.getPreferences()),
			preferences: plain(store.preferences),
			effects: effects(),
		};
		route('GET', /^\/source-control\/preferences$/, () => {
			throw new ServerError(404, 'Not found');
		});
		result['getPreferences without the route'] = {
			outcome: await outcome(async () => await store.getPreferences()),
			preferences: plain(store.preferences),
			effects: effects(),
		};

		await setup({ settings: licence(true) });
		const fresh = subject.useSourceControlStore();
		fresh.setPreferences({ branchName: 'x', connected: true });
		result['setPreferences'] = { preferences: plain(fresh.preferences), effects: effects() };

		route('GET', /^\/source-control\/remote-content\/workflow\/(.+)$/, (_request, match) => ({
			content: { id: match[1], name: 'Remote', nodes: [], connections: {} },
			type: 'workflow',
		}));
		result['getRemoteWorkflow'] = {
			outcome: await outcome(async () => await fresh.getRemoteWorkflow('w1')),
			effects: effects(),
		};
		route('GET', /^\/source-control\/remote-content\/workflow\/(.+)$/, () => {
			throw new ServerError(404, 'Not found');
		});
		result['getRemoteWorkflow without the route'] = {
			outcome: await outcome(async () => await fresh.getRemoteWorkflow('w2')),
			effects: effects(),
		};

		route('POST', /^\/source-control\/pull-workfolder$/, () => [
			{ id: 'w1', name: 'A', type: 'workflow', status: 'modified' },
		]);
		result['pullWorkfolder with force and no publish'] = {
			outcome: await outcome(async () => await fresh.pullWorkfolder(true, 'none')),
			effects: effects(),
		};
		result['pullWorkfolder without the publish mode'] = {
			outcome: await outcome(async () => await fresh.pullWorkfolder(false)),
			effects: effects(),
		};
		route('POST', /^\/source-control\/pull-workfolder$/, () => {
			throw new ServerError(409, 'Conflict');
		});
		result['pullWorkfolder with a conflict'] = {
			outcome: await outcome(async () => await fresh.pullWorkfolder(false, 'all')),
			effects: effects(),
		};

		expect(result).toMatchSnapshot();
	});

	test('the modal keys and the event bus', async () => {
		const calls: unknown[] = [];
		const bus = subject.sourceControlEventBus;
		const first = (payload: unknown) => calls.push(['first', payload]);
		const once = (payload: unknown) => calls.push(['once', payload]);
		bus.on('pull', first);
		bus.once('pull', once);
		bus.emit('pull', { id: 1 });
		bus.emit('pull', { id: 2 });
		bus.off('pull', first);
		bus.emit('pull', { id: 3 });

		expect({
			modalKeys: {
				pull: subject.SOURCE_CONTROL_PULL_MODAL_KEY,
				pullResult: subject.SOURCE_CONTROL_PULL_RESULT_MODAL_KEY,
				push: subject.SOURCE_CONTROL_PUSH_MODAL_KEY,
			},
			eventBusMembers: Object.keys(bus).sort(),
			calls,
		}).toMatchSnapshot();
	});

	test('the settings page without the licence feature', async () => {
		const result: Record<string, unknown> = {};
		for (const [name, flag] of [
			['without enterprise settings', undefined],
			['without the licence feature', false],
		] as const) {
			await setup({ settings: licence(flag), path: '/settings' });
			await mount(subject.SettingsSourceControl);
			result[name] = { page: describeDom(container), effects: effects() };
		}

		const seePlans = button('See plans');
		if (seePlans) await fireEvent.click(seePlans);
		await settle();
		result['See plans'] = { found: !!seePlans, effects: effects() };

		expect(result).toMatchSnapshot();
	});

	test('the start-up error message', async () => {
		await setup({ settings: licence(true), path: '/home/workflows' });
		await mount(subject.SourceControlInitializationErrorMessage);
		const result: Record<string, unknown> = { message: describeDom(container), effects: effects() };

		const link = button('Git configuration');
		if (link) await fireEvent.click(link);
		await settle();
		result['Git configuration'] = {
			found: !!link,
			route: router.currentRoute.value.fullPath,
			effects: effects(),
		};

		expect(result).toMatchSnapshot();
	});
});
