// The behaviour of the base class of the secrets providers: the states around connect(), the
// errors of doConnect(), and the connect timeout. The tests build small providers on the base
// class, as the test helper of the ordinary tests does. The snapshot records what the base class
// does, so a change in behaviour shows up as a snapshot diff.
// packages/cli/src/modules/external-secrets/FORK.md tells how the fork made the snapshot.
const timeouts = vi.hoisted(() => {
	process.env.N8N_EXTERNAL_SECRETS_CONNECT_TIMEOUT = '1';
	process.env.N8N_EXTERNAL_SECRETS_REFRESH_TIMEOUT = '2';
	return { connectMs: 1000 };
});

import { sleep } from '@n8n/utils/sleep';
import type { IDataObject, INodeProperties } from 'n8n-workflow';

// The code under test. To record the snapshot against the original files in a checkout of upstream
// n8n, point this import at `@/modules/external-secrets.ee/types`.
import { SecretsProvider, type SecretsProviderSettings } from '@/modules/external-secrets/types';

import { outcome } from './fakes/drive';

function makeProvider(doConnect: (provider: SecretsProvider) => Promise<void>) {
	class TestProvider extends SecretsProvider {
		properties: INodeProperties[] = [];

		displayName = 'Test Provider';

		name = 'test';

		async init(_settings: SecretsProviderSettings<IDataObject>): Promise<void> {}

		protected async doConnect(): Promise<void> {
			await doConnect(this);
		}

		async disconnect(): Promise<void> {}

		async update(): Promise<void> {}

		async test(): Promise<[boolean] | [boolean, string]> {
			return [true];
		}

		getSecret(_name: string): IDataObject | undefined {
			return undefined;
		}

		hasSecret(_name: string): boolean {
			return false;
		}

		getSecretNames(): string[] {
			return [];
		}
	}
	return new TestProvider();
}

/** Elapsed time in steps of 500 ms, to keep the snapshot stable. */
const elapsed = (start: number) => `${Math.round((Date.now() - start) / 500) * 500} ms`;

describe('SecretsProvider', () => {
	test('a connect that succeeds', async () => {
		const seen: string[] = [];
		const provider = makeProvider(async (self) => {
			seen.push(self.state);
			await sleep(50);
			seen.push(self.state);
		});
		const before = provider.state;
		const result = await outcome(async () => await provider.connect());
		expect({ before, during: seen, result, after: provider.state }).toMatchSnapshot();
	});

	test('a connect that throws an error', async () => {
		const provider = makeProvider(async () => {
			throw new Error('Connection failed');
		});
		const result = await outcome(async () => await provider.connect());
		expect({ result, after: provider.state }).toMatchSnapshot();
	});

	test('a connect that throws a value that is not an error', async () => {
		const provider = makeProvider(async () => {
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw 'plain text';
		});
		const result = await outcome(async () => await provider.connect());
		expect({ result, after: provider.state }).toMatchSnapshot();
	});

	test('a connect that does not end', async () => {
		const provider = makeProvider(async () => await new Promise<void>(() => {}));
		const start = Date.now();
		const result = await outcome(async () => await provider.connect());
		expect({ result, after: provider.state, elapsed: elapsed(start) }).toMatchSnapshot();
	});

	test('a connect that ends after the timeout', async () => {
		const provider = makeProvider(async () => await sleep(timeouts.connectMs + 500));
		const start = Date.now();
		const result = await outcome(async () => await provider.connect());
		const afterConnect = provider.state;
		const time = elapsed(start);
		await sleep(1000);
		expect({ result, afterConnect, elapsed: time, later: provider.state }).toMatchSnapshot();
	});

	test('a second connect after an error', async () => {
		let fail = true;
		const provider = makeProvider(async () => {
			if (fail) throw new Error('first connect fails');
		});
		await provider.connect();
		const afterFirst = provider.state;
		fail = false;
		await provider.connect();
		expect({ afterFirst, afterSecond: provider.state }).toMatchSnapshot();
	});
});
