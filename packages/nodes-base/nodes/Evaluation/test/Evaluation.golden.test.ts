// Fork test (not in upstream n8n): a golden test of the Evaluation node and the Evaluation Trigger
// node. It records the descriptions and the results of the nodes for a matrix of parameters and
// versions, with mocked Google Sheets and Data table calls. The snapshot was recorded against the
// enterprise files. The fork files give the same snapshot, except two outcomes that differ on
// purpose (see `FORK.md` in this folder). The canned prompts of the metrics are not in the
// snapshot: it shows their names only.
import { mock } from 'vitest-mock-extended';
import {
	metricRequiresModelConnection,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
} from 'n8n-workflow';

import { GoogleSheet } from '../../Google/Sheet/v2/helpers/GoogleSheet';
import * as prompts from '../Evaluation/CannedMetricPrompts';
import { Evaluation } from '../Evaluation/Evaluation.node';
import { EvaluationTrigger } from '../EvaluationTrigger/EvaluationTrigger.node';
import { getInputConnectionTypes, getOutputConnectionTypes } from '../utils/evaluationUtils';

/** Ordinary functions whose source is part of the expressions of the descriptions. */
const KNOWN_CODE: Array<[string, string]> = [
	[String(getInputConnectionTypes), '<getInputConnectionTypes>'],
	[String(getOutputConnectionTypes), '<getOutputConnectionTypes>'],
	[String(metricRequiresModelConnection), '<metricRequiresModelConnection>'],
];

/** The texts of the canned prompts, shown by their names only. */
const PROMPTS: Array<[string, string]> = Object.entries(prompts).flatMap(([name, value]) => {
	if (typeof value === 'string') return [[value, `<${name}>`] as [string, string]];
	if (Array.isArray(value)) {
		return value.flatMap((item, index) =>
			typeof item === 'string' ? [[item, `<${name}[${index}]>`] as [string, string]] : [],
		);
	}
	return [];
});

function normalizeString(text: string): string {
	for (const [prompt, marker] of PROMPTS) if (text === prompt) return marker;
	let result = text;
	for (const [code, marker] of KNOWN_CODE) result = result.split(code).join(marker);
	if (/=>|\bfunction\b|\breturn\b/.test(result.replace(/<[A-Za-z]+>/g, ''))) {
		return '<expression with other code>';
	}
	return result;
}

/** Functions by their arity, prompts by their names, errors by class and message. */
function normalize(value: unknown): unknown {
	if (typeof value === 'function') return `<function/${value.length}>`;
	if (typeof value === 'string') return normalizeString(value);
	if (value instanceof Date) return `<Date ${value.toISOString()}>`;
	if (value instanceof Error) return `${value.constructor.name}: ${value.message}`;
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalize(inner)]));
	}
	return value;
}

type Parent = { type: string; name: string };

interface Scenario {
	version: number;
	params: Record<string, unknown>;
	input?: INodeExecutionData[];
	parents?: Parent[];
	/** The value of `$('<trigger>').isExecuted`. */
	triggerExecuted?: boolean;
	/** The value of `$('<trigger>').first().json`. */
	triggerRow?: IDataObject;
	dataTable?: {
		columns?: Array<{ name: string; type: string }>;
		pages?: Array<{ data: IDataObject[]; count: number }>;
	};
	withoutDataTableModule?: boolean;
}

const TRIGGER: Parent = {
	type: 'n8n-nodes-base.evaluationTrigger',
	name: 'When fetching a dataset row',
};

/**
 * A context of a node run. It records the calls that reach the Data table and the execution hints,
 * not the reads of the parameters: each scenario gives all parameters that a real run has.
 */
