// A fake AWS Secrets Manager endpoint for the golden tests. It implements the documented JSON
// protocol (https://docs.aws.amazon.com/secretsmanager/latest/apireference/) for ListSecrets,
// BatchGetSecretValue and GetSecretValue. The tests point the AWS SDK at it with the environment
// variable AWS_ENDPOINT_URL_SECRETS_MANAGER. It logs each request with the label of the current
// step: the operation, the input, and the access key and region of the signature.
import { startRawServer, type RawRequest, type RawResponse } from './fake-http';

export interface AwsSecret {
	Name: string;
	SecretString?: string;
	SecretBinary?: string;
}

export interface FakeAwsState {
	secrets: AwsSecret[];
	/** Access key IDs that the fake accepts. The fake does not check the signatures. */
	accessKeys: string[];
	/** Operations that fail: the status and the AWS error type. */
	failing: Record<string, { status: number; type: string; message: string }>;
	/** Secret names that BatchGetSecretValue reports in `Errors`. */
	batchErrors: string[];
	listPageSize: number;
	delayMs: number;
}

export function emptyAwsState(): FakeAwsState {
	return {
		secrets: [],
		accessKeys: [],
		failing: {},
		batchErrors: [],
		listPageSize: 100,
		delayMs: 0,
	};
}

export interface FakeAws {
	url: string;
	state: FakeAwsState;
	/** One line for each request: the step, the operation, the input and the signature. */
	requests: string[];
	step: (label: string) => void;
	close: () => Promise<void>;
}

const arn = (name: string) => `arn:aws:secretsmanager:eu-west-3:123456789012:secret:${name}-AbCdEf`;

function awsError(status: number, type: string, message: string): RawResponse {
	return {
		status,
		headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amzn-errortype': type },
		body: { __type: type, Message: message },
	};
}

function ok(body: unknown): RawResponse {
	return { status: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body };
}

function secretValue(secret: AwsSecret) {
	return {
		ARN: arn(secret.Name),
		Name: secret.Name,
		VersionId: 'v1',
		...(secret.SecretString !== undefined ? { SecretString: secret.SecretString } : {}),
		...(secret.SecretBinary !== undefined ? { SecretBinary: secret.SecretBinary } : {}),
		VersionStages: ['AWSCURRENT'],
		CreatedDate: 1700000000,
	};
}

function answer(
	state: FakeAwsState,
	operation: string,
	input: Record<string, unknown>,
	accessKey: string | undefined,
): RawResponse {
	if (accessKey === undefined || !state.accessKeys.includes(accessKey)) {
		return awsError(
			400,
			'UnrecognizedClientException',
			'The security token included in the request is invalid.',
		);
	}
	const failure = state.failing[operation];
	if (failure) return awsError(failure.status, failure.type, failure.message);

	const find = (id: unknown) =>
		state.secrets.find((secret) => secret.Name === id || arn(secret.Name) === id);
	if (operation === 'ListSecrets') {
		const start = typeof input.NextToken === 'string' ? Number(input.NextToken) : 0;
		const size =
			typeof input.MaxResults === 'number'
				? Math.min(input.MaxResults, state.listPageSize)
				: state.listPageSize;
		const page = state.secrets.slice(start, start + size);
		const next = start + size < state.secrets.length ? String(start + size) : undefined;
		return ok({
			SecretList: page.map((secret) => ({
				ARN: arn(secret.Name),
				Name: secret.Name,
				LastChangedDate: 1700000000,
			})),
			...(next !== undefined ? { NextToken: next } : {}),
		});
	}
	if (operation === 'BatchGetSecretValue') {
		const ids = Array.isArray(input.SecretIdList) ? input.SecretIdList : [];
		const values: unknown[] = [];
		const errors: unknown[] = [];
		for (const id of ids) {
			const secret = find(id);
			if (!secret || state.batchErrors.includes(secret.Name)) {
				errors.push({
					SecretId: id,
					ErrorCode: secret ? 'AccessDeniedException' : 'ResourceNotFoundException',
					Message: 'denied',
				});
				continue;
			}
			values.push(secretValue(secret));
		}
		return ok({ SecretValues: values, Errors: errors });
	}
	if (operation === 'GetSecretValue') {
		const secret = find(input.SecretId);
		if (!secret) {
			return awsError(
				400,
				'ResourceNotFoundException',
				"Secrets Manager can't find the specified secret.",
			);
		}
		return ok(secretValue(secret));
	}
	return awsError(400, 'UnknownOperationException', `Unknown operation ${operation}`);
}

export async function startFakeAws(state: FakeAwsState): Promise<FakeAws> {
	const requests: string[] = [];
	let label = '';
	const server = await startRawServer(async (req: RawRequest) => {
		const stepAtArrival = label;
		const operation = (req.headers['x-amz-target'] ?? '').replace(/^secretsmanager\./, '');
		let input: Record<string, unknown> = {};
		try {
			input = req.body === '' ? {} : (JSON.parse(req.body) as Record<string, unknown>);
		} catch {
			input = { unparsed: req.body };
		}
		const credential = /Credential=([^/]*)\/\d+\/([^/]+)\/([^/]+)\//.exec(
			req.headers.authorization ?? '',
		);
		const accessKey = credential?.[1];
		if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
		const response = answer(state, operation, input, accessKey);
		requests.push(
			[
				`${stepAtArrival}: ${req.method} ${req.url} ${operation} ${JSON.stringify(input)} ${response.status}`,
				credential
					? `key=${credential[1]} region=${credential[2]} service=${credential[3]}`
					: 'unsigned',
				req.headers['x-amz-security-token'] !== undefined
					? `session=${req.headers['x-amz-security-token']}`
					: '',
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
		step: (next) => {
			label = next;
		},
		close: server.close,
	};
}
