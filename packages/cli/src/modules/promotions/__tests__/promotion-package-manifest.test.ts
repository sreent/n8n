import { mergeSelectionManifest } from '../promotion-package-manifest';

const base = {
	packageFormatVersion: '1' as const,
	sourceN8nVersion: '1.0.0',
	sourceId: 'source',
};

const workflow = (id: string, target: string) => ({ id, name: id, target });
const usedBy = (...ids: string[]) => ids.map((id) => ({ kind: 'workflow' as const, id }));

describe('mergeSelectionManifest', () => {
	const old = {
		...base,
		exportedAt: '2026-01-01T00:00:00.000Z',
		workflows: [
			workflow('wf1', 'projects/a-p1/folders/f-1/workflows/one-wf1'),
			workflow('wf2', 'projects/a-p1/workflows/two-wf2'),
			workflow('wf4', 'projects/b-p2/workflows/four-wf4'),
		],
		projects: [workflow('p1', 'projects/a-p1'), workflow('p2', 'projects/b-p2')],
		variables: [
			workflow('v1', 'variables/global-v1'),
			workflow('v2', 'projects/a-p1/variables/team-v2'),
		],
		requirements: {
			variables: [
				{ name: 'GLOBAL', usedBy: usedBy('wf1') },
				{ name: 'TEAM', usedBy: usedBy('wf2') },
			],
			nodeTypes: [
				{
					type: 'n8n-nodes-base.httpRequest',
					typeVersion: 1,
					usedBy: usedBy('wf1', 'wf2', 'wf4'),
				},
			],
		},
	};

	it('replaces a selected workflow and keeps the others', () => {
		const selection = {
			...base,
			exportedAt: '2026-02-01T00:00:00.000Z',
			workflows: [workflow('wf1', 'projects/a-p1/folders/f-1/workflows/one-wf1')],
			projects: [workflow('p1', 'projects/a-p1')],
			variables: [workflow('v1', 'variables/global-v1')],
			requirements: {
				variables: [{ name: 'GLOBAL', usedBy: usedBy('wf1') }],
				nodeTypes: [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 1, usedBy: usedBy('wf1') }],
			},
		};

		const merged = mergeSelectionManifest(old, selection, new Set(['wf1']));

		expect(merged.exportedAt).toBe('2026-02-01T00:00:00.000Z');
		expect(merged.workflows?.map(({ id }) => id)).toEqual(['wf1', 'wf2', 'wf4']);
		expect(merged.variables?.map(({ id }) => id)).toEqual(['v1', 'v2']);
		expect(merged.requirements?.variables).toEqual([
			{ name: 'TEAM', usedBy: usedBy('wf2') },
			{ name: 'GLOBAL', usedBy: usedBy('wf1') },
		]);
		expect(merged.requirements?.nodeTypes?.[0].usedBy).toEqual(usedBy('wf1', 'wf2', 'wf4'));
	});

	it('adds a new workflow in the order of the folders, and removes a deleted one', () => {
		const selection = {
			...base,
			exportedAt: '2026-02-01T00:00:00.000Z',
			workflows: [workflow('wf3', 'projects/a-p1/workflows/three-wf3')],
			projects: [workflow('p1', 'projects/a-p1')],
			requirements: {
				nodeTypes: [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 1, usedBy: usedBy('wf3') }],
			},
		};

		const merged = mergeSelectionManifest(old, selection, new Set(['wf3', 'wf2']));

		expect(merged.workflows?.map(({ id }) => id)).toEqual(['wf1', 'wf3', 'wf4']);
		expect(merged.requirements?.variables).toEqual([{ name: 'GLOBAL', usedBy: usedBy('wf1') }]);
		expect(merged.requirements?.nodeTypes?.[0].usedBy).toEqual(usedBy('wf1', 'wf3', 'wf4'));
	});

	it('keeps the uses by agents when it replaces a workflow', () => {
		const agent = { kind: 'agent' as const, id: 'agent-1' };
		const credential = { id: 'c1', name: 'Basic', type: 'httpBasicAuth' };
		const selection = {
			...base,
			exportedAt: '2026-02-01T00:00:00.000Z',
			workflows: [workflow('wf1', 'projects/a-p1/folders/f-1/workflows/one-wf1')],
		};

		const merged = mergeSelectionManifest(
			{
				...old,
				requirements: { credentials: [{ ...credential, usedBy: [...usedBy('wf1'), agent] }] },
			},
			selection,
			new Set(['wf1']),
		);

		expect(merged.requirements).toEqual({ credentials: [{ ...credential, usedBy: [agent] }] });
	});
});
