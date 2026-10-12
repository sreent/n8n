import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { metricRequiresModelConnection, NodeOperationError } from 'n8n-workflow';

import {
	setCheckIfEvaluatingProperties,
	setInputsProperties,
	setMetricsProperties,
	setOutputProperties,
	sourcePicker,
} from './Description.node';
import { authentication } from '../common/descriptions';
import { credentialTest, listSearch, loadOptions } from '../methods';
import {
	checkIfEvaluating,
	getInputConnectionTypes,
	getOutputConnectionTypes,
	setInputs,
	setMetrics,
	setOutputs,
} from '../utils/evaluationUtils';

const operation: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	options: [
		{ name: 'Set Inputs', value: 'setInputs' },
		{ name: 'Set Outputs', value: 'setOutputs' },
		{ name: 'Set Metrics', value: 'setMetrics' },
		{ name: 'Check If Evaluating', value: 'checkIfEvaluating' },
	],
	default: 'setOutputs',
};

/**
 * Fork code (not in upstream n8n): the Evaluation node. It writes the outputs of a test case to the
 * dataset, adds inputs and metrics to the result of a test run, and routes an execution by whether
 * an evaluation started it. It replaces the enterprise node of the same name. See `../FORK.md`.
 */
export class Evaluation implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Evaluation',
		icon: 'fa:check-double',
		name: 'evaluation',
		group: ['transform'],
		version: [4.6, 4.7, 4.8],
		description: 'Runs an evaluation',
		eventTriggerDescription: '',
		subtitle: '={{$parameter["operation"]}}',
		defaults: {
			name: 'Evaluation',
			color: '#c3c9d5',
		},
		inputs: `={{(${getInputConnectionTypes})($parameter, ${metricRequiresModelConnection})}}`,
		outputs: `={{(${getOutputConnectionTypes})($parameter)}}`,
		credentials: [
			{
				name: 'googleApi',
				required: true,
				displayOptions: {
					show: { authentication: ['serviceAccount'], operation: ['setOutputs'] },
				},
				testedBy: 'googleApiCredentialTest',
			},
			{
				name: 'googleSheetsOAuth2Api',
				required: true,
				displayOptions: {
					show: { authentication: ['oAuth2'], operation: ['setOutputs'] },
				},
			},
		],
		properties: [
			operation,
			// Version 4.8 reads the dataset from a Data table by default, older versions from a sheet.
			{
				...sourcePicker,
				default: 'dataTable',
				displayOptions: {
					show: { '@version': [{ _cnd: { gte: 4.8 } }], operation: ['setOutputs'] },
				},
			},
			{
				...sourcePicker,
				default: 'googleSheets',
				displayOptions: {
					show: { '@version': [{ _cnd: { lte: 4.7 } }], operation: ['setOutputs'] },
				},
			},
			authentication,
			...setInputsProperties,
			...setOutputProperties,
			...setMetricsProperties,
			...setCheckIfEvaluatingProperties,
		],
	};

	methods = { loadOptions, listSearch, credentialTest };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const selected = this.getNodeParameter('operation', 0);

		if (selected === 'setOutputs') return await setOutputs.call(this);
		if (selected === 'setInputs') return setInputs.call(this);
		if (selected === 'setMetrics') return await setMetrics.call(this);
		if (selected === 'checkIfEvaluating') return await checkIfEvaluating.call(this);

		throw new NodeOperationError(this.getNode(), 'Unsupported Operation');
	}
}
