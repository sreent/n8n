import { declareCapability } from '@n8n/frontend-module-sdk';

/**
 * Closes a modal in the shell modal registry. The shell provides it in
 * `capabilities.manifest.ts`, because a module cannot reach `ui.store`.
 */
export const sendCopyModalCloser =
	declareCapability<(modalKey: string) => void>('send-copy-modal-closer');