function makeContext(scenario: Scenario) {
	const calls: unknown[] = [];
	const pages = [...(scenario.dataTable?.pages ?? [])];
	const dataTable = {
		getColumns: vi.fn(async () => {
			calls.push(['dataTable.getColumns']);
			return (scenario.dataTable?.columns ?? []).map((column, index) => ({
				id: String(index),
				index,
				dataTableId: 'dt-1',
				...column,
			}));
		}),
		addColumn: vi.fn(async (column: unknown) => {
			calls.push(['dataTable.addColumn', column]);
			return column;
		}),
		updateRows: vi.fn(async (update: unknown) => {
			calls.push(['dataTable.updateRows', update]);
			return true;
		}),
		getManyRowsAndCount: vi.fn(async (query: unknown) => {
			calls.push(['dataTable.getManyRowsAndCount', query]);
			return pages.shift() ?? { data: [], count: 0 };
		}),
	};
	const context = mock<IExecuteFunctions>();
	context.getNode.mockReturnValue({
		id: 'node-1',
		name: 'Evaluation',
		type: 'n8n-nodes-base.evaluation',
		typeVersion: scenario.version,
		position: [0, 0],
		parameters: {},
	});
	context.getInputData.mockReturnValue(scenario.input ?? [{ json: {} }]);
	context.getParentNodes.mockImplementation(
		() =>
			(scenario.parents ?? []).map((parent) => ({
				...parent,
				depth: 1,
				indicies: [0],
			})) as unknown as ReturnType<IExecuteFunctions['getParentNodes']>,
	);
	context.getNodeParameter.mockImplementation(((
		name: string,
		_itemIndex: number,
		fallback?: unknown,
		options?: unknown,
	) => {
		if (name in scenario.params) {
			const value = scenario.params[name];
			if (
				options &&
				typeof options === 'object' &&
				'extractValue' in options &&
				value &&
				typeof value === 'object' &&
				'value' in value
			) {
				return value.value;
			}
			return value;
		}
		return fallback;
	}) as never);
	context.evaluateExpression.mockImplementation(((expression: string) => {
		if (expression.includes('isExecuted')) return scenario.triggerExecuted ?? false;
		return scenario.triggerRow ?? {};
	}) as never);
	context.addExecutionHints.mockImplementation((...hints: unknown[]) => {
		calls.push(['addExecutionHints', ...hints]);
	});
	context.continueOnFail.mockReturnValue(false);
	Object.assign(context, {
		helpers: {
			getDataTableProxy: scenario.withoutDataTableModule
				? undefined
				: vi.fn(async (id: string) => {
						calls.push(['helpers.getDataTableProxy', id]);
						return dataTable;
					}),
			returnJsonArray: (items: IDataObject[]) => items.map((json) => ({ json })),
			constructExecutionMetaData: (items: INodeExecutionData[]) => items,
		},
	});
	return { context, calls };
}

const SHEET = 'Sheet5';
const SPREADSHEET = '1oqFpPgEPTGDw7BPkp1SfPXq3Cb3Hyr1SROtf-Ec4zvA';

/** A sheet with a header row and the given data rows. */
function mockSheet(rows: string[][], calls: unknown[]) {
	const header = ['Question', 'Answer'];
	vi.spyOn(GoogleSheet.prototype, 'spreadsheetGetSheet').mockImplementation(async () => {
		calls.push(['sheet.spreadsheetGetSheet']);
		return { sheetId: 1, title: SHEET };
	});
	vi.spyOn(GoogleSheet.prototype, 'getData').mockImplementation(async (range: string) => {
		calls.push(['sheet.getData', range]);
		const all = [header, ...rows];
		const match = /^[^!]+!(\d+):(\d+)$/.exec(range);
		if (!match) return all;
		const [first, last] = [Number(match[1]), Number(match[2])];
		// A range always starts with the header row in the response of a read.
		const body = all.slice(first - 1, last);
		return first === 1 ? body : [header, ...body];
	});
	vi.spyOn(GoogleSheet.prototype, 'updateRows').mockImplementation(async (...args: unknown[]) => {
		calls.push(['sheet.updateRows', ...args]);
		return {};
	});
	vi.spyOn(GoogleSheet.prototype, 'batchUpdate').mockImplementation(async (...args: unknown[]) => {
		calls.push(['sheet.batchUpdate', ...args]);
		return {};
	});
}

async function run(
	node: Evaluation | EvaluationTrigger,
	scenario: Scenario,
	sheetRows?: string[][],
	method: 'execute' | 'getRows' = 'execute',
) {
	const { context, calls } = makeContext(scenario);
	if (sheetRows) mockSheet(sheetRows, calls);
	let outcome: unknown;
	try {
		outcome =
			method === 'execute'
				? await node.execute.call(context)
				: await (node as EvaluationTrigger).customOperations.dataset.getRows.call(context);
	} catch (error) {
		outcome = error;
	}
	vi.restoreAllMocks();
	return normalize({ outcome, calls });
}

