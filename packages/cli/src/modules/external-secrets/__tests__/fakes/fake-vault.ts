// A fake HashiCorp Vault server for the golden tests. It implements the documented HTTP API
// (https://developer.hashicorp.com/vault/api-docs) for the token, userpass and AppRole auth
// methods, token lookup and renewal, sys/mounts, and the KV v1 and v2 engines. It logs each
// request with the label of the current step.
import { parseJsonBody, startRawServer, type RawRequest, type RawResponse } from './fake-http';

export interface FakeVaultState {
	/** Valid tokens, with their TTL in seconds. */
	tokens: Record<string, { ttl: number; renewable: boolean }>;
	userpass: Record<string, { password: string; token: string }>;
	approle: Record<string, { secretId: string; token: string }>;
	/** Mounts as `sys/mounts` lists them, for example `secret/`. */
	mounts: Record<string, unknown>;
	/** Secrets of each mount: a path (without the mount) mapped to its key-value data. */
	kv: Record<string, Record<string, Record<string, unknown>>>;
	/** Paths (without `/v1/`) that answer 403 for every token. */
	forbidden: string[];
	/** Paths (without `/v1/`) that answer with an error status. */
	failing: Record<string, number>;
	/** The body of a failing path, when not `{ errors: ['internal error'] }`. */
	failingBody: Record<string, unknown>;
	/** Token lookups answer `expire_time: null`, also for tokens with a TTL. */
	noExpireTime: boolean;
	/** Delay of each answer, in milliseconds. */
	delayMs: number;
}

export function emptyVaultState(): FakeVaultState {
	return {
		tokens: {},
		userpass: {},
		approle: {},
		mounts: {},
		kv: {},
		forbidden: [],
		failing: {},
		failingBody: {},
		noExpireTime: false,
		delayMs: 0,
	};
}

/** A mount entry with the fields that Vault returns. */
export function vaultMount(type: string, version: string | null) {
	return {
		accessor: `${type}_1234`,
		config: { default_lease_ttl: 0, force_no_cache: false, max_lease_ttl: 0 },
		description: '',
		external_entropy_access: false,
		local: false,
		options: version === null ? null : { version },
		plugin_version: '',
		running_plugin_version: 'v0.20.0+builtin',
		running_sha256: '',
		seal_wrap: false,
		type,
		uuid: '0000-1111',
	};
}

export interface FakeVault {
	url: string;
	state: FakeVaultState;
	/** One line for each request: the step, the method, the path, the status and the headers. */
	requests: string[];
	/** The method, the path and all headers of each request, without the host and the length. */
	headers: Array<{ request: string; headers: Record<string, string> }>;
	/** The label of the current step. Each request records it. */
	step: (label: string) => void;
	close: () => Promise<void>;
}

const json = (status: number, body: unknown): RawResponse => ({ status, body });

function envelope(data: unknown) {
	return {
		request_id: 'req-1',
		lease_id: '',
		renewable: false,
		lease_duration: 0,
		data,
		wrap_info: null,
		warnings: null,
		auth: null,
	};
}

function authAnswer(token: string, state: FakeVaultState) {
	const info = state.tokens[token];
	return {
		...envelope(null),
		auth: {
			client_token: token,
			accessor: 'accessor-1',
			policies: ['default'],
			token_policies: ['default'],
			metadata: null,
			lease_duration: info?.ttl ?? 0,
			renewable: info?.renewable ?? false,
			entity_id: '',
			token_type: 'service',
			orphan: true,
		},
	};
}

/** The direct children (keys) of a folder path in a KV tree. Folders end with `/`. */
function listKeys(tree: Record<string, Record<string, unknown>>, folder: string) {
	const keys = new Set<string>();
	for (const path of Object.keys(tree)) {
		if (!path.startsWith(folder)) continue;
		const rest = path.slice(folder.length);
		const slash = rest.indexOf('/');
		keys.add(slash === -1 ? rest : rest.slice(0, slash + 1));
	}
	return [...keys].sort();
}

