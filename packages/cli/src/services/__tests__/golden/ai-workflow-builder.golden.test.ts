// Fork test (not in upstream n8n): a black-box record of the parts of `@n8n/ai-workflow-builder` that
// the MCP tools and the builder sessions use. The snapshot was recorded against the enterprise
// package. The fork package gives the same snapshot. See
// `packages/@n8n/ai-workflow-builder/FORK.md`.
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { getSchemaBaseDirs, setSchemaBaseDirs } from '@n8n/workflow-sdk';
import type { INodeTypeDescription } from 'n8n-workflow';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as subject from './subject';

const { ParseValidateHandler, getWarningKey, stripImportStatements } = subject;

// #region Node types

/** The built node descriptions of the two node packages, from the dependencies of cli. */
const CLI_ROOT = join(__dirname, '..', '..', '..', '..');
const PACKAGES = ['n8n-nodes-base', '@n8n/n8n-nodes-langchain'];

const versionsOf = (description: INodeTypeDescription) =>
	Array.isArray(description.version) ? description.version : [description.version];

/** The descriptions of the built nodes, by the full node type name. */
function loadDescriptions() {
	const byType = new Map<string, INodeTypeDescription[]>();
	for (const packageName of PACKAGES) {
		const file = join(CLI_ROOT, 'node_modules', packageName, 'dist', 'types', 'nodes.json');
		const descriptions: INodeTypeDescription[] = JSON.parse(readFileSync(file, 'utf-8'));
		for (const description of descriptions) {
			const type = `${packageName}.${description.name}`;
			const list = byType.get(type) ?? [];
			list.push({ ...description, name: type });
			byType.set(type, list);
		}
	}
	return byType;
}

const descriptions = loadDescriptions();

/** A node types provider as the n8n server gives one: it throws for an unknown type. */
const nodeTypes = {
	getByNameAndVersion(type: string, version?: number) {
		const list = descriptions.get(type);
		if (!list) throw new Error(`Unrecognized node type: ${type}`);
		const latest = (description: INodeTypeDescription) => Math.max(...versionsOf(description));
		const match =
			version === undefined
				? [...list].sort((a, b) => latest(b) - latest(a))[0]
				: list.find((description) => versionsOf(description).includes(version));
		return { description: match ?? list[0] };
	},
	getByName(type: string) {
		return nodeTypes.getByNameAndVersion(type);
	},
	getKnownTypes() {
		return {};
	},
};

// #endregion

// #region Helpers

function describeError(error: unknown) {
	if (!(error instanceof Error)) return { thrown: String(error) };
	return {
		name: error.name,
		message: error.message,
		isSyntaxError: error instanceof SyntaxError,
		ownKeys: Object.keys(error).sort(),
	};
}

async function outcome<T>(run: () => T | Promise<T>) {
	try {
		return { result: await run() };
	} catch (error) {
		return { error: describeError(error) };
	}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Replaces random IDs by labels in their first order. Stable IDs stay. */
function labelIds(value: unknown, stable: boolean) {
	if (stable) return value;
	const labels = new Map<string, string>();
	const walk = (item: unknown): unknown => {
		if (typeof item === 'string' && UUID.test(item)) {
			if (!labels.has(item)) labels.set(item, `<id-${labels.size + 1}>`);
			return labels.get(item);
		}
		if (Array.isArray(item)) return item.map(walk);
		if (item && typeof item === 'object') {
			return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
		}
		return item;
	};
	return walk(value);
}

const nodeIds = (value: unknown) =>
	value && typeof value === 'object' && 'workflow' in value
		? JSON.stringify(
				(value as { workflow: { nodes: Array<{ id?: string }> } }).workflow.nodes.map(
					(node) => node.id,
				),
			)
		: '';

/** The SDK gives each webhook a random webhook ID, and each sticky note a random name suffix. */
function normalizeRandom(value: unknown): unknown {
	if (typeof value === 'string')
		return value.replace(/^Sticky Note [0-9a-f]{8}$/, 'Sticky Note <suffix>');
	if (Array.isArray(value)) return value.map(normalizeRandom);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, inner]) => [
				key,
				key === 'webhookId' && typeof inner === 'string' && UUID.test(inner)
					? '<webhook-id>'
					: normalizeRandom(inner),
			]),
		);
	}
	return value;
}

