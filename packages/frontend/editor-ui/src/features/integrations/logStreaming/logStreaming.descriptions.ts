/**
 * Fork code (not in upstream n8n): the fields of the settings form of each destination type, as
 * node parameters. The FORK.md of this folder describes them.
 */
import type { useI18n } from '@n8n/i18n';
import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';

import type { DestinationType } from './logStreaming.utils';

type I18n = ReturnType<typeof useI18n>;

/** The credential types that a webhook destination can use, as the backend accepts them. */
export const WEBHOOK_CREDENTIAL_TYPES = [
	'httpBasicAuth',
	'httpBearerAuth',
	'httpCustomAuth',
	'httpHeaderAuth',
	'httpQueryAuth',
] as const;

const PREFIX = 'settings.log-streaming.parameters';

/** Names that need no translation: methods, protocols and syslog facilities. */
const plainOptions = (values: Array<string | number>, names?: string[]): INodePropertyOptions[] =>
	values.map((value, index) => ({ name: names?.[index] ?? String(value), value }));

const SYSLOG_FACILITIES = [0, 1, 3, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23];
const SYSLOG_FACILITY_NAMES = [
	'Kernel',
	'User',
	'System',
	'Audit',
	'Alert',
	'Local0',
	'Local1',
	'Local2',
	'Local3',
	'Local4',
	'Local5',
	'Local6',
	'Local7',
];

interface CollectionTexts {
	displayName: string;
	placeholder: string;
	item: string;
}

function keyValueCollection(
	i18n: I18n,
	name: 'queryParameters' | 'headerParameters',
	texts: CollectionTexts,
	show: Record<string, Array<string | boolean>>,
): INodeProperties {
	return {
		displayName: texts.displayName,
		name,
		type: 'fixedCollection',
		displayOptions: { show },
		typeOptions: { multipleValues: true },
		placeholder: texts.placeholder,
		default: {},
		options: [
			{
				name: 'parameters',
				displayName: texts.item,
				values: [
					{
						displayName: i18n.baseText(`${PREFIX}.name`),
						name: 'name',
						type: 'string',
						default: '',
					},
					{
						displayName: i18n.baseText(`${PREFIX}.value`),
						name: 'value',
						type: 'string',
						default: '',
					},
				],
			},
		],
	};
}

function specifyOptions(i18n: I18n): INodePropertyOptions[] {
	return [
		{ name: i18n.baseText(`${PREFIX}.specify.keypair`), value: 'keypair' },
		{ name: i18n.baseText(`${PREFIX}.specify.json`), value: 'json' },
	];
}

