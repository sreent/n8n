import { isRecord } from '@n8n/utils/is-record';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	googleCloudOcrRequest,
	processorLocation,
	recordsOf,
	textOf,
	toDataObject,
} from './GenericFunctions';

/** The file types that the Vision API reads page by page. */
const FILE_MIME_TYPES = new Set(['application/pdf', 'image/tiff', 'image/gif']);

/** The Vision API reads up to 5 pages of a file in one request. */
const PAGES_PER_REQUEST = 5;

const DEFAULT_MAX_PAGES = 20;

interface ReadTextOptions {
	languageHints: string[];
	maxPages: number;
	includeFullResponse: boolean;
}

/** The text of one answer of the Vision API for an image or a page of a file. */
function annotationText(answer: Record<string, unknown>) {
	const fullText = isRecord(answer.fullTextAnnotation)
		? textOf(answer.fullTextAnnotation.text)
		: '';
	if (fullText) return fullText;
	const [first] = recordsOf(answer.textAnnotations);
	return first ? textOf(first.description) : '';
}

/** The error message of an answer of the Vision API, or `undefined`. */
function errorOf(answer: Record<string, unknown>) {
	if (!isRecord(answer.error)) return undefined;
	return textOf(answer.error.message) || 'The Vision API could not read the input';
}

