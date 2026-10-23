import type { IExecuteFunctions, INode } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { GoogleCloudOcr } from '../GoogleCloudOcr.node';

/** Fork test (not in upstream n8n): the node Google Cloud OCR. See `../README.md`. */

vi.mock('../../GenericFunctions', () => ({
	getGoogleAccessToken: vi.fn().mockResolvedValue({ access_token: 'service-account-token' }),
}));

const GATEWAY_HOST =
	'http://127.0.0.1:5678/ai-gateway/v1/gateway/exec/1/wf-1%7Cproject-1/google-ocr';

function setup(
	parameters: Record<string, unknown>,
	{
		mimeType = 'image/png',
		host = 'https://vision.googleapis.com',
		continueOnFail = false,
	}: { mimeType?: string; host?: string; continueOnFail?: boolean } = {},
) {
	const context = mock<IExecuteFunctions>();
	context.getInputData.mockReturnValue([{ json: {} }]);
	context.getNode.mockReturnValue(mock<INode>({ name: 'Google Cloud OCR' }));
	context.continueOnFail.mockReturnValue(continueOnFail);
	context.getNodeParameter.mockImplementation(((
		name: string,
		_index: number,
		fallback?: unknown,
	) =>
		name in parameters ? parameters[name] : fallback) as IExecuteFunctions['getNodeParameter']);
	context.getCredentials.mockResolvedValue({ apiKey: 'user-key', host });
	const httpRequestWithAuthentication = vi.fn();
	const httpRequest = vi.fn();
	context.helpers = {
		httpRequestWithAuthentication,
		httpRequest,
		assertBinaryData: vi.fn().mockReturnValue({ mimeType, data: '' }),
		getBinaryDataBuffer: vi.fn().mockResolvedValue(Buffer.from('scan')),
	} as unknown as IExecuteFunctions['helpers'];
	return { context, httpRequestWithAuthentication, httpRequest };
}

const run = async (context: IExecuteFunctions) => await new GoogleCloudOcr().execute.call(context);

const readText = {
	authentication: 'apiKey',
	operation: 'readText',
	inputType: 'binary',
	binaryPropertyName: 'data',
	detection: 'DOCUMENT_TEXT_DETECTION',
};

