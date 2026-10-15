import type { ICredentialContext } from 'n8n-workflow';

import { CredentialResolutionError } from '../../errors/credential-resolution.error';

/** The configuration of a resolver that an identifier reads. */
export type IdentifierOptions = Record<string, unknown>;

/** Resolves the subject that an identity stands for: the key of the stored data. */
export interface ITokenIdentifier {
	/** The subject. Throws when the identity is not valid. */
	resolve(
		context: ICredentialContext,
		identifierOptions: IdentifierOptions,
		executionId?: string,
	): Promise<string>;
}

/** The identity of a request is not valid for the resolver. */
export class IdentifierValidationError extends CredentialResolutionError {}