function answer(state: FakeVaultState, req: RawRequest, body: unknown): RawResponse {
	const token = req.headers['x-vault-token'];
	const parsed = new URL(req.url, 'http://vault');
	if (!parsed.pathname.startsWith('/v1/')) return json(404, { errors: [] });
	const path = parsed.pathname.slice('/v1/'.length);
	const method =
		req.method === 'GET' && parsed.searchParams.get('list') === 'true' ? 'LIST' : req.method;

	if (state.failing[path] !== undefined) {
		return json(
			state.failing[path],
			path in state.failingBody ? state.failingBody[path] : { errors: ['internal error'] },
		);
	}

	const userpassLogin = /^auth\/userpass\/login\/(.+)$/.exec(path);
	if (userpassLogin && (method === 'POST' || method === 'PUT')) {
		const user = state.userpass[decodeURIComponent(userpassLogin[1])];
		const password = (body as { password?: string } | undefined)?.password;
		if (!user || user.password !== password) {
			return json(400, { errors: ['invalid username or password'] });
		}
		return json(200, authAnswer(user.token, state));
	}
	if (path === 'auth/approle/login' && (method === 'POST' || method === 'PUT')) {
		const { role_id, secret_id } = (body ?? {}) as { role_id?: string; secret_id?: string };
		const role = role_id === undefined ? undefined : state.approle[role_id];
		if (!role || role.secretId !== secret_id) {
			return json(400, { errors: ['invalid role or secret ID'] });
		}
		return json(200, authAnswer(role.token, state));
	}

	if (token === undefined || state.tokens[token] === undefined) {
		return json(403, { errors: ['permission denied'] });
	}
	if (state.forbidden.includes(path)) return json(403, { errors: ['permission denied'] });

	if (path === 'auth/token/lookup-self' && method === 'GET') {
		const info = state.tokens[token];
		const now = Math.floor(Date.now() / 1000);
		const expires = info.ttl > 0 && !state.noExpireTime;
		return json(
			200,
			envelope({
				accessor: 'accessor-1',
				creation_time: now,
				creation_ttl: info.ttl,
				display_name: 'token',
				entity_id: '',
				expire_time: expires ? new Date((now + info.ttl) * 1000).toISOString() : null,
				explicit_max_ttl: 0,
				id: token,
				identity_policies: null,
				issue_time: new Date(now * 1000).toISOString(),
				meta: null,
				num_uses: 0,
				orphan: true,
				path: 'auth/token/create',
				policies: ['default'],
				renewable: info.renewable,
				ttl: info.ttl,
				type: 'service',
			}),
		);
	}
	if (path === 'auth/token/renew-self' && (method === 'POST' || method === 'PUT')) {
		return json(200, authAnswer(token, state));
	}
	if (path === 'sys/mounts' && method === 'GET') {
		return json(200, { ...state.mounts, ...envelope(state.mounts) });
	}

	for (const [mount, raw] of Object.entries(state.mounts)) {
		if (!path.startsWith(mount)) continue;
		const info = raw as { type?: string; options?: { version?: string } | null };
		if (info.type !== 'kv' && info.type !== 'generic') break;
		const tree = state.kv[mount] ?? {};
		const rest = path.slice(mount.length);
		if (info.options?.version === '2') {
			if (method === 'LIST' && (rest === 'metadata' || rest.startsWith('metadata/'))) {
				const keys = listKeys(tree, rest.slice('metadata/'.length));
				return keys.length > 0 ? json(200, envelope({ keys })) : json(404, { errors: [] });
			}
			if (method === 'GET' && rest.startsWith('data/')) {
				const data = tree[rest.slice('data/'.length)];
				return data
					? json(
							200,
							envelope({ data, metadata: { version: 1, destroyed: false, deletion_time: '' } }),
						)
					: json(404, { errors: [] });
			}
		} else {
			if (method === 'LIST') {
				const keys = listKeys(tree, rest);
				return keys.length > 0 ? json(200, envelope({ keys })) : json(404, { errors: [] });
			}
			if (method === 'GET') {
				const data = tree[rest];
				return data ? json(200, envelope(data)) : json(404, { errors: [] });
			}
		}
	}
	return json(404, { errors: [] });
}

export async function startFakeVault(state: FakeVaultState): Promise<FakeVault> {
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
		const body = parseJsonBody(req.body);
		if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
		const response = answer(state, req, body);
		const token = req.headers['x-vault-token'];
		const namespace = req.headers['x-vault-namespace'];
		requests.push(
			[
				`${stepAtArrival}: ${req.method} ${req.url} ${response.status}`,
				token !== undefined ? `token=${token}` : '',
				namespace !== undefined ? `namespace=${namespace}` : '',
				body !== undefined ? `body=${JSON.stringify(body)}` : '',
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
