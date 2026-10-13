import { EventService } from '@n8n/backend-services';
import { ProjectRepository, SharedCredentialsRepository, SharedWorkflowRepository } from '@n8n/db';
import type { Project } from '@n8n/db';
import { Service } from '@n8n/di';
import { LruCache } from '@n8n/utils/lru-cache';

import type { RelayEventMap } from '@/events/maps/relay.event-map';

import type { AuditLogEventRow } from './database/audit-log-event.repository';

/** The length of the id columns of the table. */
const MAX_ID_LENGTH = 36;

/** How many workflows and credentials, and how many projects, the service remembers. */
const CACHE_SIZE = 10_000;

const idIn = (value: unknown) =>
	typeof value === 'string' && value && value.length <= MAX_ID_LENGTH ? value : undefined;

type Resource = { kind: 'workflow' | 'credential'; id: string };

/** The workflow or credential that the payload of an event names. */
function resourceOf({ payload }: AuditLogEventRow): Resource | undefined {
	const workflowId = idIn(payload.workflowId);
	if (workflowId) return { kind: 'workflow', id: workflowId };
	const credentialId = idIn(payload.credentialId);
	if (credentialId) return { kind: 'credential', id: credentialId };
	return undefined;
}

const cacheKey = ({ kind, id }: Resource) => `${kind}:${id}`;

/**
 * Finds the project of each audit event before the module stores it: the project that the payload
 * names, else the home project of the workflow or credential that the payload names. The database
 * gives the home project. A deleted workflow or credential has none, so the service remembers the
 * last home project that it saw, and the project that the events `workflow-deleted` and
 * `credentials-deleted` name.
 */
@Service()
export class AuditLogProjectsService {
	/** The last known home project of workflows and credentials, by `kind:id`. */
	private readonly homeProjects = new LruCache<string, string>(CACHE_SIZE);

	/** The type of each project. A project keeps its type. */
	private readonly projectTypes = new LruCache<string, string>(CACHE_SIZE);

	private readonly onWorkflowDeleted = ({
		workflowId,
		projectId,
	}: RelayEventMap['workflow-deleted']) => this.remember('workflow', workflowId, projectId);

	private readonly onCredentialsDeleted = ({
		credentialId,
		projectId,
	}: RelayEventMap['credentials-deleted']) => this.remember('credential', credentialId, projectId);

	constructor(
		private readonly eventService: EventService,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly sharedCredentialsRepository: SharedCredentialsRepository,
		private readonly projectRepository: ProjectRepository,
	) {}

	/**
	 * The event service sends these events before the event bus sends the audit events, so the
	 * project of a deleted workflow or credential is known when the module stores them.
	 */
	init() {
		this.eventService.on('workflow-deleted', this.onWorkflowDeleted);
		this.eventService.on('credentials-deleted', this.onCredentialsDeleted);
	}

	shutdown() {
		this.eventService.off('workflow-deleted', this.onWorkflowDeleted);
		this.eventService.off('credentials-deleted', this.onCredentialsDeleted);
	}

	/** Sets `projectId` and `projectType` of the rows that have no project yet, where it can. */
	async addProjects(rows: AuditLogEventRow[]) {
		await this.addHomeProjects(rows.filter((row) => !row.projectId));
		await this.addProjectTypes(rows.filter((row) => row.projectId && !row.projectType));
	}

	private async addHomeProjects(rows: AuditLogEventRow[]) {
		const resources = new Map<AuditLogEventRow, Resource>();
		for (const row of rows) {
			const resource = resourceOf(row);
			if (resource) resources.set(row, resource);
		}
		if (resources.size === 0) return;

		const idsOf = (kind: Resource['kind']) => [
			...new Set([...resources.values()].filter((r) => r.kind === kind).map((r) => r.id)),
		];
		const [workflowProjects, credentialProjects] = await Promise.all([
			this.findOwnerProjects(
				idsOf('workflow'),
				async (ids) => await this.sharedWorkflowRepository.findOwnerProjectsByWorkflowIds(ids),
			),
			this.findOwnerProjects(
				idsOf('credential'),
				async (ids) => await this.sharedCredentialsRepository.findOwnerProjectsByCredentialIds(ids),
			),
		]);

		for (const [row, resource] of resources) {
			const found = (resource.kind === 'workflow' ? workflowProjects : credentialProjects).get(
				resource.id,
			);
			if (found) {
				this.remember(resource.kind, resource.id, found.id);
				this.projectTypes.set(found.id, found.type);
				row.projectId = found.id;
				row.projectType = found.type;
			} else {
				row.projectId = this.homeProjects.get(cacheKey(resource)) ?? null;
			}
		}
	}

	private async addProjectTypes(rows: AuditLogEventRow[]) {
		const unknownIds = new Set<string>();
		for (const row of rows) {
			if (row.projectId && !this.projectTypes.get(row.projectId)) unknownIds.add(row.projectId);
		}
		if (unknownIds.size > 0) {
			for (const { id, type } of await this.projectRepository.findTypesByIds([...unknownIds])) {
				this.projectTypes.set(id, type);
			}
		}

		for (const row of rows) {
			if (row.projectId) row.projectType = this.projectTypes.get(row.projectId) ?? null;
		}
	}

	private async findOwnerProjects(
		ids: string[],
		find: (ids: string[]) => Promise<Map<string, Project>>,
	): Promise<Map<string, Project>> {
		return ids.length > 0 ? await find(ids) : new Map();
	}

	private remember(kind: Resource['kind'], id: string, projectId: string | undefined) {
		const knownProjectId = idIn(projectId);
		if (knownProjectId) this.homeProjects.set(cacheKey({ kind, id }), knownProjectId);
	}
}
