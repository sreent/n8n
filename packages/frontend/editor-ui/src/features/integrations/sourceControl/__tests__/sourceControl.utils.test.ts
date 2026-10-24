// Fork test (not in upstream n8n): the tooltip of the controls that a protected instance locks.
// See ../FORK.md.
import { getProtectedInstanceTooltip } from '../sourceControl.utils';

describe('getProtectedInstanceTooltip', () => {
	it('gives the protected instance text without the link', () => {
		expect(getProtectedInstanceTooltip()).toBe(
			'This is a protected instance where modifications are restricted.',
		);
	});
});
