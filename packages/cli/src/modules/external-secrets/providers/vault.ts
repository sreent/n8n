import {
	OutboundHttp,
	httpStatusFromError,
	isConnectionRefusedError,
	isHttpRequestError,
	type HttpRequestClient,
} from '@n8n/backend-network';
import { Container } from '@n8n/di';
import type { IDataObject, IHttpRequestMethods, INodeProperties } from 'n8n-workflow';

import { ExternalSecretsConfig } from '../external-secrets.config';
import { SecretsProvider, type SecretsProviderSettings } from '../types';

type VaultAuthMethod = 'token' | 'usernameAndPassword' | 'appRole';

interface VaultSettings {
	url: string;
	namespace?: string;
	authMethod: VaultAuthMethod;
	token?: string;
	username?: string;
	password?: string;
	roleId?: string;
	secretId?: string;
	kvMountPath?: string;
	kvVersion?: string;
	kvSecretPath?: string;
}

interface VaultResponse<T> {
	data: T;
}

interface VaultLoginResponse {
	auth: { client_token: string };
}

interface VaultTokenInfo {
	renewable: boolean;
	expire_time: string | null;
}

interface VaultMount {
	type: string;
	options?: { version?: string } | null;
}

/** A KV folder or secret, by its name in the tree of secrets. */
type SecretTree = Record<string, IDataObject>;

/** Vault lists keys with the LIST method, which the request types do not name. */
const LIST = 'LIST' as IHttpRequestMethods;

const AUTH_PATH_MESSAGE = 'Could not find auth path. Try adding /v1/ to the end of your base URL.';

/** Vault answers a LIST of a folder without keys with 404 and an empty `errors` list. */
function isEmptyListAnswer(error: unknown) {
	if (!isHttpRequestError(error) || error.response?.status !== 404) return false;
	const body: unknown = error.response.data;
	return (
		typeof body === 'object' &&
		body !== null &&
		'errors' in body &&
		Array.isArray(body.errors) &&
		body.errors.length === 0
	);
}

/** The dot paths of all values in a tree of secrets, for the completions of the editor. */
function flattenNames(value: IDataObject, prefix = ''): string[] {
	const names: string[] = [];
	for (const [key, child] of Object.entries(value)) {
		const path = prefix === '' ? key : `${prefix}.${key}`;
		if (typeof child === 'object' && child !== null) {
			names.push(...flattenNames(child as IDataObject, path));
		} else {
			names.push(path);
		}
	}
	return names;
}

