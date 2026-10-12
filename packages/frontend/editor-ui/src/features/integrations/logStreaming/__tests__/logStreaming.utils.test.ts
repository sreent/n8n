import { createTestingPinia } from '@pinia/testing';
import { useI18n } from '@n8n/i18n';
import { setActivePinia } from 'pinia';

import {
	eventGroups,
	isEventSubscribed,
	isGroupSubscribed,
	newDestination,
	textOrFallback,
	typeLabel,
	withEvent,
	withGroup,
} from '../logStreaming.utils';

setActivePinia(createTestingPinia());

const EVENTS = [
	'n8n.audit.user.login.success',
	'n8n.audit.user.deleted',
	'n8n.workflow.started',
	'n8n.workflow.success',
	'n8n.node.started',
];

describe('eventGroups', () => {
	it('groups the events by the first two parts of their names, in order', () => {
		expect(eventGroups(EVENTS)).toEqual([
			{ name: 'n8n.audit', events: ['n8n.audit.user.login.success', 'n8n.audit.user.deleted'] },
			{ name: 'n8n.workflow', events: ['n8n.workflow.started', 'n8n.workflow.success'] },
			{ name: 'n8n.node', events: ['n8n.node.started'] },
		]);
	});
});

describe('subscriptions', () => {
	it.each([
		[['*'], 'n8n.audit', true],
		[['n8n.audit'], 'n8n.audit', true],
		[['n8n.audit.'], 'n8n.audit', true],
		[['n8n.audit.user.deleted'], 'n8n.audit', false],
		[[], 'n8n.audit', false],
	])('subscriptions %j take the group %s: %s', (subscribed, group, expected) => {
		expect(isGroupSubscribed(subscribed, group)).toBe(expected);
	});

	it('takes an event by its name or by its group', () => {
		expect(isEventSubscribed(['n8n.audit.user.deleted'], 'n8n.audit.user.deleted')).toBe(true);
		expect(isEventSubscribed(['n8n.audit'], 'n8n.audit.user.deleted')).toBe(true);
		expect(isEventSubscribed(['n8n.workflow'], 'n8n.audit.user.deleted')).toBe(false);
	});

	it('replaces the single events of a group with the group', () => {
		expect(
			withGroup(['n8n.audit.user.deleted', 'n8n.workflow'], 'n8n.audit', true, ['n8n.audit']),
		).toEqual(['n8n.workflow', 'n8n.audit']);
		expect(withGroup(['n8n.audit', 'n8n.workflow'], 'n8n.audit', false, [])).toEqual([
			'n8n.workflow',
		]);
	});

	it('keeps the other groups when a group goes off from all events', () => {
		expect(withGroup(['*'], 'n8n.node', false, ['n8n.audit', 'n8n.workflow', 'n8n.node'])).toEqual([
			'n8n.audit',
			'n8n.workflow',
		]);
	});

	it('adds or removes one event', () => {
		expect(withEvent(['n8n.workflow'], 'n8n.audit.user.deleted', true)).toEqual([
			'n8n.workflow',
			'n8n.audit.user.deleted',
		]);
		expect(withEvent(['n8n.audit.user.deleted'], 'n8n.audit.user.deleted', false)).toEqual([]);
	});
});

describe('newDestination', () => {
	it('gives the defaults of the type without an id, and keeps the destination off', () => {
		const destination = newDestination('$$MessageEventBusDestinationSyslog', 'Syslog');

		expect(destination).toMatchObject({
			__type: '$$MessageEventBusDestinationSyslog',
			label: 'Syslog',
			enabled: false,
			host: '127.0.0.1',
			port: 514,
			protocol: 'tcp',
			subscribedEvents: ['n8n.audit', 'n8n.workflow'],
		});
		expect(destination).not.toHaveProperty('id');
	});

	it('gives a copy, so that a change does not change the defaults', () => {
		const first = newDestination('$$MessageEventBusDestinationWebhook', 'Webhook');
		first.subscribedEvents?.push('n8n.node');

		expect(
			newDestination('$$MessageEventBusDestinationWebhook', 'Webhook').subscribedEvents,
		).toEqual(['n8n.audit', 'n8n.workflow']);
	});
});

describe('texts', () => {
	it('gives the text of a key, else the fallback', () => {
		const i18n = useI18n();

		expect(typeLabel(i18n, '$$MessageEventBusDestinationSyslog')).toBe('Syslog');
		expect(textOrFallback(i18n, 'settings.log-streaming.eventGroup.n8n.audit', 'x')).toBe(
			'Audit Events',
		);
		expect(
			textOrFallback(i18n, 'settings.log-streaming.eventGroup.n8n.unknown', 'n8n.unknown'),
		).toBe('n8n.unknown');
	});
});
