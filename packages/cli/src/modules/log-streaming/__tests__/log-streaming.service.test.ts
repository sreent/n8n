import { mockLogger } from '@n8n/backend-test-utils';
import type { CredentialsFinderService, EventService } from '@n8n/backend-services';
import type { InstanceSettingsLoaderConfig } from '@n8n/config';
import type { CredentialsEntity, User } from '@n8n/db';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@n8n/errors';
import type { InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import { EventMessageAudit } from '@/eventbus/event-message-classes/event-message-audit';
import type { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';
import { InstanceBootstrappingError } from '@/instance-settings-loader/instance-bootstrapping.error';
import type { Publisher } from '@/scaling/pubsub/publisher.service';

import type {
	EventDestinationRepository,
	StoredDestinationRow,
} from '../database/event-destination.repository';
import type { DestinationCredentials } from '../destinations/destination-credentials';
import type { DestinationOptions } from '../destinations/destination-options';
import type { DestinationFactory } from '../destinations/destination.factory';
import type { LogStreamingDestination } from '../destinations/log-streaming-destination';
import { CONFIRM_SOURCE } from '../log-streaming.constants';
import { LogStreamingService } from '../log-streaming.service';

const ID_A = '3f1b8a52-6e7c-4f0e-9a51-2d9c7f8e1a20';
const ID_B = '6a0c2d4e-1b3f-4a5c-8d7e-9f0a1b2c3d4e';

const syslogRow = (id: string, host = 'logs.internal'): StoredDestinationRow => ({
	id,
	destination: {
		__type: '$$MessageEventBusDestinationSyslog',
		id,
		host,
		enabled: true,
		subscribedEvents: ['n8n.audit'],
	},
});

const auditEvent = () => new EventMessageAudit({ eventName: 'n8n.audit.user.login.success' });

describe('LogStreamingService', () => {
	const eventBus = mock<MessageEventBus>();
	const repository = mock<EventDestinationRepository>();
	const factory = mock<DestinationFactory>();
	const credentials = mock<DestinationCredentials>();
	const credentialsFinder = mock<CredentialsFinderService>();
	const publisher = mock<Publisher>();
	const instanceSettings = mock<InstanceSettings>({ instanceType: 'main' });
	const loaderConfig = mock<InstanceSettingsLoaderConfig>();
	const user = mock<User>({ id: 'user-1' });
	const eventService = mock<EventService>();

	let service: LogStreamingService;

	/**
	 * A destination that takes each event, and gives `delivered` for each delivery. A plain object,
	 * because the service compares the options of the destinations.
	 */
	const fakeDestination = (options: DestinationOptions, delivered = true) => {
		const destination = {
			id: options.id,
			options,
			wants: vi.fn().mockReturnValue(true),
			deliver: vi.fn().mockResolvedValue(delivered),
			sendTest: vi.fn().mockResolvedValue(true),
			close: vi.fn().mockResolvedValue(undefined),
		};
		return destination as unknown as LogStreamingDestination & typeof destination;
	};

	beforeEach(() => {
		vi.resetAllMocks();
		Object.assign(instanceSettings, { instanceType: 'main' });
		Object.assign(loaderConfig, { logStreamingManagedByEnv: false, logStreamingDestinations: '' });
		repository.findAllDestinations.mockResolvedValue([]);
		factory.create.mockImplementation((options) => fakeDestination(options));
		service = new LogStreamingService(
			mockLogger(),
			eventBus,
			repository,
			factory,
			credentials,
			credentialsFinder,
			publisher,
			instanceSettings,
			loaderConfig,
			eventService,
		);
	});

	describe('handleMessage', () => {
		it('confirms a message that no destination takes', async () => {
			const confirm = vi.fn();
			const message = auditEvent();

			await service.handleMessage(message, confirm);

			expect(confirm).toHaveBeenCalledWith(message, CONFIRM_SOURCE);
		});

		it('confirms a message when all destinations that take it delivered it', async () => {
			repository.findAllDestinations.mockResolvedValue([syslogRow(ID_A), syslogRow(ID_B)]);
			await service.loadDestinations();
			const confirm = vi.fn();

			await service.handleMessage(auditEvent(), confirm);

			expect(confirm).toHaveBeenCalledTimes(1);
		});

		it('leaves a message unconfirmed when a destination did not take it', async () => {
			repository.findAllDestinations.mockResolvedValue([syslogRow(ID_A), syslogRow(ID_B)]);
			factory.create.mockImplementation((options) => fakeDestination(options, options.id === ID_A));
			await service.loadDestinations();
			const confirm = vi.fn();

			await service.handleMessage(auditEvent(), confirm);

			expect(confirm).not.toHaveBeenCalled();
		});

		it('delivers only to the destinations that take the event', async () => {
			const skipping = fakeDestination(
				{ __type: '$$MessageEventBusDestinationSyslog', id: ID_A, host: 'logs' },
				false,
			);
			skipping.wants.mockReturnValue(false);
			factory.create.mockReturnValue(skipping);
			repository.findAllDestinations.mockResolvedValue([syslogRow(ID_A)]);
			await service.loadDestinations();
			const confirm = vi.fn();

			await service.handleMessage(auditEvent(), confirm);

			expect(skipping.deliver).not.toHaveBeenCalled();
			expect(confirm).toHaveBeenCalled();
		});
	});

	describe('loadDestinations', () => {
		it('keeps an unchanged destination, and replaces or closes the others', async () => {
			repository.findAllDestinations.mockResolvedValue([syslogRow(ID_A), syslogRow(ID_B)]);
			await service.loadDestinations();
			const [first, second] = factory.create.mock.results.map(({ value }) => value);

			repository.findAllDestinations.mockResolvedValue([syslogRow(ID_A)]);
			await service.loadDestinations();
			expect(factory.create).toHaveBeenCalledTimes(2);
			expect(second.close).toHaveBeenCalled();
			expect(first.close).not.toHaveBeenCalled();

			repository.findAllDestinations.mockResolvedValue([syslogRow(ID_A, 'other.internal')]);
			await service.loadDestinations();
			expect(factory.create).toHaveBeenCalledTimes(3);
			expect(first.close).toHaveBeenCalled();
			expect(credentials.clear).toHaveBeenCalledTimes(3);
		});

		it('skips stored options that are not valid', async () => {
			repository.findAllDestinations.mockResolvedValue([
				{ id: ID_A, destination: { __type: '$$MessageEventBusDestinationSyslog' } },
				syslogRow(ID_B),
			]);

			await service.loadDestinations();

			expect(factory.create).toHaveBeenCalledTimes(1);
			expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({ id: ID_B }));
		});

		it('skips a destination that the factory cannot make', async () => {
			repository.findAllDestinations.mockResolvedValue([syslogRow(ID_A)]);
			factory.create.mockImplementation(() => {
				throw new Error('not valid');
			});

			await expect(service.loadDestinations()).resolves.toBeUndefined();
		});
	});

	describe('environmentDestinations', () => {
		const withEnv = (value: unknown) => {
			loaderConfig.logStreamingDestinations =
				typeof value === 'string' ? value : JSON.stringify(value);
		};

		it('gives no destinations when the variable is empty', () => {
			expect(service.environmentDestinations()).toEqual([]);
		});

		it('gives the destinations with ids from their positions, on unless they are off', () => {
			withEnv([
				{ type: 'webhook', label: 'Audit', url: 'https://hooks.example.com/audit' },
				{ type: 'syslog', label: 'SIEM', host: 'syslog.example.com', enabled: false },
				{ type: 'sentry', label: 'Ops', dsn: 'https://public@sentry.example.com/1' },
			]);

			const destinations = service.environmentDestinations();

			expect(destinations).toMatchObject([
				{ __type: '$$MessageEventBusDestinationWebhook', label: 'Audit', enabled: true },
				{ __type: '$$MessageEventBusDestinationSyslog', label: 'SIEM', enabled: false },
				{ __type: '$$MessageEventBusDestinationSentry', label: 'Ops', enabled: true },
			]);
			expect(new Set(destinations.map(({ id }) => id)).size).toBe(3);
			expect(service.environmentDestinations().map(({ id }) => id)).toEqual(
				destinations.map(({ id }) => id),
			);
		});

		it.each([
			['not JSON', 'is not valid JSON'],
			[[{ type: 'syslog' }], '0.host'],
			[[{ type: 'kafka', url: 'https://example.com' }], 'is not valid'],
			[[{ type: 'sentry', dsn: 'https://sentry.example.com/1' }], 'Destination 0'],
		])('stops the start for the value %j', (value, message) => {
			withEnv(value);

			expect(() => service.environmentDestinations()).toThrow(InstanceBootstrappingError);
			expect(() => service.environmentDestinations()).toThrow(message);
		});
	});

	describe('init', () => {
		it('replaces the stored destinations with those of the environment on a main instance', async () => {
			Object.assign(loaderConfig, {
				logStreamingManagedByEnv: true,
				logStreamingDestinations: JSON.stringify([{ type: 'syslog', host: 'logs.internal' }]),
			});

			await service.init();

			expect(repository.replaceAll).toHaveBeenCalledWith([
				expect.objectContaining({
					destination: expect.objectContaining({ host: 'logs.internal', enabled: true }),
				}),
			]);
			expect(publisher.publishCommand).toHaveBeenCalledWith({ command: 'restart-event-bus' });
			expect(eventBus.on).toHaveBeenCalledWith('message', expect.any(Function));
		});

		it('only loads the stored destinations on a worker', async () => {
			Object.assign(loaderConfig, {
				logStreamingManagedByEnv: true,
				logStreamingDestinations: JSON.stringify([{ type: 'syslog', host: 'logs.internal' }]),
			});
			Object.assign(instanceSettings, { instanceType: 'worker' });

			await service.init();

			expect(repository.replaceAll).not.toHaveBeenCalled();
			expect(repository.findAllDestinations).toHaveBeenCalled();
		});
	});

	describe('saveDestination', () => {
		it('stores a new destination that is off, and asks the other instances to load it', async () => {
			const saved = await service.saveDestination(
				{ __type: '$$MessageEventBusDestinationSyslog', host: 'logs.internal' },
				user,
			);

			expect(saved).toMatchObject({ host: 'logs.internal', enabled: false });
			expect(repository.saveDestination).toHaveBeenCalledWith({
				id: saved.id,
				destination: expect.objectContaining({ id: saved.id, host: 'logs.internal' }),
			});
			expect(repository.findAllDestinations).toHaveBeenCalled();
			expect(publisher.publishCommand).toHaveBeenCalledWith({ command: 'restart-event-bus' });
			expect(eventService.emit).toHaveBeenCalledWith('log-streaming-destination-created', {
				user,
				destinationId: saved.id,
				destinationType: 'syslog',
				label: expect.any(String),
				enabled: false,
			});
		});

		it('changes the given options of a stored destination', async () => {
			repository.findAllDestinations.mockResolvedValue([syslogRow(ID_A)]);

			const saved = await service.saveDestination(
				{
					__type: '$$MessageEventBusDestinationSyslog',
					id: ID_A,
					host: 'logs.internal',
					port: 6514,
				},
				user,
			);

			expect(saved).toMatchObject({ id: ID_A, port: 6514, enabled: true });
			expect(eventService.emit).toHaveBeenCalledWith(
				'log-streaming-destination-updated',
				expect.objectContaining({ destinationId: ID_A, destinationType: 'syslog' }),
			);
		});

		it('rejects a change while the environment manages the destinations', async () => {
			loaderConfig.logStreamingManagedByEnv = true;

			await expect(
				service.saveDestination(
					{ __type: '$$MessageEventBusDestinationSyslog', host: 'logs' },
					user,
				),
			).rejects.toThrow(ConflictError);
			await expect(service.deleteDestination(ID_A, user)).rejects.toThrow(ConflictError);
			expect(repository.saveDestination).not.toHaveBeenCalled();
		});

		it('rejects an id that is not a UUID, and options that a delivery cannot use', async () => {
			await expect(
				service.saveDestination(
					{ __type: '$$MessageEventBusDestinationSyslog', id: 'abc', host: 'logs' },
					user,
				),
			).rejects.toThrow('must be a UUID');
			await expect(
				service.saveDestination(
					{
						__type: '$$MessageEventBusDestinationWebhook',
						url: 'https://example.com',
						sendHeaders: true,
						specifyHeaders: 'json',
						jsonHeaders: '{',
					},
					user,
				),
			).rejects.toThrow(BadRequestError);
			expect(repository.saveDestination).not.toHaveBeenCalled();
		});

		it('rejects a credential that the user cannot read', async () => {
			credentialsFinder.findCredentialForUser.mockResolvedValue(null);

			await expect(
				service.saveDestination(
					{
						__type: '$$MessageEventBusDestinationWebhook',
						url: 'https://example.com',
						authentication: 'genericCredentialType',
						genericAuthType: 'httpHeaderAuth',
						credentials: { httpHeaderAuth: { id: 'credential-1', name: 'Header' } },
					},
					user,
				),
			).rejects.toThrow(ForbiddenError);
			expect(credentialsFinder.findCredentialForUser).toHaveBeenCalledWith('credential-1', user, [
				'credential:read',
			]);
			expect(repository.saveDestination).not.toHaveBeenCalled();
		});

		it('accepts a credential that the user can read', async () => {
			credentialsFinder.findCredentialForUser.mockResolvedValue(mock<CredentialsEntity>());

			await service.saveDestination(
				{
					__type: '$$MessageEventBusDestinationWebhook',
					url: 'https://example.com',
					authentication: 'genericCredentialType',
					genericAuthType: 'httpHeaderAuth',
					credentials: { httpHeaderAuth: { id: 'credential-1', name: 'Header' } },
				},
				user,
			);

			expect(repository.saveDestination).toHaveBeenCalled();
		});
	});

	describe('deleteDestination', () => {
		it('deletes a destination, gives its options, and asks the other instances to drop it', async () => {
			repository.findAllDestinations.mockResolvedValue([syslogRow(ID_A)]);
			repository.deleteDestination.mockResolvedValue(true);

			await expect(service.deleteDestination(ID_A, user)).resolves.toMatchObject({ id: ID_A });

			expect(repository.deleteDestination).toHaveBeenCalledWith(ID_A);
			expect(publisher.publishCommand).toHaveBeenCalledWith({ command: 'restart-event-bus' });
			expect(eventService.emit).toHaveBeenCalledWith('log-streaming-destination-deleted', {
				user,
				destinationId: ID_A,
				destinationType: 'syslog',
				label: expect.any(String),
				enabled: true,
			});
		});

		it('fails for an unknown destination', async () => {
			await expect(service.deleteDestination(ID_A, user)).rejects.toThrow(NotFoundError);
			expect(repository.deleteDestination).not.toHaveBeenCalled();
		});
	});

	describe('testDestination', () => {
		it('sends the test event with a new destination, and closes it after', async () => {
			repository.findAllDestinations.mockResolvedValue([syslogRow(ID_A)]);

			await expect(service.testDestination(ID_A, user)).resolves.toBe(true);

			const [destination] = factory.create.mock.results.map(({ value }) => value);
			expect(destination.sendTest).toHaveBeenCalledWith(
				expect.objectContaining({ eventName: 'n8n.destination.test' }),
			);
			expect(destination.close).toHaveBeenCalled();
		});

		it('fails for an unknown destination', async () => {
			await expect(service.testDestination(ID_A, user)).rejects.toThrow(NotFoundError);
		});

		it('fails when the user cannot read the credential of the destination', async () => {
			repository.findAllDestinations.mockResolvedValue([
				{
					id: ID_A,
					destination: {
						__type: '$$MessageEventBusDestinationWebhook',
						url: 'https://example.com',
						authentication: 'genericCredentialType',
						genericAuthType: 'httpHeaderAuth',
						credentials: { httpHeaderAuth: { id: 'credential-1', name: 'Header' } },
					},
				},
			]);
			credentialsFinder.findCredentialForUser.mockResolvedValue(null);

			await expect(service.testDestination(ID_A, user)).rejects.toThrow(ForbiddenError);
			expect(factory.create).not.toHaveBeenCalled();
		});
	});

	it('does not fail a change when the other instances cannot be told', async () => {
		publisher.publishCommand.mockRejectedValue(new Error('Redis is down'));

		await expect(
			service.saveDestination({ __type: '$$MessageEventBusDestinationSyslog', host: 'logs' }, user),
		).resolves.toBeDefined();
	});

	it('stops listening and closes the destinations on shutdown', async () => {
		repository.findAllDestinations.mockResolvedValue([syslogRow(ID_A)]);
		await service.init();
		const [destination] = factory.create.mock.results.map(({ value }) => value);

		await service.shutdown();

		expect(eventBus.off).toHaveBeenCalledWith('message', expect.any(Function));
		expect(destination.close).toHaveBeenCalled();
	});
});
