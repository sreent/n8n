import type { ICredentialDataDecryptedObject } from 'n8n-workflow';
import { jsonParse } from 'n8n-workflow';
import { Cipher } from 'n8n-core';
import { CredentialResolverDataNotFoundError } from '@n8n/decorators';

/** Encrypts the data of a private credential for a storage. */
export async function encryptData(cipher: Cipher, data: ICredentialDataDecryptedObject) {
	return await cipher.encryptV2(JSON.stringify(data));
}

/** Decrypts the stored data of a private credential. Throws when there is no data. */
export async function decryptData(cipher: Cipher, stored: string | null) {
	if (stored === null) throw new CredentialResolverDataNotFoundError();
	return jsonParse<ICredentialDataDecryptedObject>(await cipher.decryptV2(stored));
}