describe('descriptions', () => {
	test('the Evaluation node', () => {
		const node = new Evaluation();
		expect(
			normalize({
				keys: Object.keys(node).sort(),
				description: node.description,
				methods: node.methods,
			}),
		).toMatchSnapshot();
	});

	test('the Evaluation Trigger node', () => {
		const node = new EvaluationTrigger();
		expect(
			normalize({
				keys: Object.keys(node).sort(),
				description: node.description,
				methods: node.methods,
				customOperations: node.customOperations,
			}),
		).toMatchSnapshot();
	});

	test('the exports of the canned prompts', () => {
		const shapes = Object.fromEntries(
			Object.entries(prompts).map(([name, value]) => [
				name,
				Array.isArray(value) ? `array of ${value.length}` : typeof value,
			]),
		);
		expect(shapes).toMatchSnapshot();
	});
});

const VERSIONS = [4.6, 4.7, 4.8];
const ROW = { row_id: 7, row_number: 3, Question: 'q', Answer: 'a', _rowsLeft: 2 };

describe('Evaluation node', () => {
	test('set inputs', async () => {
		const node = new Evaluation();
		const record: Record<string, unknown> = {};
		for (const version of VERSIONS) {
			record[`${version} from the trigger`] = await run(node, {
				version,
				params: { operation: 'setInputs', 'inputs.values': [{ inputName: 'q', inputValue: 'x' }] },
				parents: [TRIGGER],
				triggerExecuted: true,
				input: [{ json: { a: 1 } }, { json: { a: 2 } }],
			});
		}
		record['without a trigger'] = await run(node, {
			version: 4.7,
			params: { operation: 'setInputs', 'inputs.values': [{ inputName: 'q', inputValue: 'x' }] },
		});
		record['trigger not executed'] = await run(node, {
			version: 4.7,
			params: { operation: 'setInputs', 'inputs.values': [{ inputName: 'q', inputValue: 'x' }] },
			parents: [TRIGGER],
			triggerExecuted: false,
		});
		record['no inputs'] = await run(node, {
			version: 4.7,
			params: { operation: 'setInputs', 'inputs.values': [] },
			parents: [TRIGGER],
			triggerExecuted: true,
		});
		expect(record).toMatchSnapshot();
	});

	test('set outputs to a Data table', async () => {
		const node = new Evaluation();
		const record: Record<string, unknown> = {};
		const params = {
			operation: 'setOutputs',
			source: 'dataTable',
			dataTableId: { mode: 'id', value: 'dt-1' },
			'outputs.values': [
				{ outputName: 'Answer', outputValue: 'clam' },
				{ outputName: 'score', outputValue: 3 },
			],
		};
		for (const version of VERSIONS) {
			record[`${version}`] = await run(node, {
				version,
				params,
				parents: [TRIGGER],
				triggerExecuted: true,
				triggerRow: ROW,
				dataTable: { columns: [{ name: 'Answer', type: 'string' }] },
			});
		}
		record['without the Data table module'] = await run(node, {
			version: 4.8,
			params,
			parents: [TRIGGER],
			triggerExecuted: true,
			triggerRow: ROW,
			withoutDataTableModule: true,
		});
		record['without a trigger'] = await run(node, { version: 4.8, params });
		record['no outputs'] = await run(node, {
			version: 4.8,
			params: { ...params, 'outputs.values': [] },
			parents: [TRIGGER],
			triggerExecuted: true,
			triggerRow: ROW,
		});
		record['unknown source'] = await run(node, {
			version: 4.8,
			params: { ...params, source: 'csv' },
			parents: [TRIGGER],
			triggerExecuted: true,
			triggerRow: ROW,
		});
		expect(record).toMatchSnapshot();
	});

	test('set outputs to a Google Sheet', async () => {
		const node = new Evaluation();
		const record: Record<string, unknown> = {};
		const params = {
			operation: 'setOutputs',
			source: 'googleSheets',
			documentId: { mode: 'id', value: SPREADSHEET },
			sheetName: { mode: 'name', value: SHEET },
			'outputs.values': [
				{ outputName: 'Answer', outputValue: 'clam' },
				{ outputName: 'score', outputValue: '3' },
			],
		};
		for (const version of VERSIONS) {
			record[`${version}`] = await run(
				node,
				{ version, params, parents: [TRIGGER], triggerExecuted: true, triggerRow: ROW },
				[],
			);
		}
		expect(record).toMatchSnapshot();
	});

	test('set metrics', async () => {
		const node = new Evaluation();
		const record: Record<string, unknown> = {};
		const custom = {
			operation: 'setMetrics',
			metric: 'customMetrics',
			metrics: {
				assignments: [
					{ id: '1', name: 'Accuracy', value: '0.5', type: 'number' },
					{ id: '2', name: 'Latency', value: 100, type: 'number' },
				],
			},
		};
		for (const version of VERSIONS) {
			record[`custom ${version}`] = await run(node, {
				version,
				params: custom,
				input: [{ json: { a: 1 } }, { json: { a: 2 } }],
			});
		}
		record['string similarity'] = await run(node, {
			version: 4.7,
			params: {
				operation: 'setMetrics',
				metric: 'stringSimilarity',
				expectedAnswer: 'kitten',
				actualAnswer: 'sitting',
				options: {},
			},
		});
		record['categorization'] = await run(node, {
			version: 4.7,
			params: {
				operation: 'setMetrics',
				metric: 'categorization',
				expectedAnswer: 'A',
				actualAnswer: 'A',
				options: {},
			},
		});
		record['tools used'] = await run(node, {
			version: 4.7,
			params: {
				operation: 'setMetrics',
				metric: 'toolsUsed',
				expectedTools: 'search, calculator',
				intermediateSteps: [{ action: { tool: 'search' } }],
				options: {},
			},
		});
		record['unknown metric'] = await run(node, {
			version: 4.7,
			params: { operation: 'setMetrics', metric: 'weather' },
		});
		record['correctness without a model'] = await run(node, {
			version: 4.7,
			params: {
				operation: 'setMetrics',
				metric: 'correctness',
				expectedAnswer: 'a',
				actualAnswer: 'b',
			},
		});
		expect(record).toMatchSnapshot();
	});

	test('check if evaluating, and an unknown operation', async () => {
		const node = new Evaluation();
		const record: Record<string, unknown> = {};
		for (const version of VERSIONS) {
			record[`${version} evaluating`] = await run(node, {
				version,
				params: { operation: 'checkIfEvaluating' },
				parents: [TRIGGER],
				triggerExecuted: true,
				input: [{ json: { a: 1 } }],
			});
			record[`${version} normal`] = await run(node, {
				version,
				params: { operation: 'checkIfEvaluating' },
				input: [{ json: { a: 1 } }],
			});
		}
		record['unknown operation'] = await run(node, { version: 4.7, params: { operation: 'other' } });
		expect(record).toMatchSnapshot();
	});
});

