import type { SecretsProviderState } from '@n8n/api-types';
import { Container } from '@n8n/di';
import type { IDataObject, INodeProperties } from 'n8n-workflow';

import { ExternalSecretsConfig } from './external-secrets.config';

export type { SecretsProviderState };

/** The stored settings of one provider. */
export interface SecretsProviderSettings<T = IDataObject> {
	connected: boolean;
	connectedAt: Date | null;
	settings: T;
}

/** The stored settings of the providers, by provider name. */
export type ExternalSecretsSettings = Record<string, SecretsProviderSettings>;

/**
 * Fork code (not in upstream n8n). The base class of a secrets provider: a connection to one
 * vault. packages/cli/src/modules/external-secrets/FORK.md describes the behaviour.
 */
export abstract class SecretsProvider {
	abstract displayName: string;

	abstract name: string;

	/** The fields of the settings form. */
	abstract properties: INodeProperties[];

	state: SecretsProviderState = 'initializing';

	abstract init(settings: SecretsProviderSettings): Promise<void>;

	/** Connect to the vault. Throw when the vault cannot be used. */
	protected abstract doConnect(): Promise<void>;

	abstract disconnect(): Promise<void>;

	/** Read the secrets from the vault again. */
	abstract update(): Promise<void>;

	/** Check the connection. The text explains a failure. */
	abstract test(): Promise<[boolean] | [boolean, string]>;

	abstract getSecret(name: string): unknown;

	abstract hasSecret(name: string): boolean;

	/** The names of the secrets, for the completions of the editor. */
	abstract getSecretNames(): string[];

	/**
	 * The state is `connecting` while `doConnect` runs, then `connected`. It is `error` when
	 * `doConnect` throws or does not end within the connect timeout. A result that comes after
	 * the timeout does not change the state. This method never throws.
	 */
	async connect(): Promise<void> {
		this.state = 'connecting';
		const timeoutMs = Container.get(ExternalSecretsConfig).connectTimeout * 1000;
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				this.doConnect(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('Connect timed out')), timeoutMs);
				}),
			]);
			this.state = 'connected';
		} catch {
			this.state = 'error';
		} finally {
			clearTimeout(timer);
		}
	}
}
