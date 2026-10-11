// Fork test (not in upstream n8n): the behaviour of the REST clients of external secrets. Each
// export gets calls with probe arguments: texts, objects, and a text with special characters. The
// snapshot records the request that axios gets, and what the export gives for an answer of the
// server, or for an error of the server.
// packages/frontend/editor-ui/src/features/integrations/externalSecrets/FORK.md tells how the
// fork made the snapshot.
import axios from 'axios';

import type { IRestApiContext } from '../../types';

// The code under test. To record the snapshot against the original files, point these imports at
// `../externalSecrets.ee` and `../secretsProvider.ee`.
import * as externalSecretsApi from '../externalSecrets';
import * as secretsProviderApi from '../secretsProvider';

const context: IRestApiContext = { baseUrl: 'http://localhost:5678/rest', pushRef: 'push-ref-1' };

/** The answer of the fake server: `data` holds a payload, as the REST API of n8n answers. */
const ANSWER = { data: { payload: 'the data of the answer' }, outer: 'a key next to data' };

let requests: unknown[] = [];
let failWith: { status: number; message: string } | undefined;

beforeEach(() => {
	requests = [];
	failWith = undefined;
	vi.spyOn(axios, 'request').mockImplementation(async (config) => {
		requests.push({
			method: config.method,
			baseURL: config.baseURL,
			url: config.url,
			...(config.params !== undefined && { params: config.params }),
			...(config.data !== undefined && { data: config.data }),
			headers: config.headers,
		});
		if (failWith) {
			throw Object.assign(new Error('Request failed'), {
				response: {
					status: failWith.status,
					data: { message: failWith.message, code: failWith.status },
				},
			});
		}
		return { data: ANSWER };
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

type ApiFunction = (...args: unknown[]) => Promise<unknown>;

const describeError = (error: unknown) => {
	if (!(error instanceof Error)) return { thrown: error };
	const { httpStatusCode, errorCode } = error as Error & {
		httpStatusCode?: unknown;
		errorCode?: unknown;
	};
	return { name: error.name, message: error.message, httpStatusCode, errorCode };
};

/** One call: the requests that it makes, and its result or its error. */
async function callOnce(fn: ApiFunction, args: unknown[]) {
	requests = [];
	let outcome: unknown;
	try {
		outcome = { result: await fn(context, ...args) };
	} catch (error) {
		outcome = { error: describeError(error) };
	}
	return { args, requests, ...(outcome as object) };
}

/**
 * The probe arguments for an export that takes `count` arguments after the context. The calls with
 * one more argument show a parameter with a default value, which `Function.length` does not count.
 */
function probes(count: number): Record<string, unknown[]> {
	const range = Array.from({ length: count }, (_, index) => index + 2);
	const texts = range.map((position) => `arg${position}`);
	return {
		texts,
		objects: range.map((position) => ({ probe: `arg${position}`, flag: true })),
		special: range.map((position) => `a b/c?d=${position}#e`),
		textsThenObject: range.map((position, index) =>
			index === count - 1 ? { probe: `arg${position}` } : `arg${position}`,
		),
		extraFalse: [...texts, false],
		extraObject: [...texts, { probe: 'extra' }],
	};
}

async function recordModule(module: Record<string, unknown>) {
	const record: Record<string, unknown> = {};
	for (const name of Object.keys(module).sort()) {
		const fn = module[name];
		if (typeof fn !== 'function') {
			record[name] = typeof fn;
			continue;
		}
		const api = fn as ApiFunction;
		const count = Math.max(api.length - 1, 0);
		const calls: Record<string, unknown> = {};
		for (const [label, args] of Object.entries(probes(count))) {
			if (count === 0 && ['objects', 'special', 'textsThenObject'].includes(label)) continue;
			calls[label] = await callOnce(api, args);
		}
		failWith = { status: 400, message: 'The server refused it' };
		calls.serverError = await callOnce(api, probes(count).textsThenObject);
		failWith = undefined;
		record[name] = { arguments: count, calls };
	}
	return record;
}

describe('REST clients of external secrets', () => {
	test('the settings API client (externalSecrets)', async () => {
		expect(await recordModule(externalSecretsApi)).toMatchSnapshot();
	});

	test('the connections API client (secretsProvider)', async () => {
		expect(await recordModule(secretsProviderApi)).toMatchSnapshot();
	});
});
