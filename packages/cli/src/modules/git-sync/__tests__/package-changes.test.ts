import type { WorkflowBaseline } from '../git-sync.types';
import {
	changesBetweenPackages,
	changesFromDiff,
	changesSinceBaseline,
	collectWorkflowSnapshots,
	findConflicts,
	metadataPathsById,
	parseWorkflowFilePath,
	publishStateOf,
	toPackagePath,
} from '../package/package-changes';

const names = new Map([
	['wf1', 'Alpha'],
	['wf2', 'Beta'],
	['wf3', 'Gamma'],
]);

describe('parseWorkflowFilePath', () => {
	it('reads the ID after the last hyphen of the folder name', () => {
		expect(parseWorkflowFilePath('workflows/my-daily-report-AbC123_x/workflow.json')).toEqual({
			id: 'AbC123_x',
			kind: 'workflow',
		});
		expect(parseWorkflowFilePath('workflows/workflow-wf1/workflow-metadata.json')).toEqual({
			id: 'wf1',
			kind: 'metadata',
		});
	});

	it.each([
		'manifest.json',
		'credentials/basic-c1/credential.json',
		'workflows/no-id/other.json',
		'workflows/nested/x-wf1/workflow.json',
		'folders/f-1/workflows/x-wf1/workflow.json',
		'workflows/x-__proto__/workflow.json',
		'workflows/x-constructor/workflow.json',
	])('ignores %s', (path) => {
		expect(parseWorkflowFilePath(path)).toBeNull();
	});
});

describe('toPackagePath', () => {
	it('removes the package folder', () => {
		expect(toPackagePath('n8n/flows/manifest.json', 'n8n/flows')).toBe('manifest.json');
		expect(toPackagePath('README.md', 'n8n')).toBeNull();
		expect(toPackagePath('n8n-other/manifest.json', 'n8n')).toBeNull();
		expect(toPackagePath('manifest.json', '')).toBe('manifest.json');
	});
});

describe('publishStateOf', () => {
	it('reads the publish state the same way the import does', () => {
		expect(publishStateOf('{"versionId":"v2","publishedVersionId":null}')).toBe('unpublished');
		expect(publishStateOf('{"versionId":"v2","publishedVersionId":"v2"}')).toBe('published');
		expect(publishStateOf('{"versionId":"v2","publishedVersionId":"v1"}')).toBe(
			'published-other-version',
		);
	});

	it.each(['not json', '[]', '{"publishedVersionId":null}', '{"versionId":"v1"}'])(
		'returns undefined for %s',
		(content) => {
			expect(publishStateOf(content)).toBeUndefined();
		},
	);
});

describe('collectWorkflowSnapshots', () => {
	const files = [
		{ path: 'manifest.json', blobSha: 'm' },
		{ path: 'workflows/alpha-wf1/workflow.json', blobSha: 'w1' },
		{ path: 'workflows/alpha-wf1/workflow-metadata.json', blobSha: 'm1' },
		{ path: 'workflows/beta-wf2/workflow.json', blobSha: 'w2' },
		{ path: 'workflows/orphan-wf9/workflow-metadata.json', blobSha: 'm9' },
	];

	it('groups the workflow hashes by ID', () => {
		expect(Object.fromEntries(collectWorkflowSnapshots(files))).toEqual({
			wf1: { workflow: 'w1' },
			wf2: { workflow: 'w2' },
		});
	});

	it('adds the publish state when the metadata contents are given', () => {
		const contents = new Map([
			['workflows/alpha-wf1/workflow-metadata.json', '{"versionId":"a","publishedVersionId":"a"}'],
		]);

		expect(collectWorkflowSnapshots(files, contents).get('wf1')).toEqual({
			workflow: 'w1',
			publishState: 'published',
		});
	});

	it('finds the metadata file of each workflow', () => {
		expect(Object.fromEntries(metadataPathsById(files))).toEqual({
			wf1: 'workflows/alpha-wf1/workflow-metadata.json',
			wf9: 'workflows/orphan-wf9/workflow-metadata.json',
		});
	});
});