describe('GoogleCloudOcr', () => {
	it('is usable as a tool of an AI agent', () => {
		expect(new GoogleCloudOcr().description.usableAsTool).toBe(true);
	});

	it('reads the text of an image with an API key', async () => {
		const { context, httpRequestWithAuthentication } = setup({
			...readText,
			options: { languageHints: 'en, de' },
		});
		httpRequestWithAuthentication.mockResolvedValue({
			responses: [
				{
					fullTextAnnotation: { text: 'Invoice 42' },
					textAnnotations: [{ locale: 'en', description: 'Invoice 42' }],
				},
			],
		});

		const [output] = await run(context);

		expect(output).toEqual([
			{ json: { text: 'Invoice 42', pageCount: 1, language: 'en' }, pairedItem: { item: 0 } },
		]);
		expect(httpRequestWithAuthentication).toHaveBeenCalledWith('googleCloudOcrApi', {
			method: 'POST',
			url: 'https://vision.googleapis.com/v1/images:annotate',
			json: true,
			body: {
				requests: [
					{
						features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
						imageContext: { languageHints: ['en', 'de'] },
						image: { content: Buffer.from('scan').toString('base64') },
					},
				],
			},
		});
	});

	it('reads a Cloud Storage image by its URI', async () => {
		const { context, httpRequestWithAuthentication } = setup({
			...readText,
			inputType: 'url',
			imageUrl: 'gs://scans/receipt.png',
			detection: 'TEXT_DETECTION',
		});
		httpRequestWithAuthentication.mockResolvedValue({
			responses: [{ textAnnotations: [{ description: 'Total 5.00' }] }],
		});

		const [output] = await run(context);

		expect(output[0].json).toEqual({ text: 'Total 5.00', pageCount: 1 });
		const [, request] = httpRequestWithAuthentication.mock.calls[0];
		expect(request.body.requests[0]).toEqual({
			features: [{ type: 'TEXT_DETECTION' }],
			image: { source: { gcsImageUri: 'gs://scans/receipt.png' } },
		});
	});

	it('reads a PDF five pages at a time, up to the most pages', async () => {
		const { context, httpRequestWithAuthentication } = setup(
			{ ...readText, options: { maxPages: 7 } },
			{ mimeType: 'application/pdf' },
		);
		const page = (pageNumber: number) => ({
			fullTextAnnotation: { text: `Page ${pageNumber}` },
			context: { pageNumber },
		});
		httpRequestWithAuthentication
			.mockResolvedValueOnce({
				responses: [{ totalPages: 12, responses: [1, 2, 3, 4, 5].map(page) }],
			})
			.mockResolvedValueOnce({ responses: [{ totalPages: 12, responses: [6, 7].map(page) }] });

		const [output] = await run(context);

		expect(output[0].json.pageCount).toBe(12);
		expect(output[0].json.pages).toEqual(
			[1, 2, 3, 4, 5, 6, 7].map((pageNumber) => ({ page: pageNumber, text: `Page ${pageNumber}` })),
		);
		expect(output[0].json.text).toBe(
			'Page 1\n\nPage 2\n\nPage 3\n\nPage 4\n\nPage 5\n\nPage 6\n\nPage 7',
		);
		const requests = httpRequestWithAuthentication.mock.calls.map(([, request]) => request);
		expect(requests.map(({ url }) => url)).toEqual([
			'https://vision.googleapis.com/v1/files:annotate',
			'https://vision.googleapis.com/v1/files:annotate',
		]);
		expect(requests[0].body.requests[0].pages).toBeUndefined();
		expect(requests[0].body.requests[0].inputConfig.mimeType).toBe('application/pdf');
		expect(requests[1].body.requests[0].pages).toEqual([6, 7]);
	});

	it('processes a document with Document AI and a service account', async () => {
		const { context, httpRequest } = setup(
			{
				authentication: 'serviceAccount',
				operation: 'processDocument',
				binaryPropertyName: 'data',
				processor: 'projects/acme/locations/eu/processors/abc123',
			},
			{ mimeType: 'application/pdf' },
		);
		httpRequest.mockResolvedValue({
			document: {
				text: 'Invoice\nTotal: 5 USD',
				pages: [{}, {}],
				entities: [
					{
						type: 'total_amount',
						mentionText: '5 USD',
						confidence: 0.98,
						normalizedValue: { text: '5' },
					},
				],
			},
		});

		const [output] = await run(context);

		expect(output[0].json).toEqual({
			text: 'Invoice\nTotal: 5 USD',
			pageCount: 2,
			entities: [
				{ type: 'total_amount', mentionText: '5 USD', confidence: 0.98, normalizedValue: '5' },
			],
		});
		expect(httpRequest).toHaveBeenCalledWith({
			method: 'POST',
			url: 'https://eu-documentai.googleapis.com/v1/projects/acme/locations/eu/processors/abc123:process',
			json: true,
			headers: { Authorization: 'Bearer service-account-token' },
			body: {
				rawDocument: {
					content: Buffer.from('scan').toString('base64'),
					mimeType: 'application/pdf',
				},
				skipHumanReview: true,
			},
		});
	});

	it('sends Document AI to the URL of the credential, such as the AI gateway', async () => {
		const { context, httpRequestWithAuthentication } = setup(
			{
				authentication: 'apiKey',
				operation: 'processDocument',
				binaryPropertyName: 'data',
				processor: 'projects/acme/locations/us/processors/abc123',
			},
			{ host: GATEWAY_HOST },
		);
		httpRequestWithAuthentication.mockResolvedValue({ document: { text: 'Scan', pages: [{}] } });

		const [output] = await run(context);

		expect(output[0].json).toEqual({ text: 'Scan', pageCount: 1, entities: [] });
		expect(httpRequestWithAuthentication.mock.calls[0][1].url).toBe(
			`${GATEWAY_HOST}/v1/projects/acme/locations/us/processors/abc123:process`,
		);
	});

	it('refuses Document AI with an API key of Google, and a processor that is not valid', async () => {
		const documentAi = {
			authentication: 'apiKey',
			operation: 'processDocument',
			binaryPropertyName: 'data',
			processor: 'projects/acme/locations/us/processors/abc123',
		};
		await expect(run(setup(documentAi).context)).rejects.toThrow(
			'Document AI does not take API keys',
		);
		await expect(
			run(setup({ ...documentAi, processor: 'abc123' }, { host: GATEWAY_HOST }).context),
		).rejects.toThrow('The processor is not valid');
	});

	it('gives the error of the Vision API, also as output when the node continues on fail', async () => {
		const failing = setup(readText);
		failing.httpRequestWithAuthentication.mockResolvedValue({
			responses: [{ error: { code: 3, message: 'Bad image data.' } }],
		});
		await expect(run(failing.context)).rejects.toThrow('Bad image data.');

		const continuing = setup(readText, { continueOnFail: true });
		continuing.httpRequestWithAuthentication.mockResolvedValue({
			responses: [{ error: { code: 3, message: 'Bad image data.' } }],
		});
		const [output] = await run(continuing.context);
		expect(output[0].json).toEqual({ error: 'Bad image data.' });
	});
});