const SHEET_ROWS = [
	['q1', 'a1'],
	['q2', 'a2'],
	['q3', 'a3'],
];

const sheetParams = {
	source: 'googleSheets',
	documentId: { mode: 'id', value: SPREADSHEET },
	sheetName: { mode: 'name', value: SHEET },
	options: {},
	'filtersUI.values': [],
	limitRows: false,
};

describe('Evaluation Trigger node', () => {
	test('reads a Google Sheet row by row', async () => {
		const node = new EvaluationTrigger();
		const record: Record<string, unknown> = {};
		for (const version of [4.6, 4.7]) {
			record[`${version} first run`] = await run(
				node,
				{ version, params: sheetParams },
				SHEET_ROWS,
			);
		}
		record['after the first row'] = await run(
			node,
			{ version: 4.6, params: sheetParams, input: [{ json: { row_number: 2, _rowsLeft: 2 } }] },
			SHEET_ROWS,
		);
		record['after the last row'] = await run(
			node,
			{ version: 4.6, params: sheetParams, input: [{ json: { row_number: 4, _rowsLeft: 0 } }] },
			SHEET_ROWS,
		);
		record['with a limit of 2'] = await run(
			node,
			{ version: 4.6, params: { ...sheetParams, limitRows: true, maxRows: 2 } },
			SHEET_ROWS,
		);
		record['with a limit, after the limit'] = await run(
			node,
			{
				version: 4.6,
				params: { ...sheetParams, limitRows: true, maxRows: 2 },
				input: [{ json: { row_number: 3, _rowsLeft: 0 } }],
			},
			SHEET_ROWS,
		);
		record['with a filter'] = await run(
			node,
			{
				version: 4.6,
				params: {
					...sheetParams,
					'filtersUI.values': [{ lookupColumn: 'Answer', lookupValue: 'a2' }],
				},
			},
			SHEET_ROWS,
		);
		record['with a filter, after the match'] = await run(
			node,
			{
				version: 4.6,
				params: {
					...sheetParams,
					'filtersUI.values': [{ lookupColumn: 'Answer', lookupValue: 'a2' }],
				},
				input: [{ json: { row_number: 3, _rowsLeft: 0 } }],
			},
			SHEET_ROWS,
		);
		record['with a filter and a limit of 1'] = await run(
			node,
			{
				version: 4.6,
				params: {
					...sheetParams,
					limitRows: true,
					maxRows: 1,
					'filtersUI.values': [{ lookupColumn: 'Question', lookupValue: 'q3' }],
				},
			},
			SHEET_ROWS,
		);
		record['after the second row of three'] = await run(
			node,
			{ version: 4.6, params: sheetParams, input: [{ json: { row_number: 3, _rowsLeft: 1 } }] },
			SHEET_ROWS,
		);
		record['a previous row without rows left'] = await run(
			node,
			{ version: 4.6, params: sheetParams, input: [{ json: { row_number: 2 } }] },
			SHEET_ROWS,
		);
		record['with a filter that matches no row'] = await run(
			node,
			{
				version: 4.6,
				params: {
					...sheetParams,
					'filtersUI.values': [{ lookupColumn: 'Answer', lookupValue: 'none' }],
				},
			},
			SHEET_ROWS,
		);
		record['an empty sheet'] = await run(node, { version: 4.6, params: sheetParams }, []);
		expect(record).toMatchSnapshot();
	});

	test('reads a filtered Google Sheet with a limit', async () => {
		const node = new EvaluationTrigger();
		const rows = [
			['q1', 'a2'],
			['q2', 'x'],
			['q3', 'a2'],
			['q4', 'a2'],
			['q5', 'a2'],
		];
		const filtered = {
			...sheetParams,
			'filtersUI.values': [{ lookupColumn: 'Answer', lookupValue: 'a2' }],
		};
		const limited = (maxRows: number) => ({ ...filtered, limitRows: true, maxRows });
		const record: Record<string, unknown> = {};
		record['limit 2, first run'] = await run(node, { version: 4.6, params: limited(2) }, rows);
		record['limit 2, after row 2'] = await run(
			node,
			{ version: 4.6, params: limited(2), input: [{ json: { row_number: 2, _rowsLeft: 1 } }] },
			rows,
		);
		record['limit 2, after row 4'] = await run(
			node,
			{ version: 4.6, params: limited(2), input: [{ json: { row_number: 4, _rowsLeft: 1 } }] },
			rows,
		);
		record['limit 3, after row 4'] = await run(
			node,
			{ version: 4.6, params: limited(3), input: [{ json: { row_number: 4, _rowsLeft: 1 } }] },
			rows,
		);
		record['no limit, after row 2'] = await run(
			node,
			{ version: 4.6, params: filtered, input: [{ json: { row_number: 2, _rowsLeft: 3 } }] },
			rows,
		);
		record['no limit, after row 5'] = await run(
			node,
			{ version: 4.6, params: filtered, input: [{ json: { row_number: 6, _rowsLeft: 0 } }] },
			rows,
		);
		const longSheet = Array.from({ length: 1002 }, (_, index) => [`q${index + 1}`, 'a2']);
		record['a long sheet, after row 1000'] = await run(
			node,
			{ version: 4.6, params: sheetParams, input: [{ json: { row_number: 1000, _rowsLeft: 3 } }] },
			longSheet,
		);
		record['a long filtered sheet, after row 1000'] = await run(
			node,
			{ version: 4.6, params: filtered, input: [{ json: { row_number: 1000, _rowsLeft: 3 } }] },
			longSheet,
		);
		record['a long filtered sheet, rows for the test runner'] = (
			(await run(node, { version: 4.6, params: filtered }, longSheet, 'getRows')) as {
				outcome: unknown[][];
			}
		).outcome[0].length;
		record['a long sheet, rows for the test runner'] = (
			(await run(node, { version: 4.6, params: sheetParams }, longSheet, 'getRows')) as {
				outcome: unknown[][];
			}
		).outcome[0].length;
		const lateMatches = Array.from({ length: 1002 }, (_, index) => [
			`q${index + 1}`,
			index < 997 ? 'x' : 'a2',
		]);
		record['late matches in a long sheet, rows for the test runner'] = await run(
			node,
			{ version: 4.6, params: filtered },
			lateMatches,
			'getRows',
		);
		record['late matches in a long sheet, rows for the test runner, limit 2'] = await run(
			node,
			{ version: 4.6, params: limited(2) },
			lateMatches,
			'getRows',
		);
		record['rows for the test runner, limit 2'] = await run(
			node,
			{ version: 4.6, params: limited(2) },
			rows,
			'getRows',
		);
		record['rows for the test runner, no limit'] = await run(
			node,
			{ version: 4.6, params: filtered },
			rows,
			'getRows',
		);
		expect(record).toMatchSnapshot();
	});

	test('reads a Data table row by row', async () => {
		const node = new EvaluationTrigger();
		const record: Record<string, unknown> = {};
		const params = {
			source: 'dataTable',
			dataTableId: { mode: 'id', value: 'dt-1' },
			limitRows: false,
			filterRows: false,
			'filters.conditions': [],
			matchType: 'anyCondition',
		};
		const columns = [
			{ name: 'Question', type: 'string' },
			{ name: 'processed', type: 'number' },
		];
		record['first run'] = await run(node, {
			version: 4.7,
			params,
			dataTable: {
				columns,
				pages: [{ data: [{ id: 1, Question: 'q1', processed: 1 }], count: 3 }],
			},
		});
		record['after row 1'] = await run(node, {
			version: 4.7,
			params,
			input: [{ json: { row_id: 1, row_number: 0, _rowsLeft: 2 } }],
			dataTable: {
				columns,
				pages: [{ data: [{ id: 2, Question: 'q2', processed: 1 }], count: 2 }],
			},
		});
		record['with all conditions'] = await run(node, {
			version: 4.7,
			params: {
				...params,
				filterRows: true,
				matchType: 'allConditions',
				'filters.conditions': [
					{ keyName: 'processed', condition: 'eq', keyValue: '1' },
					{ keyName: 'Question', condition: 'isNotEmpty' },
				],
			},
			input: [{ json: { row_id: 1, row_number: 0, _rowsLeft: 2 } }],
			dataTable: {
				columns,
				pages: [{ data: [{ id: 2, Question: 'q2', processed: 1 }], count: 2 }],
			},
		});
		record['with a limit'] = await run(node, {
			version: 4.7,
			params: { ...params, limitRows: true, maxRows: 2 },
			input: [{ json: { row_id: 1, row_number: 0, _rowsLeft: 1 } }],
			dataTable: {
				columns,
				pages: [{ data: [{ id: 2, Question: 'q2', processed: 1 }], count: 2 }],
			},
		});
		record['after the last row'] = await run(node, {
			version: 4.7,
			params,
			input: [{ json: { row_id: 3, row_number: 2, _rowsLeft: 0 } }],
			dataTable: {
				columns,
				pages: [{ data: [{ id: 1, Question: 'q1', processed: 1 }], count: 3 }],
			},
		});
		record['with a limit, after the limit'] = await run(node, {
			version: 4.7,
			params: { ...params, limitRows: true, maxRows: 2 },
			input: [{ json: { row_id: 2, row_number: 1, _rowsLeft: 0 } }],
			dataTable: {
				columns,
				pages: [{ data: [{ id: 1, Question: 'q1', processed: 1 }], count: 3 }],
			},
		});
		record['with two conditions of which any must match, after row 1'] = await run(node, {
			version: 4.7,
			params: {
				...params,
				filterRows: true,
				matchType: 'anyCondition',
				'filters.conditions': [
					{ keyName: 'processed', condition: 'eq', keyValue: '1' },
					{ keyName: 'Question', condition: 'eq', keyValue: 'q2' },
				],
			},
			input: [{ json: { row_id: 1, row_number: 0, _rowsLeft: 2 } }],
			dataTable: {
				columns,
				pages: [{ data: [{ id: 2, Question: 'q2', processed: 1 }], count: 2 }],
			},
		});
		record['a row with a date, and a previous row without rows left'] = await run(node, {
			version: 4.7,
			params,
			input: [{ json: { row_id: 1, row_number: 0 } }],
			dataTable: {
				columns,
				pages: [
					{
						data: [{ id: 2, Question: 'q2', createdAt: new Date('2026-01-02T03:04:05.000Z') }],
						count: 2,
					},
				],
			},
		});
		record['an empty table'] = await run(node, {
			version: 4.7,
			params,
			dataTable: { columns, pages: [{ data: [], count: 0 }] },
		});
		record['without the Data table module'] = await run(node, {
			version: 4.7,
			params,
			withoutDataTableModule: true,
		});
		expect(record).toMatchSnapshot();
	});

	test('gives the rows of a dataset to the test runner', async () => {
		const node = new EvaluationTrigger();
		const record: Record<string, unknown> = {};
		const tableParams = {
			source: 'dataTable',
			dataTableId: { mode: 'id', value: 'dt-1' },
			limitRows: false,
			filterRows: false,
			'filters.conditions': [],
			matchType: 'anyCondition',
		};
		const columns = [{ name: 'Question', type: 'string' }];
		const rows = [
			{ id: 1, Question: 'q1' },
			{ id: 2, Question: 'q2' },
			{ id: 3, Question: 'q3' },
		];
		record['Data table'] = await run(
			node,
			{
				version: 4.7,
				params: tableParams,
				dataTable: { columns, pages: [{ data: rows, count: 3 }] },
			},
			undefined,
			'getRows',
		);
		record['Data table with a limit'] = await run(
			node,
			{
				version: 4.7,
				params: { ...tableParams, limitRows: true, maxRows: 2 },
				dataTable: { columns, pages: [{ data: rows.slice(0, 2), count: 3 }] },
			},
			undefined,
			'getRows',
		);
		record['Data table with a filter'] = await run(
			node,
			{
				version: 4.7,
				params: {
					...tableParams,
					filterRows: true,
					'filters.conditions': [{ keyName: 'Question', condition: 'eq', keyValue: 'q2' }],
				},
				dataTable: { columns, pages: [{ data: [rows[1]], count: 1 }] },
			},
			undefined,
			'getRows',
		);
		record['Data table with more than one page'] = await run(
			node,
			{
				version: 4.7,
				params: tableParams,
				dataTable: {
					columns,
					pages: [
						{ data: rows, count: 1500 },
						{ data: rows, count: 1500 },
					],
				},
			},
			undefined,
			'getRows',
		);
		record['Data table with a date'] = await run(
			node,
			{
				version: 4.7,
				params: tableParams,
				dataTable: {
					columns,
					pages: [
						{
							data: [{ id: 1, Question: 'q1', updatedAt: new Date('2026-01-02T03:04:05.000Z') }],
							count: 1,
						},
					],
				},
			},
			undefined,
			'getRows',
		);
		record['Data table with an empty table'] = await run(
			node,
			{
				version: 4.7,
				params: tableParams,
				dataTable: { columns, pages: [{ data: [], count: 0 }] },
			},
			undefined,
			'getRows',
		);
		record['Google Sheet'] = await run(
			node,
			{ version: 4.6, params: sheetParams },
			SHEET_ROWS,
			'getRows',
		);
		record['Google Sheet with a limit'] = await run(
			node,
			{ version: 4.6, params: { ...sheetParams, limitRows: true, maxRows: 2 } },
			SHEET_ROWS,
			'getRows',
		);
		record['Google Sheet with a filter'] = await run(
			node,
			{
				version: 4.6,
				params: {
					...sheetParams,
					'filtersUI.values': [{ lookupColumn: 'Answer', lookupValue: 'a3' }],
				},
			},
			SHEET_ROWS,
			'getRows',
		);
		record['Google Sheet with a filter and a limit of 1'] = await run(
			node,
			{
				version: 4.6,
				params: {
					...sheetParams,
					limitRows: true,
					maxRows: 1,
					'filtersUI.values': [{ lookupColumn: 'Answer', lookupValue: 'a3' }],
				},
			},
			SHEET_ROWS,
			'getRows',
		);
		record['an empty Google Sheet'] = await run(
			node,
			{ version: 4.6, params: sheetParams },
			[],
			'getRows',
		);
		expect(record).toMatchSnapshot();
	});
});
