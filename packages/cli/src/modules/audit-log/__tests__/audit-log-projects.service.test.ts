import { EventService } from '@n8n/backend-services';
import type {
	Project,
	ProjectRepository,
	SharedCredentialsRepository,
	SharedWorkflowRepository,
} from '@n8n/db';
import { mock } from 'vitest-mock-extended';

import { AuditLogProjectsService } from '../audit-log-projects.service';
import type { AuditLogEventRow } from '../database/audit-log-event.repository';

const project = (id: string, type: 'personal' | 'team') => mock<Project>({ id, type });

const row = (
	payload: AuditLogEventRow['payload'],
	projectId: string | null = null,
	projectType: string | null = null,
): AuditLogEventRow => ({
	id: 'event-1',
	eventName: 'n8n.audit.workflow.updated',
	timestamp: new Date('2026-10-13T08:00:00.000Z'),
	userId: null,
	userEmail: null,
	projectId,
	projectType,
	payload,
});

describe('AuditLogProjectsService', () => {
	let eventService: EventService;
	let sharedWorkflowRepository: ReturnType<typeof mock<SharedWorkflowRepository>>;
	let sharedCredentialsRepository: ReturnType<typeof mock<SharedCredentialsRepository>>;
	let projectRepository: ReturnType<typeof mock<ProjectRepository>>;
	let service: AuditLogProjectsService;

	beforeEach(() => {
		eventService = new EventService();
		sharedWorkflowRepository = mock<SharedWorkflowRepository>();
		sharedCredentialsRepository = mock<SharedCredentialsRepository>();
		projectRepository = mock<ProjectRepository>();
		sharedWorkflowRepository.findOwnerProjectsByWorkflowIds.mockResolvedValue(new Map());
		sharedCredentialsRepository.findOwnerProjectsByCredentialIds.mockResolvedValue(new Map());
		projectRepository.findTypesByIds.mockResolvedValue([]);
		service = new AuditLogProjectsService(
			eventService,
			sharedWorkflowRepository,
			sharedCredentialsRepository,
			projectRepository,
		);
		service.init();
	});

	afterEach(() => service.shutdown());

	it('gives the home project of the workflow or credential that the payload names', async () => {
		sharedWorkflowRepository.findOwnerProjectsByWorkflowIds.mockResolvedValue(
			new Map([['wf-1', project('personal-1', 'personal')]]),
		);
		sharedCredentialsRepository.findOwnerProjectsByCredentialIds.mockResolvedValue(
			new Map([['cred-1', project('team-1', 'team')]]),
		);
		const rows = [row({ workflowId: 'wf-1' }), row({ credentialId: 'cred-1' }), row({})];

		await service.addProjects(rows);

		expect(rows.map((r) => [r.projectId, r.projectType])).toEqual([
			['personal-1', 'personal'],
			['team-1', 'team'],
			[null, null],
		]);
		expect(sharedWorkflowRepository.findOwnerProjectsByWorkflowIds).toHaveBeenCalledWith(['wf-1']);
		expect(sharedCredentialsRepository.findOwnerProjectsByCredentialIds).toHaveBeenCalledWith([
			'cred-1',
		]);
		expect(projectRepository.findTypesByIds).not.toHaveBeenCalled();
	});

	it('keeps the project of the payload, and finds its type once', async () => {
		projectRepository.findTypesByIds.mockResolvedValue([{ id: 'team-1', type: 'team' }]);
		const first = [row({ workflowId: 'wf-1' }, 'team-1'), row({}, 'team-1')];
		const second = [row({}, 'team-1')];

		await service.addProjects(first);
		await service.addProjects(second);

		expect([...first, ...second].map((r) => [r.projectId, r.projectType])).toEqual([
			['team-1', 'team'],
			['team-1', 'team'],
			['team-1', 'team'],
		]);
		expect(sharedWorkflowRepository.findOwnerProjectsByWorkflowIds).not.toHaveBeenCalled();
		expect(projectRepository.findTypesByIds).toHaveBeenCalledTimes(1);
		expect(projectRepository.findTypesByIds).toHaveBeenCalledWith(['team-1']);
	});

	it('keeps the type that the payload gives', async () => {
		const rows = [row({}, 'personal-1', 'personal')];
		await service.addProjects(rows);

		expect(rows[0].projectType).toBe('personal');
		expect(projectRepository.findTypesByIds).not.toHaveBeenCalled();
	});

	it('gives the last known home project of a workflow that the database no longer has', async () => {
		sharedWorkflowRepository.findOwnerProjectsByWorkflowIds.mockResolvedValueOnce(
			new Map([['wf-1', project('team-1', 'team')]]),
		);
		await service.addProjects([row({ workflowId: 'wf-1' })]);

		const afterDelete = [row({ workflowId: 'wf-1' })];
		await service.addProjects(afterDelete);

		expect([afterDelete[0].projectId, afterDelete[0].projectType]).toEqual(['team-1', 'team']);
	});

	it('remembers the project of the events workflow-deleted and credentials-deleted', async () => {
		projectRepository.findTypesByIds.mockResolvedValue([{ id: 'team-1', type: 'team' }]);
		eventService.emit('workflow-deleted', {
			user: { id: 'user-1' },
			workflowId: 'wf-1',
			workflowName: 'Old report',
			projectId: 'team-1',
			publicApi: false,
		});
		eventService.emit('credentials-deleted', {
			user: { id: 'user-1' },
			credentialType: 'slackApi',
			credentialId: 'cred-1',
			credentialName: 'Old Slack',
			projectId: 'team-1',
		});
		const rows = [row({ workflowId: 'wf-1' }), row({ credentialId: 'cred-1' })];

		await service.addProjects(rows);

		expect(rows.map((r) => [r.projectId, r.projectType])).toEqual([
			['team-1', 'team'],
			['team-1', 'team'],
		]);
	});

	it('stops listening on shutdown', async () => {
		service.shutdown();
		eventService.emit('workflow-deleted', {
			user: { id: 'user-1' },
			workflowId: 'wf-1',
			workflowName: 'Old report',
			projectId: 'team-1',
			publicApi: false,
		});
		const rows = [row({ workflowId: 'wf-1' })];

		await service.addProjects(rows);

		expect(rows[0].projectId).toBeNull();
	});

	it('leaves out ids that do not fit the columns', async () => {
		const rows = [row({ workflowId: 'w'.repeat(37) }), row({ workflowId: 7 })];
		await service.addProjects(rows);

		expect(sharedWorkflowRepository.findOwnerProjectsByWorkflowIds).not.toHaveBeenCalled();
		expect(rows.map((r) => r.projectId)).toEqual([null, null]);
	});
});
