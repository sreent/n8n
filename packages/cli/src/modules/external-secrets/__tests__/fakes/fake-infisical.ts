// A fake Infisical server for the golden tests. It implements the documented API
// (https://infisical.com/docs/api-reference) for Universal Auth, projects and secrets. It logs
// each request with the label of the current step, and answers 404 to requests that it does not
// know.
import { parseJsonBody, startRawServer, type RawRequest, type RawResponse } from './fake-http';

export interface InfisicalSecret {
	secretKey: string;
	secretValue: string;
	/** The folder of the secret, for example `/` or `/app`. */
	secretPath?: string;
}

export interface FakeInfisicalState {
	/** Machine identities: client ID mapped to client secret and the access token to issue. */
	identities: Record<string, { clientSecret: string; accessToken: string }>;
	/** Valid access tokens. */
	tokens: string[];
	/** Tokens that the server refuses until the next login issues them again. */
	revoked: string[];
	/** Tokens that the server refuses, also after a login. */
	alwaysRevoked: string[];
	/** Secrets of each project and environment: key `projectId/environment`. */
	secrets: Record<string, InfisicalSecret[]>;
	/** Paths (without the query) that answer with a status and a body. */
	failing: Record<string, number>;
	failingBody: Record<string, unknown>;
	delayMs: number;
}

export function emptyInfisicalState(): FakeInfisicalState {
	return {
		identities: {},
		tokens: [],
		revoked: [],
		alwaysRevoked: [],
		secrets: {},
		failing: {},
		failingBody: {},
		delayMs: 0,
	};
}

export interface FakeInfisical {
	url: string;
	state: FakeInfisicalState;
	/** One line for each request: the step, the method, the path, the status and the headers. */
	requests: string[];
	/** The method, the path and all headers of each request, without the host and the length. */
	headers: Array<{ request: string; headers: Record<string, string> }>;
	step: (label: string) => void;
	close: () => Promise<void>;
}

const json = (status: number, body: unknown): RawResponse => ({ status, body });

function answer(state: FakeInfisicalState, req: RawRequest, body: unknown): RawResponse {
	const parsed = new URL(req.url, 'http://infisical');
	const path = parsed.pathname;
	if (state.failing[path] !== undefined) {
		return json(
			state.failing[path],
			path in state.failingBody
				? state.failingBody[path]
				: { statusCode: state.failing[path], message: 'Internal error' },
		);
	}

	if (path === '/api/v1/auth/universal-auth/login' && req.method === 'POST') {
		const { clientId, clientSecret } = (body ?? {}) as { clientId?: string; clientSecret?: string };
		const identity = clientId === undefined ? undefined : state.identities[clientId];
		if (!identity || identity.clientSecret !== clientSecret) {
			return json(401, {
				statusCode: 401,
				message: 'Invalid credentials',
				error: 'UnauthorizedError',
			});
		}
		state.revoked = state.revoked.filter((token) => token !== identity.accessToken);
		return json(200, {
			accessToken: identity.accessToken,
			expiresIn: 7200,
			accessTokenMaxTTL: 2592000,
			tokenType: 'Bearer',
		});
	}

	const bearer = req.headers.authorization?.replace(/^Bearer /, '');
	if (
		bearer === undefined ||
		!state.tokens.includes(bearer) ||
		state.revoked.includes(bearer) ||
		state.alwaysRevoked.includes(bearer)
	) {
		return json(401, {
			statusCode: 401,
			message: 'Token missing or invalid',
			error: 'UnauthorizedError',
		});
	}

	const workspace = /^\/api\/v1\/workspace\/([^/]+)$/.exec(path);
	if (workspace && req.method === 'GET') {
		const id = decodeURIComponent(workspace[1]);
		const environments = Object.keys(state.secrets)
			.filter((key) => key.startsWith(`${id}/`))
			.map((key) => key.slice(id.length + 1));
		if (environments.length === 0) {
			return json(404, {
				statusCode: 404,
				message: `Project with ID '${id}' not found`,
				error: 'NotFound',
			});
		}
		return json(200, {
			workspace: {
				id,
				name: `Project ${id}`,
				slug: id,
				environments: environments.map((slug) => ({ id: `env-${slug}`, name: slug, slug })),
			},
		});
	}

	if (path === '/api/v4/secrets' && req.method === 'GET') {
		const project = parsed.searchParams.get('projectId') ?? '';
		const environment = parsed.searchParams.get('environment') ?? '';
		const secretPath = parsed.searchParams.get('secretPath') ?? '/';
		const all = state.secrets[`${project}/${environment}`];
		if (all === undefined) {
			return json(404, {
				statusCode: 404,
				message: 'Project or environment not found',
				error: 'NotFound',
			});
		}
		return json(200, {
			secrets: all
				.filter((secret) => (secret.secretPath ?? '/') === secretPath)
				.map((secret, index) => ({
					id: `id-${index}`,
					workspace: project,
					environment,
					version: 1,
					type: 'shared',
					secretKey: secret.secretKey,
					secretValue: secret.secretValue,
					secretComment: '',
					secretPath: secret.secretPath ?? '/',
					tags: [],
				})),
			imports: [],
		});
	}
	return json(404, {
		statusCode: 404,
		message: `Route ${req.method}:${path} not found`,
		error: 'Not Found',
	});
}

export async function startFakeInfisical(state: FakeInfisicalState): Promise<FakeInfisical> {
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
		requests.push(
			[
				`${stepAtArrival}: ${req.method} ${req.url} ${response.status}`,
				req.headers.authorization !== undefined ? `authorization=${req.headers.authorization}` : '',
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
