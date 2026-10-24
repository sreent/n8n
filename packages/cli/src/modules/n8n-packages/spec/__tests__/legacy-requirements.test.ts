// Fork test (not in upstream n8n): the reader of the requirements of older packages. See
// ../legacy-requirements.ts.
import { upgradeLegacyRequirements } from '../legacy-requirements';
import { packageManifestSchema } from '../manifest.schema';

const manifest = {
	packageFormatVersion: '1',
	exportedAt: '2026-05-18T12:00:00.000Z',
	sourceN8nVersion: '1.0.0',
	sourceId: 'instance-abc',
	workflows: [{ id: 'wf-1', name: 'One', target: 'workflows/one-wf-1' }],
};

const usedBy = (...ids: string[]) => ids.map((id) => ({ kind: 'workflow', id }));

describe('upgradeLegacyRequirements', () => {
	it('reads usedByWorkflows as workflow consumers in each list', () => {
		expect(
			upgradeLegacyRequirements({
				credentials: [
					{ id: 'c1', name: 'Basic', type: 'httpBasicAuth', usedByWorkflows: ['wf-1'] },
				],
				dataTables: [{ id: 'd1', name: 'Orders', usedByWorkflows: ['wf-1', 'wf-2'] }],
				workflows: [{ id: 'wf-3', usedByWorkflows: ['wf-1'] }],
				variables: [{ name: 'REGION', usedByWorkflows: ['wf-2'] }],
				tags: [{ id: 't1', name: 'Sales', usedByWorkflows: ['wf-1'] }],
				nodeTypes: [{ type: 'n8n-nodes-base.set', typeVersion: 3, usedByWorkflows: ['wf-1'] }],
			}),
		).toEqual({
			credentials: [{ id: 'c1', name: 'Basic', type: 'httpBasicAuth', usedBy: usedBy('wf-1') }],
			dataTables: [{ id: 'd1', name: 'Orders', usedBy: usedBy('wf-1', 'wf-2') }],
			workflows: [{ id: 'wf-3', usedBy: usedBy('wf-1') }],
			variables: [{ name: 'REGION', usedBy: usedBy('wf-2') }],
			tags: [{ id: 't1', name: 'Sales', usedBy: usedBy('wf-1') }],
			nodeTypes: [{ type: 'n8n-nodes-base.set', typeVersion: 3, usedBy: usedBy('wf-1') }],
		});
	});

	it('keeps the requirements that already have usedBy', () => {
		const requirements = {
			agents: [{ id: 'a1', usedBy: [{ kind: 'agent', id: 'a2' }] }],
			variables: [{ name: 'REGION', usedBy: usedBy('wf-1'), usedByWorkflows: ['wf-9'] }],
		};

		expect(upgradeLegacyRequirements(requirements)).toEqual(requirements);
	});

	it.each([undefined, null, 'text', 3, ['list']])('keeps the value %j', (value) => {
		expect(upgradeLegacyRequirements(value)).toEqual(value);
	});

	it('keeps an entry whose usedByWorkflows is not a list, so that the schema rejects it', () => {
		const requirements = { variables: [{ name: 'REGION', usedByWorkflows: 'wf-1' }] };

		expect(upgradeLegacyRequirements(requirements)).toEqual(requirements);
		expect(packageManifestSchema.safeParse({ ...manifest, requirements }).success).toBe(false);
	});
});

describe('packageManifestSchema with the requirements of an older package', () => {
	it('parses them with usedBy', () => {
		const parsed = packageManifestSchema.parse({
			...manifest,
			requirements: {
				nodeTypes: [{ type: 'n8n-nodes-base.set', typeVersion: 3, usedByWorkflows: ['wf-1'] }],
			},
		});

		expect(parsed.requirements).toEqual({
			nodeTypes: [{ type: 'n8n-nodes-base.set', typeVersion: 3, usedBy: usedBy('wf-1') }],
		});
	});

	it('parses a manifest without requirements', () => {
		expect(packageManifestSchema.parse(manifest).requirements).toBeUndefined();
	});
});