/** The fields of the settings form. */
const PROPERTIES: INodeProperties[] = [
	{
		displayName:
			'Need help filling out these fields? <a href="https://docs.n8n.io/external-secrets/#connect-n8n-to-your-secrets-store" target="_blank">Open docs</a>',
		name: 'notice',
		type: 'notice',
		noDataExpression: true,
		default: '',
	},
	{
		displayName: 'Vault URL',
		name: 'url',
		type: 'string',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. https://example.com/v1/',
		default: '',
	},
	{
		displayName: 'Vault Namespace (optional)',
		name: 'namespace',
		type: 'string',
		hint: 'Leave blank if not using namespaces',
		required: false,
		noDataExpression: true,
		placeholder: 'e.g. admin',
		default: '',
	},
	{
		displayName: 'Authentication Method',
		name: 'authMethod',
		type: 'options',
		required: true,
		noDataExpression: true,
		default: 'token',
		options: [
			{
				name: 'Token',
				value: 'token',
			},
			{
				name: 'Username and Password',
				value: 'usernameAndPassword',
			},
			{
				name: 'AppRole',
				value: 'appRole',
			},
		],
	},
	{
		displayName: 'Token',
		name: 'token',
		type: 'string',
		required: true,
		noDataExpression: true,
		placeholder: 'e.g. hvs.2OCsZxZA6Z9lChbt0janOOZI',
		default: '',
		typeOptions: {
			password: true,
		},
		displayOptions: {
			show: {
				authMethod: ['token'],
			},
		},
	},
	{
		displayName: 'Username',
		name: 'username',
		type: 'string',
		required: true,
		noDataExpression: true,
		placeholder: 'Username',
		default: '',
		displayOptions: {
			show: {
				authMethod: ['usernameAndPassword'],
			},
		},
	},
	{
		displayName: 'Password',
		name: 'password',
		type: 'string',
		required: true,
		noDataExpression: true,
		placeholder: '***************',
		default: '',
		typeOptions: {
			password: true,
		},
		displayOptions: {
			show: {
				authMethod: ['usernameAndPassword'],
			},
		},
	},
	{
		displayName: 'Role ID',
		name: 'roleId',
		type: 'string',
		required: true,
		noDataExpression: true,
		placeholder: '59d6d1ca-47bb-4e7e-a40b-8be3bc5a0ba8',
		default: '',
		displayOptions: {
			show: {
				authMethod: ['appRole'],
			},
		},
	},
	{
		displayName: 'Secret ID',
		name: 'secretId',
		type: 'string',
		required: true,
		noDataExpression: true,
		placeholder: '84896a0c-1347-aa90-a4f6-aca8b7558780',
		default: '',
		typeOptions: {
			password: true,
		},
		displayOptions: {
			show: {
				authMethod: ['appRole'],
			},
		},
	},
	{
		displayName: 'KV Mount Path (optional)',
		name: 'kvMountPath',
		type: 'string',
		hint: 'Specify the KV engine mount path to skip sys/mounts auto-discovery. Leave blank to auto-detect.',
		required: false,
		noDataExpression: true,
		placeholder: 'e.g. secret/',
		default: '',
	},
	{
		displayName: 'KV Version',
		name: 'kvVersion',
		type: 'options',
		hint: 'Only used when KV Mount Path is specified.',
		required: false,
		noDataExpression: true,
		default: '2',
		options: [
			{
				name: 'v1',
				value: '1',
			},
			{
				name: 'v2',
				value: '2',
			},
		],
	},
	{
		displayName: 'KV Secret Path (optional)',
		name: 'kvSecretPath',
		type: 'string',
		hint: 'Folder inside the KV mount to read secrets from. Leave blank to read the whole mount. Only used when KV Mount Path is specified.',
		required: false,
		noDataExpression: true,
		placeholder: 'e.g. my-app/',
		default: '',
	},
];

/**
 * Fork code (not in upstream n8n). Reads secrets from the KV engines of HashiCorp Vault.
 * packages/cli/src/modules/external-secrets/FORK.md describes the behaviour.
 */
export class VaultProvider extends SecretsProvider {
	properties: INodeProperties[] = PROPERTIES;

	displayName = 'HashiCorp Vault';

	name = 'vault';

	private settings: VaultSettings = { url: '', authMethod: 'token' };

	private http: HttpRequestClient | undefined;

	private token: string | undefined;

	private secrets: SecretTree = {};

	private renewalTimer: NodeJS.Timeout | undefined;

	async init(settings: SecretsProviderSettings): Promise<void> {
		this.settings = settings.settings as unknown as VaultSettings;
		// Throws a TypeError for an invalid URL.
		const baseURL = new URL(this.settings.url).href;
		const config = Container.get(ExternalSecretsConfig);
		this.http = Container.get(OutboundHttp).requests({
			// The vault is infrastructure that an admin set up. It can be on an internal network.
			useDefaultSsrfPolicy: 'unsafe',
			baseURL,
			headers: () => ({
				'X-Vault-Token': this.token || undefined,
				'X-Vault-Namespace': this.settings.namespace || undefined,
			}),
			timeout: Math.max(config.connectTimeout, config.refreshTimeout) * 1000,
		});
	}

	protected async doConnect(): Promise<void> {
		await this.logIn();
		await this.request({ method: 'GET', url: 'auth/token/lookup-self', json: true });
		const manualMount = this.manualMount();
		if (manualMount) {
			try {
				await this.request({ method: LIST, url: manualMount.listPath });
			} catch (error) {
				if (!isEmptyListAnswer(error)) throw error;
			}
		} else {
			await this.request({ method: 'GET', url: 'sys/mounts' });
		}
		await this.scheduleRenewal();
	}