/** Parses the code twice, as the MCP tools do, and records the result or the error. */
async function parse(code: string) {
	const handler = new ParseValidateHandler({
		generatePinData: false,
		nodeTypesProvider: nodeTypes,
	});
	const first = await outcome(
		async () => await handler.parseAndValidate(stripImportStatements(code)),
	);
	const second = await outcome(
		async () => await handler.parseAndValidate(stripImportStatements(code)),
	);
	if ('error' in first) return first;
	const stable = nodeIds(first.result) === nodeIds('result' in second ? second.result : undefined);
	const result: unknown = first.result;
	const keys = result && typeof result === 'object' ? Object.keys(result).sort() : [];
	const warnings =
		result && typeof result === 'object' && 'warnings' in result && Array.isArray(result.warnings)
			? result.warnings
			: [];
	return {
		keys,
		stableIds: stable,
		result: normalizeRandom(labelIds(result, stable)),
		warningKeys: warnings.map((warning) => getWarningKey(warning)),
	};
}

async function validateJson(workflow: unknown) {
	const handler = new ParseValidateHandler({
		generatePinData: false,
		nodeTypesProvider: nodeTypes,
	});
	return await outcome(() =>
		handler.validateJSON(workflow as Parameters<typeof handler.validateJSON>[0]),
	);
}

// #endregion

// #region Samples

const IMPORT =
	"import { workflow, node, trigger, sticky, placeholder, newCredential, ifElse, switchCase, merge, splitInBatches, nextBatch, languageModel, memory, tool, fromAi, expr } from '@n8n/workflow-sdk';\n\n";

const START =
	"const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Start' } });\n";
const noOp = (variable: string, name: string) =>
	`const ${variable} = node({ type: 'n8n-nodes-base.noOp', version: 1, config: { name: '${name}' } });\n`;

