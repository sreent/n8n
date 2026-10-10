// A fake 1Password Connect server for the golden tests. It implements the documented Connect API
// (https://developer.1password.com/docs/connect/connect-api-reference): vaults, items and item
// details. It logs each request with the label of the current step, and answers 404 to requests
// that it does not know.
import { startRawServer, type RawRequest, type RawResponse } from './fake-http';

export interface OnePasswordField {
	id: string;
	label?: string;
	value?: unknown;
	purpose?: string;
	section?: { id: string; label?: string };
}

export interface OnePasswordItem {
	id: string;
	title: string;
	category?: string;
	fields?: OnePasswordField[];
}

export interface FakeOnePasswordState {
	token: string;
	vaults: Array<{ id: string; name: string; items: OnePasswordItem[] }>;
	/** Paths (without the query and a trailing slash) that answer with an error status. */
	failing: Record<string, number>;
	delayMs: number;
}

export function emptyOnePasswordState(): FakeOnePasswordState {
	return { token: 'op-token', vaults: [], failing: {}, delayMs: 0 };
}

export interface FakeOnePassword {
	url: string;
	state: FakeOnePasswordState;
	/** One line for each request: the step, the method, the path, the status and the headers. */
	requests: string[];
	/** The method, the path and all headers of each request, without the host and the length. */
	headers: Array<{ request: string; headers: Record<string, string> }>;
	step: (label: string) => void;
	close: () => Promise<void>;
}

const json = (status: number, body: unknown): RawResponse => ({ status, body });

const vaultSummary = (vault: { id: string; name: string; items: unknown[] }) => ({
	id: vault.id,
	name: vault.name,
	attributeVersion: 1,
	contentVersion: 1,
	items: vault.items.length,
	type: 'USER_CREATED',
	createdAt: '2024-01-01T00:00:00Z',
	updatedAt: '2024-01-01T00:00:00Z',
});

const itemSummary = (vaultId: string, item: OnePasswordItem) => ({
	id: item.id,
	title: item.title,
	vault: { id: vaultId },
	category: item.category ?? 'LOGIN',
	version: 1,
	createdAt: '2024-01-01T00:00:00Z',
	updatedAt: '2024-01-01T00:00:00Z',
});

function answer(state: FakeOnePasswordState, req: RawRequest): RawResponse {
	const parsed = new URL(req.url, 'http://connect');
	// The Connect SDK asks for some paths with a trailing slash.
	const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/$/, '') : parsed.pathname;
	if (state.failing[path] !== undefined) {
		return json(state.failing[path], { status: state.failing[path], message: 'Internal error' });
	}
	if (req.headers.authorization !== `Bearer ${state.token}`) {
		return json(401, { status: 401, message: 'Invalid bearer token' });
	}
	if (path === '/v1/vaults' && req.method === 'GET')
		return json(200, state.vaults.map(vaultSummary));
	const itemsMatch = /^\/v1\/vaults\/([^/]+)\/items$/.exec(path);
	if (itemsMatch && req.method === 'GET') {
		const vault = state.vaults.find((v) => v.id === itemsMatch[1]);
		if (!vault) return json(404, { status: 404, message: 'Invalid Vault UUID' });
		return json(
			200,
			vault.items.map((item) => itemSummary(vault.id, item)),
		);
	}
	const itemMatch = /^\/v1\/vaults\/([^/]+)\/items\/([^/]+)$/.exec(path);
	if (itemMatch && req.method === 'GET') {
		const vault = state.vaults.find((v) => v.id === itemMatch[1]);
		const item = vault?.items.find((i) => i.id === itemMatch[2]);
		if (!vault || !item) return json(404, { status: 404, message: 'Invalid Item UUID' });
		return json(200, { ...itemSummary(vault.id, item), fields: item.fields ?? [] });
	}
	return json(404, { status: 404, message: `Route not found: ${req.method} ${path}` });
}

export async function startFakeOnePassword(state: FakeOnePasswordState): Promise<FakeOnePassword> {
	const requests: string[] = [];
	const headers: Array<{ request: string; headers: Record<string, string> }> = [];
	let label = '';
	const server = await startRawServer(async (req) => {
		const stepAtArrival = label;
		headers.push({
			request: `${req.method} ${req.url}`,
			headers: Object.fromEntries(
				Object.entries(req.headers).filter(([key]) => key !== 'host' && key !== 'content-length'),
			),
		});
		if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
		const response = answer(state, req);
		requests.push(
			[
				`${stepAtArrival}: ${req.method} ${req.url} ${response.status}`,
				req.headers.authorization !== undefined ? `authorization=${req.headers.authorization}` : '',
			]
				.filter(Boolean)
				.join(' '),
		);
		return response;
	});
	return {
		url: server.url,
		state,
		requests,
		headers,
		step: (next) => {
			label = next;
		},
		close: server.close,
	};
}
