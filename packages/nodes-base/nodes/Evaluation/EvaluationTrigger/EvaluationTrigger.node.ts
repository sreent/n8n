import type {
	DataTableRowReturn,
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { getSelectFields, getSelectFilter } from '../../DataTable/common/selectMany';
import { readFilter } from '../../Google/Sheet/v2/actions/sheet/read.operation';
import { document, sheet } from '../../Google/Sheet/GoogleSheetsTrigger.node';
import { authentication } from '../common/descriptions';
import { setOutputProperties, sourcePicker } from '../Evaluation/Description.node';
import { credentialTest, listSearch, loadOptions } from '../methods';
import {
	getGoogleSheet,
	getNumberOfRowsLeftFiltered,
	getResults,
	getRowsLeft,
	getSheet,
} from '../utils/evaluationTriggerUtils';

/** The last row that a Google Sheet run reads without a limit. */
const MAX_SHEET_ROW = 1000;
/** The rows that the test runner reads from a Data table without a limit. */
const MAX_TABLE_ROWS = 1000;
/** The first data row of a sheet: row 1 is the header. */
const FIRST_DATA_ROW = 2;

const onlyForSheets = { hide: { source: ['dataTable'] } };

/** The Data table field of the Evaluation node, with the same modes. */
const dataTableId = setOutputProperties.find((property) => property.name === 'dataTableId');

/** The row of the previous run of the trigger: its position, and the rows that were left after it. */
function previousRow(this: IExecuteFunctions) {
	const json: IDataObject = this.getInputData()[0]?.json ?? {};
	return {
		rowNumber: typeof json.row_number === 'number' ? json.row_number : undefined,
		rowId: typeof json.row_id === 'number' ? json.row_id : undefined,
		rowsLeft: json._rowsLeft,
	};
}

async function getDataTableProxy(this: IExecuteFunctions) {
	if (this.helpers.getDataTableProxy === undefined) {
		throw new NodeOperationError(
			this.getNode(),
			'Attempted to use Data table node but the module is disabled',
		);
	}
	const id = this.getNodeParameter('dataTableId', 0, undefined, { extractValue: true });
	return await this.helpers.getDataTableProxy(String(id));
}

/** Whether the node has filters for the rows of a Google Sheet. */
function hasSheetFilters(this: IExecuteFunctions): boolean {
	const filters = this.getNodeParameter('filtersUI.values', 0, []);
	return Array.isArray(filters) && filters.length > 0;
}

function toTableItem(row: DataTableRowReturn, rowNumber: number): IDataObject {
	return { ...row, row_id: row.id, row_number: rowNumber };
}

/**
 * Fork code (not in upstream n8n): the Evaluation Trigger node. Each run gives the next row of the
 * dataset, from a Data table or a Google Sheet, and `_rowsLeft`: the rows that come after it. The
 * test runner reads all rows at once with `customOperations.dataset.getRows`. It replaces the
 * enterprise node of the same name. See `../FORK.md`.
 */
export class EvaluationTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Evaluation Trigger',
		icon: 'fa:check-double',
		name: 'evaluationTrigger',
		group: ['trigger'],
		version: [4.6, 4.7],
		description: 'Run a test dataset through your workflow to check performance',
		eventTriggerDescription: '',
		defaults: {
			name: 'When fetching a dataset row',
			color: '#c3c9d5',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		codex: {
			alias: ['Test', 'Metrics', 'Evals', 'Set Output', 'Set Metrics'],
		},
		credentials: [
			{
				name: 'googleApi',
				required: true,
				displayOptions: { show: { authentication: ['serviceAccount'] } },
				testedBy: 'googleApiCredentialTest',
			},
			{
				name: 'googleSheetsOAuth2Api',
				required: true,
				displayOptions: { show: { authentication: ['oAuth2'] } },
			},
		],
		properties: [
			// Version 4.7 reads the dataset from a Data table by default, version 4.6 from a sheet.
			{
				...sourcePicker,
				default: 'dataTable',
				displayOptions: { show: { '@version': [{ _cnd: { gte: 4.7 } }] } },
			},
			{
				...sourcePicker,
				default: 'googleSheets',
				displayOptions: { show: { '@version': [{ _cnd: { lte: 4.6 } }] } },
			},
			{
				displayName:
					'Pulls a test dataset from a Google Sheet. The workflow will run once for each row, in sequence. Tips for wiring this node up <a href="https://docs.n8n.io/advanced-ai/evaluations/tips-and-common-issues/#combining-multiple-triggers">here</a>.',
				name: 'notice',
				type: 'notice',
				default: '',
				displayOptions: onlyForSheets,
			},
			{
				displayName: 'Credentials',
				name: 'credentials',
				type: 'credentials',
				default: '',
				displayOptions: onlyForSheets,
			},
			authentication,
			{
				...document,
				displayName: 'Document Containing Dataset',
				hint: 'Example dataset format <a href="https://docs.google.com/spreadsheets/d/1vD_IdeFUg7sHsK9okL6Doy1rGOkWTnPJV3Dro4FBUsY/edit?gid=0#gid=0">here</a>',
				displayOptions: onlyForSheets,
			},
			{
				...sheet,
				displayName: 'Sheet Containing Dataset',
				displayOptions: onlyForSheets,
			},
			...(dataTableId ? [dataTableId] : []),
			{
				displayName: 'Limit Rows',
				name: 'limitRows',
				type: 'boolean',
				default: false,
				noDataExpression: true,
				description: 'Whether to limit number of rows to process',
			},
			{
				displayName: 'Max Rows to Process',
				name: 'maxRows',
				type: 'number',
				default: 10,
				description: 'Maximum number of rows to process',
				noDataExpression: false,
				displayOptions: { show: { limitRows: [true] } },
			},
			{ ...readFilter, displayOptions: onlyForSheets },
			{
				displayName: 'Filter Rows',
				name: 'filterRows',
				type: 'boolean',
				default: false,
				noDataExpression: true,
				description: 'Whether to filter rows to process',
				displayOptions: { show: { source: ['dataTable'] } },
			},
			...getSelectFields({ show: { filterRows: [true] } }),
		],
	};

	methods = { loadOptions, listSearch, credentialTest };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const source = this.getNodeParameter('source', 0);
		if (source === 'dataTable') return await nextTableRow.call(this);
		return await nextSheetRow.call(this);
	}

	customOperations = {
		dataset: {
			/** All rows of the dataset, for the test runner. */
			async getRows(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
				const source = this.getNodeParameter('source', 0);
				if (source === 'dataTable') return await allTableRows.call(this);
				return await allSheetRows.call(this);
			},
		},
	};
}