function webhookDescription(i18n: I18n): INodeProperties[] {
	const credentialTypeNames: Record<(typeof WEBHOOK_CREDENTIAL_TYPES)[number], string> = {
		httpBasicAuth: i18n.baseText(`${PREFIX}.genericAuthType.httpBasicAuth`),
		httpBearerAuth: i18n.baseText(`${PREFIX}.genericAuthType.httpBearerAuth`),
		httpCustomAuth: i18n.baseText(`${PREFIX}.genericAuthType.httpCustomAuth`),
		httpHeaderAuth: i18n.baseText(`${PREFIX}.genericAuthType.httpHeaderAuth`),
		httpQueryAuth: i18n.baseText(`${PREFIX}.genericAuthType.httpQueryAuth`),
	};
	return [
		{
			displayName: i18n.baseText(`${PREFIX}.url`),
			name: 'url',
			type: 'string',
			default: 'https://',
			placeholder: 'https://example.com/n8n-events',
			description: i18n.baseText(`${PREFIX}.url.description`),
			required: true,
			noDataExpression: true,
		},
		{
			displayName: i18n.baseText(`${PREFIX}.method`),
			name: 'method',
			type: 'options',
			options: plainOptions(['GET', 'POST', 'PUT']),
			default: 'POST',
			noDataExpression: true,
		},
		{
			displayName: i18n.baseText(`${PREFIX}.authentication`),
			name: 'authentication',
			type: 'options',
			options: [
				{ name: i18n.baseText(`${PREFIX}.authentication.none`), value: 'none' },
				{
					name: i18n.baseText(`${PREFIX}.authentication.generic`),
					value: 'genericCredentialType',
					description: i18n.baseText(`${PREFIX}.authentication.generic.description`),
				},
			],
			default: 'none',
			noDataExpression: true,
		},
		{
			displayName: i18n.baseText(`${PREFIX}.genericAuthType`),
			name: 'genericAuthType',
			type: 'options',
			options: WEBHOOK_CREDENTIAL_TYPES.map((type) => ({
				name: credentialTypeNames[type],
				value: type,
			})),
			default: '',
			displayOptions: { show: { authentication: ['genericCredentialType'] } },
			noDataExpression: true,
		},
		{
			displayName: i18n.baseText(`${PREFIX}.sendQuery`),
			name: 'sendQuery',
			type: 'boolean',
			default: false,
			noDataExpression: true,
		},
		{
			displayName: i18n.baseText(`${PREFIX}.specifyQuery`),
			name: 'specifyQuery',
			type: 'options',
			displayOptions: { show: { sendQuery: [true] } },
			options: specifyOptions(i18n),
			default: 'keypair',
			noDataExpression: true,
		},
		keyValueCollection(
			i18n,
			'queryParameters',
			{
				displayName: i18n.baseText(`${PREFIX}.queryParameters`),
				placeholder: i18n.baseText(`${PREFIX}.queryParameters.placeholder`),
				item: i18n.baseText(`${PREFIX}.queryParameters.item`),
			},
			{ sendQuery: [true], specifyQuery: ['keypair'] },
		),
		{
			displayName: i18n.baseText(`${PREFIX}.json`),
			name: 'jsonQuery',
			type: 'json',
			displayOptions: { show: { sendQuery: [true], specifyQuery: ['json'] } },
			default: '',
			noDataExpression: true,
		},
		{
			displayName: i18n.baseText(`${PREFIX}.sendHeaders`),
			name: 'sendHeaders',
			type: 'boolean',
			default: false,
			noDataExpression: true,
		},
		{
			displayName: i18n.baseText(`${PREFIX}.specifyHeaders`),
			name: 'specifyHeaders',
			type: 'options',
			displayOptions: { show: { sendHeaders: [true] } },
			options: specifyOptions(i18n),
			default: 'keypair',
			noDataExpression: true,
		},
		keyValueCollection(
			i18n,
			'headerParameters',
			{
				displayName: i18n.baseText(`${PREFIX}.headerParameters`),
				placeholder: i18n.baseText(`${PREFIX}.headerParameters.placeholder`),
				item: i18n.baseText(`${PREFIX}.headerParameters.item`),
			},
			{ sendHeaders: [true], specifyHeaders: ['keypair'] },
		),
		{
			displayName: i18n.baseText(`${PREFIX}.json`),
			name: 'jsonHeaders',
			type: 'json',
			displayOptions: { show: { sendHeaders: [true], specifyHeaders: ['json'] } },
			default: '',
			noDataExpression: true,
		},
		{
			displayName: i18n.baseText(`${PREFIX}.options`),
			name: 'options',
			type: 'collection',
			placeholder: i18n.baseText(`${PREFIX}.options.placeholder`),
			default: {},
			options: [
				{
					displayName: i18n.baseText(`${PREFIX}.queryParameterArrays`),
					name: 'queryParameterArrays',
					type: 'options',
					options: [
						{
							name: i18n.baseText(`${PREFIX}.queryParameterArrays.repeat`),
							value: 'repeat',
							description: 'foo=bar&foo=qux',
						},
						{
							name: i18n.baseText(`${PREFIX}.queryParameterArrays.brackets`),
							value: 'brackets',
							description: 'foo[]=bar&foo[]=qux',
						},
						{
							name: i18n.baseText(`${PREFIX}.queryParameterArrays.indices`),
							value: 'indices',
							description: 'foo[0]=bar&foo[1]=qux',
						},
					],
					default: 'brackets',
				},
				{
					displayName: i18n.baseText(`${PREFIX}.allowUnauthorizedCerts`),
					name: 'allowUnauthorizedCerts',
					type: 'boolean',
					default: false,
					description: i18n.baseText(`${PREFIX}.allowUnauthorizedCerts.description`),
				},
				{
					displayName: i18n.baseText(`${PREFIX}.proxy`),
					name: 'proxy',
					type: 'fixedCollection',
					default: {},
					options: [
						{
							name: 'proxy',
							displayName: i18n.baseText(`${PREFIX}.proxy`),
							values: [
								{
									displayName: i18n.baseText(`${PREFIX}.protocol`),
									name: 'protocol',
									type: 'options',
									options: plainOptions(['https', 'http'], ['HTTPS', 'HTTP']),
									default: 'https',
								},
								{
									displayName: i18n.baseText(`${PREFIX}.host`),
									name: 'host',
									type: 'string',
									default: '',
								},
								{
									displayName: i18n.baseText(`${PREFIX}.port`),
									name: 'port',
									type: 'number',
									default: 9000,
								},
							],
						},
					],
				},
				{
					displayName: i18n.baseText(`${PREFIX}.redirect`),
					name: 'redirect',
					type: 'fixedCollection',
					default: {},
					options: [
						{
							name: 'redirect',
							displayName: i18n.baseText(`${PREFIX}.redirect`),
							values: [
								{
									displayName: i18n.baseText(`${PREFIX}.redirect.followRedirects`),
									name: 'followRedirects',
									type: 'boolean',
									default: true,
								},
								{
									displayName: i18n.baseText(`${PREFIX}.redirect.maxRedirects`),
									name: 'maxRedirects',
									type: 'number',
									default: 21,
								},
							],
						},
					],
				},
				{
					displayName: i18n.baseText(`${PREFIX}.timeout`),
					name: 'timeout',
					type: 'number',
					typeOptions: { minValue: 1 },
					default: 5000,
					description: i18n.baseText(`${PREFIX}.timeout.description`),
				},
			],
		},
	];
}

