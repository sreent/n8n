import { LogStreamingDestinationPublicDto } from '@n8n/api-types';
import type {
	CreateDestinationDto,
	CreateLogStreamingDestinationPublic,
	LogStreamingDestinationPublicType,
	UpdateLogStreamingDestinationPublic,
} from '@n8n/api-types';
import {
	circuitBreakerSchema,
	defaultMessageEventBusDestinationSentryOptions,
	defaultMessageEventBusDestinationSyslogOptions,
	defaultMessageEventBusDestinationWebhookOptions,
	MessageEventBusDestinationSentryOptionsSchema,
	MessageEventBusDestinationSyslogOptionsSchema,
	MessageEventBusDestinationWebhookOptionsSchema,
	storedDestinationHostSchemas,
	webhookParameterOptionsSchema,
} from 'n8n-workflow';
import { z } from 'zod';

import { ALL_EVENTS } from '../log-streaming.constants';

/** A destination as the REST API takes it. The field `__type` gives the kind. */
export type DestinationInput = z.infer<typeof CreateDestinationDto>;

/**
 * The options of a destination that is stored or that the environment gives. New input gets the
 * strict host checks of `CreateDestinationDto` and of the public API. Stored options keep the
 * earlier, looser checks of the URL and the host, so that a destination that worked before still
 * loads.
 */
const storedDestinationSchema = z.discriminatedUnion('__type', [
	MessageEventBusDestinationWebhookOptionsSchema.extend({ url: storedDestinationHostSchemas.url }),
	MessageEventBusDestinationSentryOptionsSchema.extend({ dsn: storedDestinationHostSchemas.url }),
	MessageEventBusDestinationSyslogOptionsSchema.extend({
		host: storedDestinationHostSchemas.host,
	}),
]);

const environmentCircuitBreakerSchema = circuitBreakerSchema
	.unwrap()
	.pick({ maxFailures: true, failureWindow: true })
	.optional();

/**
 * A destination of `N8N_LOG_STREAMING_DESTINATIONS`: the fields of the public API, with `type` and
 * without an id. The URL and the host keep the looser checks, so that a config that booted
 * before still boots.
 */
export const EnvironmentDestinationSchema = z.discriminatedUnion('type', [
	MessageEventBusDestinationWebhookOptionsSchema.omit({
		__type: true,
		id: true,
		credentials: true,
		authentication: true,
		genericAuthType: true,
		nodeCredentialType: true,
		responseCodeMustMatch: true,
		expectedStatusCode: true,
		sendPayload: true,
	}).extend({
		type: z.literal('webhook'),
		url: storedDestinationHostSchemas.url,
		options: webhookParameterOptionsSchema
			.unwrap()
			.omit({ batch: true, response: true })
			.optional(),
		circuitBreaker: environmentCircuitBreakerSchema,
	}),
	MessageEventBusDestinationSyslogOptionsSchema.omit({
		__type: true,
		id: true,
		credentials: true,
		eol: true,
		expectedStatusCode: true,
	}).extend({
		type: z.literal('syslog'),
		host: storedDestinationHostSchemas.host,
		circuitBreaker: environmentCircuitBreakerSchema,
	}),
	MessageEventBusDestinationSentryOptionsSchema.omit({
		__type: true,
		id: true,
		credentials: true,
		tracesSampleRate: true,
		sendPayload: true,
	}).extend({
		type: z.literal('sentry'),
		dsn: storedDestinationHostSchemas.url,
		circuitBreaker: environmentCircuitBreakerSchema,
	}),
]);

export type EnvironmentDestination = z.infer<typeof EnvironmentDestinationSchema>;

/** A destination in the format of the public API or of the environment, with `type`. */
type PublicDestinationInput =
	| CreateLogStreamingDestinationPublic
	| UpdateLogStreamingDestinationPublic
	| EnvironmentDestination;

/** A stored destination: the input with the defaults of its kind, and an id. */
export type DestinationOptions = DestinationInput & { id: string };

export type DestinationType = DestinationOptions['__type'];

export type WebhookDestinationOptions = Extract<
	DestinationOptions,
	{ __type: '$$MessageEventBusDestinationWebhook' }
>;
export type SyslogDestinationOptions = Extract<
	DestinationOptions,
	{ __type: '$$MessageEventBusDestinationSyslog' }
>;
export type SentryDestinationOptions = Extract<
	DestinationOptions,
	{ __type: '$$MessageEventBusDestinationSentry' }
>;

/** The defaults of each kind, from `n8n-workflow`. */
const DEFAULTS: Record<DestinationType, object> = {
	$$MessageEventBusDestinationWebhook: defaultMessageEventBusDestinationWebhookOptions,
	$$MessageEventBusDestinationSyslog: defaultMessageEventBusDestinationSyslogOptions,
	$$MessageEventBusDestinationSentry: defaultMessageEventBusDestinationSentryOptions,
};

/** The kind of a destination of the public API and of `N8N_LOG_STREAMING_DESTINATIONS`. */
export const PUBLIC_TYPES: Record<DestinationType, LogStreamingDestinationPublicType> = {
	$$MessageEventBusDestinationWebhook: 'webhook',
	$$MessageEventBusDestinationSyslog: 'syslog',
	$$MessageEventBusDestinationSentry: 'sentry',
};

/** Stored options that are valid, with their id. Else `undefined`. */
export function parseDestinationOptions(value: unknown): DestinationOptions | undefined {
	const result = storedDestinationSchema.safeParse(value);
	if (!result.success) return undefined;
	const { id } = result.data;
	return id ? { ...result.data, id } : undefined;
}

/**
 * The options to store for a destination: the input over the stored options of the same kind, else
 * over the defaults of the kind. A new destination is off until the input turns it on.
 */
export function buildDestinationOptions(
	input: DestinationInput,
	id: string,
	stored?: DestinationOptions,
	{ enabledByDefault = false } = {},
): DestinationOptions | undefined {
	const base =
		stored?.__type === input.__type
			? stored
			: { ...DEFAULTS[input.__type], enabled: enabledByDefault };
	return parseDestinationOptions({ ...base, ...input, id });
}

/**
 * Whether a destination subscribes to an event. An entry is an event name, a group such as
 * `n8n.workflow` (with or without the last dot), or `*` for all events.
 */
export function isSubscribed(subscribedEvents: readonly string[] | undefined, eventName: string) {
	return (subscribedEvents ?? []).some((entry) => {
		if (entry === ALL_EVENTS) return true;
		const group = entry.endsWith('.') ? entry : `${entry}.`;
		return eventName === entry || eventName.startsWith(group);
	});
}

/** A destination as the public API gives it: with `type`, and without the internal fields. */
export function toPublicDestination(options: DestinationOptions) {
	return LogStreamingDestinationPublicDto.parse({
		...options,
		type: PUBLIC_TYPES[options.__type],
	});
}

/** A destination of the public API or of the environment, as the REST API takes it. */
export function fromPublicDestination(input: PublicDestinationInput): DestinationInput {
	switch (input.type) {
		case 'webhook': {
			const { type: _type, ...webhook } = input;
			return { ...webhook, __type: '$$MessageEventBusDestinationWebhook' };
		}
		case 'syslog': {
			const { type: _type, ...syslog } = input;
			return { ...syslog, __type: '$$MessageEventBusDestinationSyslog' };
		}
		case 'sentry': {
			const { type: _type, ...sentry } = input;
			return { ...sentry, __type: '$$MessageEventBusDestinationSentry' };
		}
	}
}