const CODE_SAMPLES: Record<string, string> = {
	'a linear chain': `${IMPORT}${START}
const fetchData = node({ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: { name: 'Fetch Data', parameters: { method: 'GET', url: 'https://example.com/items' } } });
const shape = node({ type: 'n8n-nodes-base.set', version: 3.4, config: { name: 'Shape', parameters: { mode: 'manual', assignments: { assignments: [{ id: 'a1', name: 'title', value: '={{ $json.title }}', type: 'string' }] } } } });
export default workflow('wf-1', 'Linear').add(start).to(fetchData).to(shape);`,
	'an AI agent with a model, a memory and a tool': `${IMPORT}
const chat = trigger({ type: '@n8n/n8n-nodes-langchain.chatTrigger', version: 1.1, config: { name: 'Chat' } });
const model = languageModel({ type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', version: 1.2, config: { name: 'Model', parameters: { model: { __rl: true, mode: 'list', value: 'gpt-4o-mini' } }, credentials: { openAiApi: newCredential('OpenAI') } } });
const mem = memory({ type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', version: 1.3, config: { name: 'Memory', parameters: { contextWindowLength: 5 } } });
const calc = tool({ type: '@n8n/n8n-nodes-langchain.toolCalculator', version: 1, config: { name: 'Calculator' } });
const agent = node({ type: '@n8n/n8n-nodes-langchain.agent', version: 1.7, config: { name: 'Agent', parameters: { promptType: 'auto' }, subnodes: { model, memory: mem, tools: [calc] } } });
export default workflow('wf-2', 'Agent').add(chat).to(agent);`,
	'an agent without a model': `${IMPORT}
const chat = trigger({ type: '@n8n/n8n-nodes-langchain.chatTrigger', version: 1.1, config: { name: 'Chat' } });
const agent = node({ type: '@n8n/n8n-nodes-langchain.agent', version: 1.7, config: { name: 'Agent', parameters: {} } });
export default workflow('wf-3', 'No model').add(chat).to(agent);`,
	'an agent with a tool that uses fromAi': `${IMPORT}
const chat = trigger({ type: '@n8n/n8n-nodes-langchain.chatTrigger', version: 1.1, config: { name: 'Chat' } });
const model = languageModel({ type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', version: 1.2, config: { name: 'Model', parameters: { model: { __rl: true, mode: 'list', value: 'gpt-4o-mini' } } } });
const wiki = tool({ type: '@n8n/n8n-nodes-langchain.toolWikipedia', version: 1, config: { name: 'Wikipedia', parameters: { query: fromAi('query', 'The search term', 'string') } } });
const agent = node({ type: '@n8n/n8n-nodes-langchain.agent', version: 1.7, config: { name: 'Agent', parameters: { promptType: 'auto' }, subnodes: { model, tools: [wiki] } } });
export default workflow('wf-4', 'From AI').add(chat).to(agent);`,
	'an IF with two branches': `${IMPORT}${START}${noOp('yes', 'Yes')}${noOp('no', 'No')}
const check = ifElse({ version: 2.2, config: { name: 'Check', parameters: { conditions: { combinator: 'and', conditions: [{ leftValue: '={{ $json.ok }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] } } } });
export default workflow('wf-5', 'Branch').add(start).to(check.onTrue(yes).onFalse(no));`,
	'a switch into a merge': `${IMPORT}${START}${noOp('a', 'A')}${noOp('b', 'B')}
const route = switchCase({ version: 3.2, config: { name: 'Route', parameters: { mode: 'expression', numberOutputs: 2, output: '={{ $json.n % 2 }}' } } });
const join = merge({ version: 3.2, config: { name: 'Join', parameters: { mode: 'append' } } });
export default workflow('wf-6', 'Switch').add(start).to(route.onCase(0, a.to(join.input(0))).onCase(1, b.to(join.input(1))));`,
	'a loop over batches': `${IMPORT}${START}${noOp('work', 'Work')}${noOp('done', 'Done')}
const loop = splitInBatches({ version: 3, config: { name: 'Loop', parameters: { batchSize: 10 } } });
export default workflow('wf-7', 'Loop').add(start).to(loop.onDone(done).onEachBatch(work.to(nextBatch(loop))));`,
	'a sticky note and a placeholder': `${IMPORT}${START}
const call = node({ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: { name: 'Call API', parameters: { method: 'GET', url: placeholder('Your API URL') } } });
const note = sticky('## Calls the API', [call], { color: 4 });
export default workflow('wf-8', 'Notes').add(start).to(call).add(note);`,
	'an expression with expr': `${IMPORT}${START}
const shape = node({ type: 'n8n-nodes-base.set', version: 3.4, config: { name: 'Shape', parameters: { mode: 'manual', assignments: { assignments: [{ id: 'a1', name: 'when', value: expr('{{ $now.toISO() }}'), type: 'string' }] } } } });
export default workflow('wf-9', 'Expr').add(start).to(shape);`,
	'a credential with newCredential': `${IMPORT}${START}
const call = node({ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: { name: 'Call API', parameters: { method: 'GET', url: 'https://example.com', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' }, credentials: { httpHeaderAuth: newCredential('My header') } } });
export default workflow('wf-10', 'Credential').add(start).to(call);`,
	'a webhook with a response': `${IMPORT}
const hook = trigger({ type: 'n8n-nodes-base.webhook', version: 2, config: { name: 'Webhook', parameters: { path: 'orders', httpMethod: 'POST', responseMode: 'responseNode' } } });
const reply = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.1, config: { name: 'Reply', parameters: { respondWith: 'json', responseBody: '={{ { ok: true } }}' } } });
export default workflow('wf-11', 'Webhook').add(hook).to(reply);`,
	'a code node': `${IMPORT}${START}
const code = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Code', parameters: { jsCode: 'return items.map((item) => ({ json: { ...item.json, done: true } }));' } } });
export default workflow('wf-12', 'Code').add(start).to(code);`,
	'sample output data': `${IMPORT}
const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Start' }, output: [{}] });
const fetchData = node({ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: { name: 'Fetch Data', parameters: { method: 'GET', url: 'https://example.com/items' } }, output: [{ id: 1, title: 'Item 1' }] });
export default workflow('wf-13', 'Output').add(start).to(fetchData);`,
	'positions in the config': `${IMPORT}
const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Start', position: [240, 300] } });
const end = node({ type: 'n8n-nodes-base.noOp', version: 1, config: { name: 'End', position: [540, 300] } });
export default workflow('wf-14', 'Positions').add(start).to(end);`,
	'an unknown node type': `${IMPORT}${START}
const mystery = node({ type: 'n8n-nodes-base.doesNotExist', version: 1, config: { name: 'Mystery' } });
export default workflow('wf-15', 'Unknown').add(start).to(mystery);`,
	'an unknown version': `${IMPORT}${START}
const shape = node({ type: 'n8n-nodes-base.set', version: 99, config: { name: 'Shape', parameters: {} } });
export default workflow('wf-16', 'Version').add(start).to(shape);`,
	'a missing required parameter': `${IMPORT}${START}
const call = node({ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: { name: 'Call API', parameters: { method: 'GET' } } });
export default workflow('wf-17', 'Required').add(start).to(call);`,
	'a parameter of the wrong type': `${IMPORT}${START}
const shape = node({ type: 'n8n-nodes-base.set', version: 3.4, config: { name: 'Shape', parameters: { mode: 123, includeOtherFields: 'yes' } } });
export default workflow('wf-18', 'Types').add(start).to(shape);`,
	'a node without a connection': `${IMPORT}${START}${noOp('orphan', 'Orphan')}
export default workflow('wf-19', 'Orphan').add(start).add(orphan);`,
	'no trigger': `${IMPORT}${noOp('only', 'Only')}
export default workflow('wf-20', 'No trigger').add(only);`,
	'two nodes with the same name': `${IMPORT}${START}${noOp('first', 'Same')}${noOp('second', 'Same')}
export default workflow('wf-21', 'Duplicate').add(start).to(first).to(second);`,
	'a plain workflow object': `export default {
	name: 'Plain',
	nodes: [
		{ id: 'n1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
		{ id: 'n2', name: 'End', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {} }
	],
	connections: { Start: { main: [[{ node: 'End', type: 'main', index: 0 }]] } }
};`,
	'a syntax error': `${IMPORT}${START}export default workflow('wf-23', 'Broken').add(start).to(`,
	'no default export': `${IMPORT}${START}const name = 'nothing';`,
	'a default export that is not a workflow': `${IMPORT}export default 42;`,
	'an unknown identifier': `${IMPORT}export default workflow('wf-26', 'Missing').add(missingThing);`,
	'code that throws': `${IMPORT}throw new Error('boom');`,
	'empty code': '',
	'a require call': `${IMPORT}const fs = require('fs');\nexport default workflow('wf-29', 'Require');`,
	'a workflow without nodes': `${IMPORT}export default workflow('wf-30', 'Empty');`,
	'an expression without the equals sign': `${IMPORT}${START}
const shape = node({ type: 'n8n-nodes-base.set', version: 3.4, config: { name: 'Shape', parameters: { mode: 'manual', assignments: { assignments: [{ id: 'a1', name: 'title', value: '{{ $json.title }}', type: 'string' }] } } } });
export default workflow('wf-31', 'Prefix').add(start).to(shape);`,
	'a merge with one input': `${IMPORT}${START}${noOp('a', 'A')}
const join = merge({ version: 3.2, config: { name: 'Join', parameters: { mode: 'append' } } });
export default workflow('wf-32', 'Merge').add(start).to(a.to(join.input(0)));`,
	'an unknown parameter of a node': `${IMPORT}${START}
const call = node({ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: { name: 'Call API', parameters: { method: 'GET', url: 'https://example.com', notAParameter: true } } });
export default workflow('wf-33', 'Unknown parameter').add(start).to(call);`,
	'a wrong option value': `${IMPORT}${START}
const call = node({ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: { name: 'Call API', parameters: { method: 'FETCH', url: 'https://example.com' } } });
export default workflow('wf-34', 'Option').add(start).to(call);`,
};