	async disconnect(): Promise<void> {
		clearTimeout(this.renewalTimer);
		this.renewalTimer = undefined;
	}

	async update(): Promise<void> {
		const manualMount = this.manualMount();
		if (manualMount) {
			const tree = await this.readFolder(
				manualMount.mount,
				manualMount.version,
				manualMount.folder,
				'',
			);
			const secrets: SecretTree = {};
			if (tree !== null) {
				// The folder of the settings stays in the tree, one level for each part of its path.
				const segments = manualMount.folder.split('/').filter((segment) => segment !== '');
				secrets[manualMount.mount.slice(0, -1)] = segments.reduceRight<IDataObject>(
					(child, segment) => ({ [segment]: child }),
					tree,
				);
			}
			this.secrets = secrets;
			return;
		}

		const { data: mounts } = await this.request<VaultResponse<Record<string, VaultMount>>>({
			method: 'GET',
			url: 'sys/mounts',
		});
		const kvMounts = Object.entries(mounts).filter(
			([, mount]) =>
				mount.type === 'kv' && (mount.options?.version === '1' || mount.options?.version === '2'),
		);
		const trees = await Promise.all(
			kvMounts.map(
				async ([mount, { options }]) =>
					[mount, await this.readFolder(mount, options?.version ?? '1', '', '')] as const,
			),
		);
		const secrets: SecretTree = {};
		for (const [mount, tree] of trees) {
			if (tree !== null) secrets[mount.replace(/\/$/, '')] = tree;
		}
		this.secrets = secrets;
	}

	async test(): Promise<[boolean] | [boolean, string]> {
		try {
			await this.request({ method: 'GET', url: 'auth/token/lookup-self', json: true });
		} catch (error) {
			const status = httpStatusFromError(error);
			if (status === 404) return [false, AUTH_PATH_MESSAGE];
			if (status !== undefined) return [false, 'Invalid credentials'];
			if (isConnectionRefusedError(error)) {
				return [
					false,
					'Connection refused. Please check the host and port of the server are correct.',
				];
			}
			return [false];
		}

		const manualMount = this.manualMount();
		if (manualMount) {
			try {
				await this.request({ method: LIST, url: manualMount.listPath });
			} catch (error) {
				if (isEmptyListAnswer(error)) return [true];
				if (httpStatusFromError(error) === 403) {
					return [
						false,
						`Permission denied accessing ${manualMount.listPath}. Check your token policies.`,
					];
				}
				return [
					false,
					`Could not access ${manualMount.listPath} (status ${httpStatusFromError(error)}).`,
				];
			}
			return [true];
		}

		try {
			await this.request({ method: 'GET', url: 'sys/mounts' });
		} catch (error) {
			if (httpStatusFromError(error) === 403) {
				return [
					false,
					"Couldn't list mounts. Please give these credentials 'read' access to sys/mounts.",
				];
			}
			return [
				false,
				"Couldn't list mounts but it wasn't a permissions issue. Please consult your Vault admin.",
			];
		}
		return [true];
	}

	getSecret(name: string): IDataObject | undefined {
		return this.secrets[name];
	}

	hasSecret(name: string): boolean {
		return name in this.secrets;
	}

	getSecretNames(): string[] {
		return flattenNames(this.secrets);
	}

	private async request<T = unknown>(options: Parameters<HttpRequestClient['request']>[0]) {
		// Before a successful init there is no client, and the call throws a TypeError.
		return await this.http!.request<T>({ ...options, returnFullResponse: false });
	}

