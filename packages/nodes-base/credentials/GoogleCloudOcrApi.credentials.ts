import type { IAuthenticateGeneric, ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

/**
 * Fork credential (not in upstream n8n): an API key of the Cloud Vision API for the node Google
 * Cloud OCR. Its URL field lets the AI gateway of the fork serve the node with Gateway credits.
 */
export class GoogleCloudOcrApi implements ICredentialType {
	name = 'googleCloudOcrApi';

	displayName = 'Google Cloud OCR API';

	documentationUrl = 'https://cloud.google.com/vision/docs/setup';

	icon: Icon = 'file:icons/Google.svg';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'An API key of a Google Cloud project with the Cloud Vision API on. Document AI does not take API keys.',
		},
		{
			displayName: 'API URL',
			name: 'host',
			type: 'string',
			default: 'https://vision.googleapis.com',
			description: 'The URL of the Cloud Vision API. Keep the default.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'x-goog-api-key': '={{$credentials.apiKey}}',
			},
		},
	};
}
