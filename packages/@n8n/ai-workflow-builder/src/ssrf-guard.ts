// Fork code (not in upstream n8n): a guard of outgoing requests that allows each address. The n8n
// server uses it when the SSRF protection is off. See `../FORK.md`.
import type { SsrfBridge } from '@n8n/backend-network';
import { createResultOk } from '@n8n/utils/result';
import { lookup } from 'node:dns';

export type SsrfGuard = Pick<
	SsrfBridge,
	'validateUrl' | 'validateRedirectSync' | 'createSecureLookup'
>;

export function createPassthroughSsrfGuard(): SsrfGuard {
	return {
		validateUrl: async () => createResultOk(undefined),
		validateRedirectSync: () => {},
		createSecureLookup: () => lookup,
	};
}
