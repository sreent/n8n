import type { EvaluationMetric } from '@n8n/api-types';
import type { CredentialsEntity, CredentialsRepository } from '@n8n/db';
import { mock } from 'vitest-mock-extended';
import type { INode, INodeType, IVersionedNodeType, IWorkflowBase } from 'n8n-workflow';

import type { NodeTypes } from '@/node-types';

import { WorkflowCompilerService } from '../workflow-compiler.service';

const node = (name: string, x: number): INode => ({
	id: name,
	name,
	type: 'n8n-nodes-base.set',
	typeVersion: 3.4,
	position: [x, 100],
	parameters: {},
});

// A plain object: the compiler copies the nodes, and a mock proxy cannot be copied.
const workflow: IWorkflowBase = {
	id: 'workflow-1',
	name: 'Evaluated',
	active: false,
	isArchived: false,
	activeVersionId: null,
	createdAt: new Date(),
	updatedAt: new Date(),
	nodes: [node('Start', 0), node('Prepare', 200), node('Answer', 400)],
	connections: {
		Start: { main: [[{ node: 'Prepare', type: 'main', index: 0 }]] },
		Prepare: { main: [[{ node: 'Answer', type: 'main', index: 0 }]] },
	},
};

const config = (metrics: EvaluationMetric[], endNodeName = 'Answer') => ({
	datasetSource: 'data_table' as const,
	datasetRef: { dataTableId: 'table-1' },
	startNodeName: 'Prepare',
	endNodeName,
	metrics,
});

const booleanMetric = (expression: string): EvaluationMetric => ({
	id: 'm1',
	name: 'Correct',
	type: 'expression',
	config: { expression, outputType: 'boolean' },
});

const judgeMetric: EvaluationMetric = {
	id: 'judge',
	name: 'Judge',
	type: 'llm_judge',
	config: {
		preset: 'correctness',
		provider: 'test.chatModel',
		credentialId: 'credential-1',
		model: 'model-1',
		outputType: 'numeric',
		inputs: { actualAnswer: '={{ $json.answer }}', expectedAnswer: '={{ $json.expected }}' },
	},
};

const chatModel = (version: number | number[], defaultVersion?: number) =>
	mock<INodeType>({
		description: {
			version,
			defaultVersion,
			properties: [{ displayName: 'Model', name: 'model', type: 'string', default: '' }],
		},
	});

describe('WorkflowCompilerService', () => {
	const nodeTypes = mock<NodeTypes>();
	const credentialsRepository = mock<CredentialsRepository>();
	const compiler = new WorkflowCompilerService(nodeTypes, credentialsRepository);

	const metricValue = async (expression: string) => {
		const compiled = await compiler.compile(workflow, config([booleanMetric(expression)]));
		const metricNode = compiled.nodes.find((n) => n.name === '__eval_metric_m1');
		const { assignments } = metricNode?.parameters.metrics as {
			assignments: Array<{ value: string }>;
		};
		return assignments[0].value;
	};

	beforeEach(() => {
		vi.resetAllMocks();
		credentialsRepository.findOneBy.mockResolvedValue(
			mock<CredentialsEntity>({ id: 'credential-1', type: 'testApi' }),
		);
	});

	describe('boolean metrics', () => {
		it('wraps a single expression in a condition that gives 1 or 0', async () => {
			expect(await metricValue('={{ $json.final === $json.expected }}')).toBe(
				'={{ ($json.final === $json.expected) ? 1 : 0 }}',
			);
		});

		it.each([
			['true', '1'],
			['FALSE', '0'],
			[' 1 ', '1'],
			['0', '0'],
		])('turns the plain value "%s" into %s', async (expression, expected) => {
			expect(await metricValue(expression)).toBe(expected);
		});

		it('keeps a plain value that n8n cannot read as a boolean', async () => {
			expect(await metricValue('yes')).toBe('yes');
		});
	});

	describe('end node', () => {
		it('connects the end node to the metric nodes and drops what came after it', async () => {
			const compiled = await compiler.compile(
				workflow,
				config([booleanMetric('={{ true }}')], 'Prepare'),
			);

			expect(compiled.connections.Prepare).toEqual({
				main: [[{ node: '__eval_metric_m1', type: 'main', index: 0 }]],
			});
		});

		it('adds the metric nodes without a connection when the workflow has no end node', async () => {
			const compiled = await compiler.compile(
				workflow,
				config([booleanMetric('={{ true }}')], 'Missing'),
			);

			const metricNode = compiled.nodes.find((n) => n.name === '__eval_metric_m1');
			expect(metricNode?.position).toEqual([840, 100]);
			expect(compiled.connections.Missing).toBeUndefined();
			expect(compiled.connections.Prepare).toEqual({
				main: [[{ node: 'Answer', type: 'main', index: 0 }]],
			});
		});
	});

	describe('chat model of an LLM judge', () => {
		const modelNode = async () => {
			const compiled = await compiler.compile(workflow, config([judgeMetric]));
			return compiled.nodes.find((n) => n.name === '__eval_model_judge');
		};

		it('uses the default version of a node type with a version list', async () => {
			const nodeType = chatModel([1, 1.1, 1.2], 1.1);
			nodeTypes.getByName.mockReturnValue(nodeType);
			nodeTypes.getByNameAndVersion.mockReturnValue(nodeType);

			expect(await modelNode()).toMatchObject({
				type: 'test.chatModel',
				typeVersion: 1.1,
				credentials: { testApi: { id: 'credential-1', name: '' } },
				parameters: { model: 'model-1' },
			});
			expect(nodeTypes.getByNameAndVersion).toHaveBeenCalledWith('test.chatModel', 1.1);
		});

		it('uses the newest version of a node type without a default version', async () => {
			const nodeType = chatModel([1, 1.3, 1.2]);
			nodeTypes.getByName.mockReturnValue(nodeType);
			nodeTypes.getByNameAndVersion.mockReturnValue(nodeType);

			expect((await modelNode())?.typeVersion).toBe(1.3);
		});

		it('uses the current version of a versioned node type', async () => {
			const versioned = mock<IVersionedNodeType>({
				nodeVersions: {},
				currentVersion: 2,
				description: { defaultVersion: undefined },
			});
			nodeTypes.getByName.mockReturnValue(versioned);
			nodeTypes.getByNameAndVersion.mockReturnValue(chatModel(2));

			expect((await modelNode())?.typeVersion).toBe(2);
			expect(nodeTypes.getByNameAndVersion).toHaveBeenCalledWith('test.chatModel', 2);
		});
	});
});
