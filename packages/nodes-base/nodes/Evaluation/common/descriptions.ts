import type { INodeProperties } from 'n8n-workflow';

/** Fork code (not in upstream n8n): the Google authentication of the Evaluation nodes. A Data table needs none. */
export const authentication: INodeProperties = {
	displayName: 'Authentication',
	name: 'authentication',
	type: 'options',
	options: [
		{
			name: 'Service Account',
			value: 'serviceAccount',
		},
		{
			// eslint-disable-next-line n8n-nodes-base/node-param-display-name-miscased
			name: 'OAuth2 (recommended)',
			value: 'oAuth2',
		},
	],
	default: 'oAuth2',
	displayOptions: {
		hide: { source: ['dataTable'] },
	},
};