/** The limit of the rows, or `undefined` without a limit. */
function rowLimit(this: IExecuteFunctions): number | undefined {
	if (!this.getNodeParameter('limitRows', 0, false)) return undefined;
	return Number(this.getNodeParameter('maxRows', 0, MAX_TABLE_ROWS));
}

/**
 * The next row of a Data table. A run after the last row, or with no row before it, starts again
 * at the first row. A run after a row reads the first row with a higher ID.
 */
async function nextTableRow(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const proxy = await getDataTableProxy.call(this);
	const filter = await getSelectFilter(this, 0);
	const limit = rowLimit.call(this);
	const previous = previousRow.call(this);
	// The row of the previous run, when this run continues after it.
	const after =
		previous.rowId !== undefined && previous.rowNumber !== undefined && previous.rowsLeft !== 0
			? { rowId: previous.rowId, rowNumber: previous.rowNumber }
			: undefined;

	const { data, count } = await proxy.getManyRowsAndCount({
		skip: 0,
		take: 1,
		filter: after
			? {
					type: 'and',
					filters: [...filter.filters, { columnName: 'id', condition: 'gt', value: after.rowId }],
				}
			: filter,
	});
	const [row] = data;
	if (!row) throw new NodeOperationError(this.getNode(), 'No row found');

	const rowNumber = after ? after.rowNumber + 1 : 0;
	const rowsLeft = limit === undefined ? count - 1 : Math.min(count - 1, limit - 1 - rowNumber);

	return [[{ json: { ...toTableItem(row, rowNumber), _rowsLeft: rowsLeft } }]];
}

