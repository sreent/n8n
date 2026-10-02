import { errorCode, errorConflicts } from './git-sync.utils';

describe('errorCode', () => {
	it('reads the code from the error meta', () => {
		expect(errorCode({ meta: { code: 'GIT_SYNC_PULL_FIRST' } })).toBe('GIT_SYNC_PULL_FIRST');
	});

	it.each([undefined, null, 'text', new Error('plain'), { meta: { code: 3 } }, { meta: [] }])(
		'returns undefined for %j',
		(error) => {
			expect(errorCode(error)).toBeUndefined();
		},
	);
});

describe('errorConflicts', () => {
	it('keeps only valid workflow changes', () => {
		const error = {
			meta: {
				conflicts: [
					{ id: 'wf1', name: 'Report', change: 'modified' },
					{ id: 'wf2', name: 'Broken', change: 'renamed' },
					{ id: 3, name: 'No id', change: 'created' },
					'text',
				],
			},
		};

		expect(errorConflicts(error)).toEqual([{ id: 'wf1', name: 'Report', change: 'modified' }]);
	});

	it('returns an empty list without conflicts', () => {
		expect(errorConflicts(new Error('plain'))).toEqual([]);
		expect(errorConflicts({ meta: { conflicts: 'none' } })).toEqual([]);
	});
});