describe('changesSinceBaseline', () => {
	it('finds created, modified and deleted workflows', () => {
		const current = new Map<string, WorkflowBaseline>([
			['wf1', { workflow: 'w1', publishState: 'published' }],
			['wf2', { workflow: 'w2', publishState: 'published' }],
			['wf3', { workflow: 'w3-edited', publishState: 'unpublished' }],
			['wf5', { workflow: 'w5', publishState: 'unpublished' }],
		]);
		const baseline: Record<string, WorkflowBaseline> = {
			wf1: { workflow: 'w1', publishState: 'published' },
			wf2: { workflow: 'w2', publishState: 'unpublished' },
			wf3: { workflow: 'w3', publishState: 'unpublished' },
			wf4: { workflow: 'w4', publishState: 'unpublished' },
		};
		const allNames = new Map([...names, ['wf4', 'Delta']]);

		expect(changesSinceBaseline(current, baseline, allNames)).toEqual([
			{ id: 'wf5', name: 'wf5', change: 'created' },
			{ id: 'wf2', name: 'Beta', change: 'modified' },
			{ id: 'wf3', name: 'Gamma', change: 'modified' },
			{ id: 'wf4', name: 'Delta', change: 'deleted' },
		]);
	});
});

describe('changesBetweenPackages', () => {
	it('compares the workflow files only', () => {
		const source = new Map<string, WorkflowBaseline>([
			['wf1', { workflow: 'same', publishState: 'published' }],
			['wf2', { workflow: 'new-content' }],
			['wf3', { workflow: 'only-here' }],
		]);
		const target = new Map<string, WorkflowBaseline>([
			['wf1', { workflow: 'same', publishState: 'unpublished' }],
			['wf2', { workflow: 'old-content' }],
		]);

		expect(changesBetweenPackages(source, target, names)).toEqual([
			{ id: 'wf3', name: 'Gamma', change: 'created' },
			{ id: 'wf2', name: 'Beta', change: 'modified' },
		]);
	});
});

describe('changesFromDiff', () => {
	it('turns file changes into workflow changes', () => {
		const changes = changesFromDiff(
			[
				{ status: 'A', path: 'workflows/alpha-wf1/workflow.json' },
				{ status: 'A', path: 'workflows/alpha-wf1/workflow-metadata.json' },
				{ status: 'M', path: 'workflows/beta-wf2/workflow-metadata.json' },
				{ status: 'D', path: 'workflows/gamma-wf3/workflow.json' },
				{ status: 'M', path: 'manifest.json' },
			],
			names,
		);

		expect(changes).toEqual([
			{ id: 'wf1', name: 'Alpha', change: 'created' },
			{ id: 'wf2', name: 'Beta', change: 'modified' },
			{ id: 'wf3', name: 'Gamma', change: 'deleted' },
		]);
	});

	it('treats a renamed workflow folder as a modification', () => {
		const changes = changesFromDiff(
			[
				{ status: 'A', path: 'workflows/new-name-wf1/workflow.json' },
				{ status: 'D', path: 'workflows/old-name-wf1/workflow.json' },
			],
			names,
		);

		expect(changes).toEqual([{ id: 'wf1', name: 'Alpha', change: 'modified' }]);
	});
});

describe('findConflicts', () => {
	it('returns the workflows that changed on both sides', () => {
		const outgoing = [
			{ id: 'wf1', name: 'Alpha', change: 'modified' as const },
			{ id: 'wf2', name: 'Beta', change: 'created' as const },
		];
		const incoming = [{ id: 'wf1', name: 'Alpha', change: 'modified' as const }];

		expect(findConflicts(outgoing, incoming)).toEqual([outgoing[0]]);
	});
});