function sentryDescription(i18n: I18n): INodeProperties[] {
	return [
		{
			displayName: i18n.baseText(`${PREFIX}.dsn`),
			name: 'dsn',
			type: 'string',
			default: 'https://',
			placeholder: 'https://public-key@o0.ingest.sentry.io/0',
			description: i18n.baseText(`${PREFIX}.dsn.description`),
			required: true,
			noDataExpression: true,
		},
	];
}

function syslogDescription(i18n: I18n): INodeProperties[] {
	return [
		{
			displayName: i18n.baseText(`${PREFIX}.host`),
			name: 'host',
			type: 'string',
			default: '127.0.0.1',
			placeholder: '127.0.0.1',
			required: true,
			noDataExpression: true,
		},
		{
			displayName: i18n.baseText(`${PREFIX}.port`),
			name: 'port',
			type: 'number',
			default: 514,
			noDataExpression: true,
		},
		{
			displayName: i18n.baseText(`${PREFIX}.protocol`),
			name: 'protocol',
			type: 'options',
			options: plainOptions(['tcp', 'tls', 'udp'], ['TCP', 'TLS', 'UDP']),
			default: 'tcp',
			noDataExpression: true,
		},
		{
			displayName: i18n.baseText(`${PREFIX}.tlsCa`),
			name: 'tlsCa',
			type: 'string',
			typeOptions: { rows: 4 },
			default: '',
			description: i18n.baseText(`${PREFIX}.tlsCa.description`),
			displayOptions: { show: { protocol: ['tls'] } },
			noDataExpression: true,
		},
		{
			displayName: i18n.baseText(`${PREFIX}.facility`),
			name: 'facility',
			type: 'options',
			options: plainOptions(SYSLOG_FACILITIES, SYSLOG_FACILITY_NAMES),
			default: 16,
			noDataExpression: true,
		},
		{
			displayName: i18n.baseText(`${PREFIX}.appName`),
			name: 'app_name',
			type: 'string',
			default: 'n8n',
			placeholder: 'n8n',
			noDataExpression: true,
		},
	];
}

/** The fields of the settings form of a destination type. */
export function destinationDescription(i18n: I18n, type: DestinationType): INodeProperties[] {
	switch (type) {
		case '$$MessageEventBusDestinationWebhook':
			return webhookDescription(i18n);
		case '$$MessageEventBusDestinationSentry':
			return sentryDescription(i18n);
		case '$$MessageEventBusDestinationSyslog':
			return syslogDescription(i18n);
	}
}
