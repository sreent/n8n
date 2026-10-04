import type { MaskLevels, Scope, ScopeLevels } from '../types';

/**
 * Combine the scopes of all levels into one set. A sharing mask keeps only its own scopes of the
 * project and resource levels. A mask never removes a global scope.
 */
export function combineScopes(levels: ScopeLevels, masks?: MaskLevels): Set<Scope> {
	const applyMask = (scopes: Scope[] = []) =>
		masks ? scopes.filter((scope) => masks.sharing.includes(scope)) : scopes;

	return new Set([...levels.global, ...applyMask(levels.project), ...applyMask(levels.resource)]);
}
