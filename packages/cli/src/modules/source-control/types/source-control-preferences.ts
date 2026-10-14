export type KeyPairType = 'ed25519' | 'rsa';

export type SourceControlConnectionType = 'ssh' | 'https';

/**
 * The preferences of source control. The settings row `features.sourceControl` stores them
 * without the public key and without the HTTPS credentials, which have rows of their own.
 */
export interface SourceControlPreferences {
	connected?: boolean;
	repositoryUrl?: string;
	branchName?: string;
	branchReadOnly?: boolean;
	branchColor?: string;
	publicKey?: string;
	/** On a connection: make the work folder and check out the branch. `true` when not given. */
	initRepo?: boolean;
	/** The type of the key pair. The original stores any type; a type other than `ed25519` makes an RSA key. */
	keyGeneratorType?: string;
	connectionType?: SourceControlConnectionType;
	httpsUsername?: string;
	httpsPassword?: string;
}

/** The keys of the stored preferences, in the order of the settings row. */
export const STORED_PREFERENCE_KEYS = [
	'branchName',
	'connectionType',
	'connected',
	'repositoryUrl',
	'branchReadOnly',
	'branchColor',
	'keyGeneratorType',
] as const;