const node = (name: string, type: string, typeVersion: number, parameters = {}, id?: string) => ({
	...(id ? { id } : {}),
	name,
	type,
	typeVersion,
	position: [0, 0],
	parameters,
});
const main = (to: string) => ({ main: [[{ node: to, type: 'main', index: 0 }]] });

const JSON_SAMPLES: Record<string, unknown> = {
	'a valid chain': {
		name: 'Valid',
		nodes: [
			node('Start', 'n8n-nodes-base.manualTrigger', 1, {}, 'n1'),
			node('End', 'n8n-nodes-base.noOp', 1, {}, 'n2'),
		],
		connections: { Start: main('End') },
	},
	'an unknown node type': {
		name: 'Unknown',
		nodes: [
			node('Start', 'n8n-nodes-base.manualTrigger', 1, {}, 'n1'),
			node('Mystery', 'n8n-nodes-base.doesNotExist', 1, {}, 'n2'),
		],
		connections: { Start: main('Mystery') },
	},
	'a connection to a missing node': {
		name: 'Missing',
		nodes: [node('Start', 'n8n-nodes-base.manualTrigger', 1, {}, 'n1')],
		connections: { Start: main('Ghost') },
	},
	'no nodes': { name: 'Empty', nodes: [], connections: {} },
	'a node without a connection': {
		name: 'Orphan',
		nodes: [
			node('Start', 'n8n-nodes-base.manualTrigger', 1, {}, 'n1'),
			node('Orphan', 'n8n-nodes-base.noOp', 1, {}, 'n2'),
		],
		connections: {},
	},
	'an agent without a model': {
		name: 'Agent',
		nodes: [
			node('Chat', '@n8n/n8n-nodes-langchain.chatTrigger', 1.1, {}, 'n1'),
			node('Agent', '@n8n/n8n-nodes-langchain.agent', 1.7, {}, 'n2'),
		],
		connections: { Chat: main('Agent') },
	},
	'an agent with a model': {
		name: 'Agent',
		nodes: [
			node('Chat', '@n8n/n8n-nodes-langchain.chatTrigger', 1.1, {}, 'n1'),
			node('Agent', '@n8n/n8n-nodes-langchain.agent', 1.7, { promptType: 'auto' }, 'n2'),
			node(
				'Model',
				'@n8n/n8n-nodes-langchain.lmChatOpenAi',
				1.2,
				{ model: { __rl: true, mode: 'list', value: 'gpt-4o-mini' } },
				'n3',
			),
		],
		connections: {
			Chat: main('Agent'),
			Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
		},
	},
	'a missing required parameter': {
		name: 'Required',
		nodes: [
			node('Start', 'n8n-nodes-base.manualTrigger', 1, {}, 'n1'),
			node('Call API', 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET' }, 'n2'),
		],
		connections: { Start: main('Call API') },
	},
	'a parameter of the wrong type': {
		name: 'Types',
		nodes: [
			node('Start', 'n8n-nodes-base.manualTrigger', 1, {}, 'n1'),
			node('Shape', 'n8n-nodes-base.set', 3.4, { mode: 123 }, 'n2'),
		],
		connections: { Start: main('Shape') },
	},
	'two nodes with the same name': {
		name: 'Duplicate',
		nodes: [
			node('Start', 'n8n-nodes-base.manualTrigger', 1, {}, 'n1'),
			node('Same', 'n8n-nodes-base.noOp', 1, {}, 'n2'),
			node('Same', 'n8n-nodes-base.noOp', 1, {}, 'n3'),
		],
		connections: { Start: main('Same') },
	},
	'nodes without IDs': {
		name: 'No IDs',
		nodes: [
			node('Start', 'n8n-nodes-base.manualTrigger', 1),
			node('End', 'n8n-nodes-base.noOp', 1),
		],
		connections: { Start: main('End') },
	},
	'only a sticky note': {
		name: 'Sticky',
		nodes: [node('Note', 'n8n-nodes-base.stickyNote', 1, { content: '## Hello' }, 'n1')],
		connections: {},
	},
	'an AI connection into a main input': {
		name: 'Wrong input',
		nodes: [
			node('Start', 'n8n-nodes-base.manualTrigger', 1, {}, 'n1'),
			node('End', 'n8n-nodes-base.noOp', 1, {}, 'n2'),
		],
		connections: {
			Start: { ai_tool: [[{ node: 'End', type: 'ai_tool', index: 0 }]] },
		},
	},
	'nodes that are not a list': { name: 'Broken', nodes: undefined, connections: {} },
	'no connections': {
		name: 'No connections',
		nodes: [node('Start', 'n8n-nodes-base.manualTrigger', 1, {}, 'n1')],
		connections: undefined,
	},
};

const STRIP_SAMPLES: Record<string, string> = {
	'one import':
		"import { workflow } from '@n8n/workflow-sdk';\n\nexport default workflow('a', 'b');",
	'an import over lines':
		"import {\n\tworkflow,\n\tnode,\n} from '@n8n/workflow-sdk';\nexport default workflow('a', 'b');",
	'a type import': "import type { WorkflowJSON } from '@n8n/workflow-sdk';\nconst a = 1;",
	'a side-effect import': "import 'reflect-metadata';\nconst a = 1;",
	'double quotes without a semicolon': 'import { workflow } from "@n8n/workflow-sdk"\nconst a = 1;',
	'a default import': "import sdk from '@n8n/workflow-sdk';\nconst a = 1;",
	'a namespace import': "import * as sdk from '@n8n/workflow-sdk';\nconst a = 1;",
	'no import': "const a = 1;\nexport default workflow('a', 'b');",
	'an import after code':
		"const a = 1;\nimport { node } from '@n8n/workflow-sdk';\nexport default workflow('a', 'b');",
	'indented imports': "  import { workflow } from '@n8n/workflow-sdk';\n\t\nconst a = 1;",
	'leading blank lines':
		"\n\n\nimport { workflow } from '@n8n/workflow-sdk';\n\n\nconst a = 1;\n\n",
	'an import in a string': 'const text = "import x from \'y\'";\nconst a = 1;',
	'a commented import': "// import { a } from 'b';\nconst a = 1;",
	'Windows line ends': "import { workflow } from '@n8n/workflow-sdk';\r\nconst a = 1;\r\n",
	'a re-export': "export { a } from 'b';\nconst a = 1;",
	'a dynamic import': "const m = await import('x');\nconst a = 1;",
	'two imports on one line': "import a from 'a'; import b from 'b';\nconst c = 1;",
	'empty code': '',
	'only whitespace': '   \n\t\n  ',
};

const WARNINGS: Record<string, unknown> = {
	'a code and a message': { code: 'MISSING_TRIGGER', message: 'No trigger' },
	'with a node name': { code: 'MISSING_PARAMETER', message: 'Missing url', nodeName: 'Call API' },
	'with a parameter path': {
		code: 'INVALID_PARAMETER',
		message: 'Bad value',
		nodeName: 'Shape',
		parameterPath: 'mode',
	},
	'the same code and node, another message': {
		code: 'MISSING_PARAMETER',
		message: 'Another message',
		nodeName: 'Call API',
	},
	'with a severity': { code: 'X', message: 'Y', nodeName: 'Z', severity: 'informational' },
	'only a message': { message: 'Only a message' },
	'an empty object': {},
};

// #endregion

describe('the local parts of the AI workflow builder', () => {
	test('the constants', () => {
		const tools = Object.fromEntries(
			Object.entries(subject)
				.filter(([name]) => name.endsWith('_TOOL'))
				.sort(([a], [b]) => a.localeCompare(b)),
		);
		expect({ tools, sdkImportStatement: subject.SDK_IMPORT_STATEMENT }).toMatchSnapshot();
	});

	test('stripImportStatements', () => {
		expect(
			Object.fromEntries(
				Object.entries(STRIP_SAMPLES).map(([name, code]) => [name, stripImportStatements(code)]),
			),
		).toMatchSnapshot();
	});

	test('getWarningKey', async () => {
		const keys: Record<string, unknown> = {};
		for (const [name, warning] of Object.entries(WARNINGS)) {
			keys[name] = await outcome(() =>
				getWarningKey(warning as Parameters<typeof getWarningKey>[0]),
			);
		}
		expect(keys).toMatchSnapshot();
	});

	test('parseAndValidate', async () => {
		const results: Record<string, unknown> = {};
		for (const [name, code] of Object.entries(CODE_SAMPLES)) {
			results[name] = await parse(code);
		}
		expect(results).toMatchSnapshot();
	}, 60_000);

	test('validateJSON', async () => {
		const results: Record<string, unknown> = {};
		for (const [name, workflow] of Object.entries(JSON_SAMPLES)) {
			results[name] = await validateJson(workflow);
		}
		expect(results).toMatchSnapshot();
	}, 60_000);

	describe('with the node definitions of the n8n server', () => {
		// The node catalog of the n8n server sets these folders for the parameter schemas.
		const definitionDirs = PACKAGES.map((packageName) =>
			join(CLI_ROOT, 'node_modules', packageName, 'dist', 'node-definitions'),
		);
		let previousDirs: string[] = [];

		beforeAll(() => {
			previousDirs = getSchemaBaseDirs();
			setSchemaBaseDirs(definitionDirs);
		});

		afterAll(() => {
			setSchemaBaseDirs(previousDirs);
		});

		test('parseAndValidate', async () => {
			const results: Record<string, unknown> = {};
			for (const [name, code] of Object.entries(CODE_SAMPLES)) {
				results[name] = await parse(code);
			}
			expect({ schemaDirs: getSchemaBaseDirs().length, results }).toMatchSnapshot();
		}, 60_000);

		test('validateJSON', async () => {
			const results: Record<string, unknown> = {};
			for (const [name, workflow] of Object.entries(JSON_SAMPLES)) {
				results[name] = await validateJson(workflow);
			}
			expect(results).toMatchSnapshot();
		}, 60_000);
	});

	test('a handler without node types', async () => {
		const handler = new ParseValidateHandler({ generatePinData: false } as ConstructorParameters<
			typeof ParseValidateHandler
		>[0]);
		expect({
			parse: await outcome(
				async () =>
					await handler.parseAndValidate(stripImportStatements(CODE_SAMPLES['a linear chain'])),
			),
			validate: await outcome(() =>
				handler.validateJSON(
					JSON_SAMPLES['a valid chain'] as Parameters<typeof handler.validateJSON>[0],
				),
			),
		}).toMatchSnapshot();
	});

	test('isLangchainMessagesArray', () => {
		const samples: Record<string, unknown> = {
			'an empty list': [],
			'one human message': [new HumanMessage('hi')],
			'all message kinds': [
				new SystemMessage('rules'),
				new HumanMessage('hi'),
				new AIMessage('hello'),
				new ToolMessage({ content: 'done', tool_call_id: 't1' }),
			],
			'a plain object': [{ type: 'human', content: 'hi' }],
			'a string': ['hi'],
			'a message and a string': [new HumanMessage('hi'), 'hi'],
			null: null,
			'an object': {},
			'a message': new HumanMessage('hi'),
		};
		expect(
			Object.fromEntries(
				Object.entries(samples).map(([name, value]) => [
					name,
					subject.isLangchainMessagesArray(value),
				]),
			),
		).toMatchSnapshot();
	});

	test('createPassthroughSsrfGuard', async () => {
		const guard: Record<string, unknown> = subject.createPassthroughSsrfGuard();
		const members = Object.keys(guard).sort();
		const calls: Record<string, unknown> = {};
		const call = async (name: string, ...args: unknown[]) => {
			const member = guard[name];
			if (typeof member !== 'function') return { missing: true };
			return await outcome(async () => {
				const value: unknown = await member.apply(guard, args);
				return typeof value === 'function' ? 'a function' : value;
			});
		};
		calls['validateUrl of a private address'] = await call('validateUrl', 'http://127.0.0.1/');
		calls['validateUrl of a public address'] = await call('validateUrl', 'https://example.com/');
		calls['validateRedirectSync'] = await call(
			'validateRedirectSync',
			'http://10.0.0.1/',
			'https://example.com/',
		);
		calls['createSecureLookup'] = await call('createSecureLookup');
		expect({ members, calls }).toMatchSnapshot();
	});
});