	/** Set the token of the auth method. A failed login throws and leaves the token as it was. */
	private async logIn() {
		const { authMethod } = this.settings;
		if (authMethod === 'token') {
			this.token = this.settings.token;
		} else if (authMethod === 'usernameAndPassword') {
			const { auth } = await this.request<VaultLoginResponse>({
				method: 'POST',
				url: `auth/userpass/login/${this.settings.username}`,
				body: { password: this.settings.password },
				json: true,
			});
			this.token = auth.client_token;
		} else if (authMethod === 'appRole') {
			const { auth } = await this.request<VaultLoginResponse>({
				method: 'POST',
				url: 'auth/approle/login',
				body: { role_id: this.settings.roleId, secret_id: this.settings.secretId },
				json: true,
			});
			this.token = auth.client_token;
		}
	}

	/**
	 * Renew a renewable token at half of the time that is left before it expires. When the
	 * renewal fails, connect again (with a new login for the userpass and AppRole methods).
	 */
	private async scheduleRenewal() {
		clearTimeout(this.renewalTimer);
		this.renewalTimer = undefined;
		const { data } = await this.request<VaultResponse<VaultTokenInfo>>({
			method: 'GET',
			url: 'auth/token/lookup-self',
			json: true,
		});
		if (!data.renewable || data.expire_time === null) return;
		const delay = (new Date(data.expire_time).getTime() - Date.now()) / 2;
		this.renewalTimer = setTimeout(async () => await this.renewToken(), delay);
	}

	private async renewToken() {
		this.renewalTimer = undefined;
		try {
			await this.request({ method: 'POST', url: 'auth/token/renew-self' });
		} catch {
			await this.connect();
			return;
		}
		try {
			await this.scheduleRenewal();
		} catch {
			// Without a new expiry time there is no next renewal.
		}
	}

	/** The KV mount, version and folder of the settings, when the settings name a mount. */
	private manualMount() {
		const { kvMountPath, kvVersion, kvSecretPath } = this.settings;
		if (!kvMountPath) return undefined;
		const mount = kvMountPath.endsWith('/') ? kvMountPath : `${kvMountPath}/`;
		const version = kvVersion === '1' ? '1' : '2';
		const folder =
			!kvSecretPath || kvSecretPath.endsWith('/') ? (kvSecretPath ?? '') : `${kvSecretPath}/`;
		return { mount, version, folder, listPath: this.listPath(mount, version, folder) };
	}

	private listPath(mount: string, version: string, path: string) {
		return version === '2' ? `${mount}metadata/${path}` : `${mount}${path}`;
	}

	/**
	 * The secrets of a folder, or null when the folder cannot be listed. `relative` is the path
	 * of the folder under `base`. A subfolder gets the name of its path under `base`, without the
	 * trailing slash, so a folder two levels deep is named like `a/b`.
	 */
	private async readFolder(
		mount: string,
		version: string,
		base: string,
		relative: string,
	): Promise<IDataObject | null> {
		let keys: string[];
		try {
			const { data } = await this.request<VaultResponse<{ keys: string[] }>>({
				method: LIST,
				url: this.listPath(mount, version, `${base}${relative}`),
			});
			keys = data.keys;
		} catch {
			return null;
		}
		const entries = await Promise.all(
			keys.map(async (key): Promise<[string, IDataObject] | null> => {
				if (key.endsWith('/')) {
					const folder = await this.readFolder(mount, version, base, `${relative}${key}`);
					return folder === null ? null : [`${relative}${key}`.slice(0, -1), folder];
				}
				const secret = await this.readSecret(mount, version, `${base}${relative}${key}`);
				return secret === null ? null : [key, secret];
			}),
		);
		const folder: IDataObject = {};
		for (const entry of entries) {
			if (entry !== null) folder[entry[0]] = entry[1];
		}
		return folder;
	}

	private async readSecret(mount: string, version: string, path: string) {
		try {
			if (version === '2') {
				const { data } = await this.request<VaultResponse<{ data: IDataObject }>>({
					method: 'GET',
					url: `${mount}data/${path}`,
				});
				return data.data;
			}
			const { data } = await this.request<VaultResponse<IDataObject>>({
				method: 'GET',
				url: `${mount}${path}`,
			});
			return data;
		} catch {
			return null;
		}
	}
}