/**
 * The next row of a Google Sheet. A run after the last row, or with no row before it, starts again
 * at the first data row. With a filter, the next row is the next match.
 */
async function nextSheetRow(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const googleSheet = getGoogleSheet.call(this);
	const sheetInfo = await getSheet.call(this, googleSheet);
	const limit = rowLimit.call(this);
	const lastRow = limit === undefined ? MAX_SHEET_ROW : limit + 1;
	const previous = previousRow.call(this);
	const startingRow =
		previous.rowNumber !== undefined && previous.rowsLeft !== 0
			? previous.rowNumber + 1
			: FIRST_DATA_ROW;

	// `readSheet` applies the filters of the node, so the rows are the matches from the start row.
	const rows = await getResults.call(this, [], googleSheet, sheetInfo, {
		rangeDefinition: 'specifyRange',
		headerRow: 1,
		firstDataRow: startingRow,
	});

	if (hasSheetFilters.call(this)) {
		const [match] = rows;
		if (!match) throw new NodeOperationError(this.getNode(), 'No row found');
		const rowsLeft = await getNumberOfRowsLeftFiltered.call(
			this,
			googleSheet,
			sheetInfo.title,
			Number(match.json.row_number) + 1,
			lastRow,
		);
		return [[{ ...match, json: { ...match.json, _rowsLeft: rowsLeft } }]];
	}

	// The read takes the first row of the range as the header, so it counts the rows after this one.
	const rowsLeft = await getRowsLeft.call(
		this,
		googleSheet,
		sheetInfo.title,
		`${sheetInfo.title}!${startingRow}:${lastRow}`,
	);
	const [row] = rows;
	if (!row) throw new NodeOperationError(this.getNode(), 'No row found');
	return [[{ ...row, json: { ...row.json, _rowsLeft: rowsLeft } }]];
}

/** The rows of a Data table that match the filter, up to the limit. */
async function allTableRows(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const proxy = await getDataTableProxy.call(this);
	const filter = await getSelectFilter(this, 0);
	const limit = rowLimit.call(this);
	const { data } = await proxy.getManyRowsAndCount({
		skip: 0,
		take: limit ?? MAX_TABLE_ROWS,
		filter,
	});
	return [data.map((row, index) => ({ json: toTableItem(row, index), pairedItem: { item: 0 } }))];
}

/**
 * The rows of a Google Sheet. With a filter, the first matches up to the limit, or the first 999
 * matches without a limit. Without a filter, the rows up to the limit or up to row 1000.
 */
async function allSheetRows(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const googleSheet = getGoogleSheet.call(this);
	const sheetInfo = await getSheet.call(this, googleSheet);
	const limit = rowLimit.call(this);
	const rows = await getResults.call(this, [], googleSheet, sheetInfo, {
		rangeDefinition: 'specifyRange',
		headerRow: 1,
		firstDataRow: FIRST_DATA_ROW,
	});

	if (hasSheetFilters.call(this)) {
		// Without a limit, the runner gets at most as many matches as rows 2 to 1000 can hold.
		return [rows.slice(0, limit ?? MAX_SHEET_ROW - FIRST_DATA_ROW + 1)];
	}
	const lastRow = limit === undefined ? MAX_SHEET_ROW : limit + 1;
	return [rows.filter((row) => Number(row.json.row_number) <= lastRow)];
}