function pageRange(first: number, last: number) {
	return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/**
 * Fork node (not in upstream n8n): the OCR of Google Cloud with the Cloud Vision API and Document
 * AI. With an API key credential, the AI gateway of the fork can serve it with Gateway credits.
 * See `README.md`.
 */
export class GoogleCloudOcr implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Google Cloud OCR',
		name: 'googleCloudOcr',
		icon: 'file:googleCloudOcr.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Read the text of images and documents with the Cloud Vision API or Document AI of Google Cloud',
		defaults: {
			name: 'Google Cloud OCR',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'googleCloudOcrApi',
				required: true,
				displayOptions: { show: { authentication: ['apiKey'] } },
			},
			{
				name: 'googleApi',
				required: true,
				displayOptions: { show: { authentication: ['serviceAccount'] } },
			},
		],
		properties: [
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				options: [
					{
						name: 'API Key',
						value: 'apiKey',
						description: 'An API key of the Cloud Vision API, or Gateway credits',
					},
					{
						name: 'Service Account',
						value: 'serviceAccount',
						description: 'A service account for the Cloud Vision API and Document AI',
					},
				],
				default: 'apiKey',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Process Document',
						value: 'processDocument',
						description:
							'Read the text and the entities of a document with a processor of Document AI',
						action: 'Process a document with Document AI',
					},
					{
						name: 'Read Text',
						value: 'readText',
						description:
							'Read the text of an image, a PDF or a TIFF file with the Cloud Vision API',
						action: 'Read the text of an image or a document',
					},
				],
				default: 'readText',
			},
			{
				displayName: 'Input Type',
				name: 'inputType',
				type: 'options',
				options: [
					{ name: 'Binary File', value: 'binary' },
					{ name: 'Image URL', value: 'url' },
				],
				default: 'binary',
				displayOptions: { show: { operation: ['readText'] } },
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				hint: 'The name of the input binary field with the image or the document',
				displayOptions: {
					show: { operation: ['readText', 'processDocument'] },
					hide: { inputType: ['url'] },
				},
			},
			{
				displayName: 'Image URL',
				name: 'imageUrl',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g. https://example.com/scan.png or gs://my-bucket/scan.png',
				description: 'A public URL or a Cloud Storage URI of an image',
				displayOptions: { show: { operation: ['readText'], inputType: ['url'] } },
			},
			{
				displayName: 'Text Type',
				name: 'detection',
				type: 'options',
				options: [
					{
						name: 'Document (Dense Text)',
						value: 'DOCUMENT_TEXT_DETECTION',
						description: 'For scans, forms and pages with much text',
					},
					{
						name: 'Text in Images (Sparse Text)',
						value: 'TEXT_DETECTION',
						description: 'For photos and signs with little text',
					},
				],
				default: 'DOCUMENT_TEXT_DETECTION',
				displayOptions: { show: { operation: ['readText'] } },
			},
			{
				displayName: 'Processor',
				name: 'processor',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g. projects/my-project/locations/us/processors/1a2b3c4d5e6f7a8b',
				description: 'The resource name of the processor of Document AI',
				displayOptions: { show: { operation: ['processDocument'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Include Full Response',
						name: 'includeFullResponse',
						type: 'boolean',
						default: false,
						description: 'Whether to add the full answer of the API to the output',
					},
					{
						displayName: 'Language Hints',
						name: 'languageHints',
						type: 'string',
						default: '',
						placeholder: 'e.g. en,de',
						description: 'Comma-separated codes of the languages of the text',
						displayOptions: { show: { '/operation': ['readText'] } },
					},
					{
						displayName: 'Max Pages',
						name: 'maxPages',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 2000 },
						default: DEFAULT_MAX_PAGES,
						description:
							'The most pages of a PDF, TIFF or GIF file to read. The first request reads up to 5 pages.',
						displayOptions: { show: { '/operation': ['readText'] } },
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i);
				const json =
					operation === 'processDocument'
						? await processDocument.call(this, i)
						: await readText.call(this, i);
				returnData.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}

function readTextOptions(this: IExecuteFunctions, i: number): ReadTextOptions {
	const options = this.getNodeParameter('options', i, {});
	const values = isRecord(options) ? options : {};
	const languageHints = textOf(values.languageHints)
		.split(',')
		.map((hint) => hint.trim())
		.filter((hint) => hint.length > 0);
	const maxPages =
		typeof values.maxPages === 'number' && values.maxPages >= 1
			? Math.floor(values.maxPages)
			: DEFAULT_MAX_PAGES;
	return { languageHints, maxPages, includeFullResponse: values.includeFullResponse === true };
}

async function readText(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const options = readTextOptions.call(this, i);
	const request: IDataObject = {
		features: [{ type: textOf(this.getNodeParameter('detection', i, 'DOCUMENT_TEXT_DETECTION')) }],
		...(options.languageHints.length > 0
			? { imageContext: { languageHints: options.languageHints } }
			: {}),
	};

	if (this.getNodeParameter('inputType', i, 'binary') === 'url') {
		const imageUrl = textOf(this.getNodeParameter('imageUrl', i)).trim();
		const source = imageUrl.startsWith('gs://')
			? { gcsImageUri: imageUrl }
			: { imageUri: imageUrl };
		const answer = await googleCloudOcrRequest.call(this, 'vision', '/v1/images:annotate', {
			requests: [{ ...request, image: { source } }],
		});
		return imageResult.call(this, answer, i, options);
	}

	const binaryPropertyName = textOf(this.getNodeParameter('binaryPropertyName', i));
	const binaryData = this.helpers.assertBinaryData(i, binaryPropertyName);
	const content = (await this.helpers.getBinaryDataBuffer(i, binaryPropertyName)).toString(
		'base64',
	);
	if (FILE_MIME_TYPES.has(binaryData.mimeType)) {
		return await fileResult.call(
			this,
			i,
			request,
			{ content, mimeType: binaryData.mimeType },
			options,
		);
	}
	const answer = await googleCloudOcrRequest.call(this, 'vision', '/v1/images:annotate', {
		requests: [{ ...request, image: { content } }],
	});
	return imageResult.call(this, answer, i, options);
}

/** The text of an image: the answer of `images:annotate`. */
function imageResult(
	this: IExecuteFunctions,
	answer: unknown,
	i: number,
	options: ReadTextOptions,
): IDataObject {
	const [response] = recordsOf(isRecord(answer) ? answer.responses : undefined);
	if (!response) {
		throw new NodeOperationError(this.getNode(), 'The Vision API gave no answer', { itemIndex: i });
	}
	const error = errorOf(response);
	if (error) throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
	const [first] = recordsOf(response.textAnnotations);
	const language = first ? textOf(first.locale) : '';
	return {
		text: annotationText(response),
		pageCount: 1,
		...(language ? { language } : {}),
		...(options.includeFullResponse ? { response: toDataObject(response) } : {}),
	};
}

/**
 * The text of a PDF, TIFF or GIF file: `files:annotate`, 5 pages at a time. The first request
 * leaves out the pages, so that the API reads the first pages and gives the page count.
 */
async function fileResult(
	this: IExecuteFunctions,
	i: number,
	request: IDataObject,
	inputConfig: { content: string; mimeType: string },
	options: ReadTextOptions,
): Promise<IDataObject> {
	const pages: IDataObject[] = [];
	const responses: IDataObject[] = [];
	let totalPages = 0;
	let pageNumbers: number[] | undefined;
	do {
		const answer = await googleCloudOcrRequest.call(this, 'vision', '/v1/files:annotate', {
			requests: [{ ...request, inputConfig, ...(pageNumbers ? { pages: pageNumbers } : {}) }],
		});
		const [fileAnswer] = recordsOf(isRecord(answer) ? answer.responses : undefined);
		if (!fileAnswer) {
			throw new NodeOperationError(this.getNode(), 'The Vision API gave no answer', {
				itemIndex: i,
			});
		}
		const error = errorOf(fileAnswer);
		if (error) throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
		if (typeof fileAnswer.totalPages === 'number') totalPages = fileAnswer.totalPages;
		if (options.includeFullResponse) responses.push(toDataObject(fileAnswer));

		const pageAnswers = recordsOf(fileAnswer.responses);
		for (const [index, pageAnswer] of pageAnswers.entries()) {
			const pageError = errorOf(pageAnswer);
			if (pageError) throw new NodeOperationError(this.getNode(), pageError, { itemIndex: i });
			const context = isRecord(pageAnswer.context) ? pageAnswer.context : {};
			const page =
				typeof context.pageNumber === 'number'
					? context.pageNumber
					: (pageNumbers?.[index] ?? index + 1);
			if (page <= options.maxPages) pages.push({ page, text: annotationText(pageAnswer) });
		}

		const lastPage = pageNumbers ? pageNumbers[pageNumbers.length - 1] : pageAnswers.length;
		const limit = Math.min(totalPages, options.maxPages);
		pageNumbers =
			pageAnswers.length > 0 && lastPage < limit
				? pageRange(lastPage + 1, Math.min(lastPage + PAGES_PER_REQUEST, limit))
				: undefined;
	} while (pageNumbers);

	return {
		text: pages.map((page) => page.text).join('\n\n'),
		pageCount: totalPages,
		pages,
		...(options.includeFullResponse ? { responses } : {}),
	};
}

async function processDocument(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const processor = textOf(this.getNodeParameter('processor', i)).trim().replace(/^\/+/, '');
	const location = processorLocation(processor);
	if (!location) {
		throw new NodeOperationError(this.getNode(), 'The processor is not valid', {
			itemIndex: i,
			description:
				'Enter the resource name of the processor, for example projects/my-project/locations/us/processors/1a2b3c4d5e6f7a8b.',
		});
	}
	const options = readTextOptions.call(this, i);
	const binaryPropertyName = textOf(this.getNodeParameter('binaryPropertyName', i));
	const binaryData = this.helpers.assertBinaryData(i, binaryPropertyName);
	const content = (await this.helpers.getBinaryDataBuffer(i, binaryPropertyName)).toString(
		'base64',
	);

	const answer = await googleCloudOcrRequest.call(
		this,
		'documentAi',
		`/v1/${processor}:process`,
		{ rawDocument: { content, mimeType: binaryData.mimeType }, skipHumanReview: true },
		location,
	);
	const document = isRecord(answer) && isRecord(answer.document) ? answer.document : undefined;
	if (!document) {
		throw new NodeOperationError(this.getNode(), 'Document AI gave no document', { itemIndex: i });
	}

	const entities = recordsOf(document.entities).map((entity) => {
		const normalized = isRecord(entity.normalizedValue) ? textOf(entity.normalizedValue.text) : '';
		return {
			type: textOf(entity.type),
			mentionText: textOf(entity.mentionText),
			...(typeof entity.confidence === 'number' ? { confidence: entity.confidence } : {}),
			...(normalized ? { normalizedValue: normalized } : {}),
		};
	});
	return {
		text: textOf(document.text),
		pageCount: recordsOf(document.pages).length,
		entities,
		...(options.includeFullResponse ? { document: toDataObject(document) } : {}),
	};
}
