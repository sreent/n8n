import type { CredentialResolverConfiguration } from '@n8n/decorators';
import { CREDENTIAL_BLANKING_VALUE, type INodeProperties } from 'n8n-workflow';

/** The names of the options of a resolver type that hold a secret (password fields). */
export function collectSecretFieldNames(options: INodeProperties[] | undefined): string[] {
	return (options ?? [])
		.filter((option) => option.typeOptions?.password === true)
		.map((option) => option.name);
}

const isSet = (value: unknown) => value !== undefined && value !== null && value !== '';

/**
 * A copy of a configuration with each secret replaced by the blanking value, for an answer of
 * the API. An expression in a secret field is a secret too.
 */
export function redactSecretConfig(
	config: CredentialResolverConfiguration,
	secretFieldNames: string[],
): CredentialResolverConfiguration {
	const redacted = { ...config };
	for (const name of secretFieldNames) {
		if (isSet(redacted[name])) redacted[name] = CREDENTIAL_BLANKING_VALUE;
	}
	return redacted;
}

/**
 * A copy of a new configuration in which each secret that the editor sent back as the blanking
 * value has its stored value again.
 */
export function restoreSecretConfig(
	config: CredentialResolverConfiguration,
	storedConfig: CredentialResolverConfiguration,
	secretFieldNames: string[],
): CredentialResolverConfiguration {
	const restored = { ...config };
	for (const name of secretFieldNames) {
		if (restored[name] === CREDENTIAL_BLANKING_VALUE) restored[name] = storedConfig[name];
	}
	return restored;
}
