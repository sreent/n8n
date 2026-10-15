import type { CreateProjectDto, UpdateProjectDto } from '@n8n/api-types';
import { LicenseState, ModuleRegistry } from '@n8n/backend-common';
import { EventService, RoleService } from '@n8n/backend-services';
import type { EntityManager, User } from '@n8n/db';
import {
	FolderRepository,
	GLOBAL_ADMIN_ROLE,
	GLOBAL_OWNER_ROLE,
	Project,
	ProjectIdConflictError,
	ProjectRelation,
	ProjectRelationRepository,
	ProjectRepository,
	RoleRepository,
	SharedCredentialsRepository,
	SharedWorkflowRepository,
	TeamProjectRepository,
	UserRepository,
} from '@n8n/db';
import { Container, Service } from '@n8n/di';
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	UserError,
} from '@n8n/errors';
import type { ProjectRole, Scope } from '@n8n/permissions';
import {
	PROJECT_OWNER_ROLE_SLUG,
	combineScopes,
	getAuthPrincipalScopes,
	hasGlobalScope,
} from '@n8n/permissions';

import { CredentialConnectionStatusProxy } from '@/credentials/credential-connection-status-proxy';
import type { ProjectRequest } from '@/requests';
import { OwnershipService } from '@/services/ownership.service';
import { OwnershipTransferHandlerRegistry } from '@/services/ownership-transfer/ownership-transfer-handler.registry';

export class ProjectNotFoundError extends NotFoundError {
	constructor(readonly projectId: string) {
		super(`Could not find project with ID: ${projectId}`);
	}
}

export class TeamProjectOverQuotaError extends UserError {
	constructor(limit: number) {
		super(
			`Attempted to create a new project but quota is already exhausted. You may have a maximum of ${limit} team projects.`,
		);
	}
}

export class UnlicensedProjectRoleError extends UserError {
	constructor(role: string) {
		super(`Your instance is not licensed to use role "${role}".`);
	}
}

/** A user and the slug of their role in a project. */
type MemberRelation = { userId: string; role: ProjectRole | string };

type ListOptions = {
	skip?: number;
	take?: number;
	search?: string;
	type?: 'personal' | 'team';
	activated?: boolean;
};

/** The global roles whose users reach every project without a relation. */
const INSTANCE_ROLES = [GLOBAL_OWNER_ROLE.slug, GLOBAL_ADMIN_ROLE.slug];

/**
 * The fork's project service (not the enterprise `project.service.ee.ts`). It lists, creates,
 * changes and deletes projects and their members. `packages/cli/src/services/FORK.md` describes
 * its behaviour and how the fork found it.
 */
@Service()
export class ProjectService {
	constructor(
		private readonly projectRepository: ProjectRepository,
		private readonly teamProjectRepository: TeamProjectRepository,
		private readonly projectRelationRepository: ProjectRelationRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly sharedCredentialsRepository: SharedCredentialsRepository,
		private readonly folderRepository: FolderRepository,
		private readonly userRepository: UserRepository,
		private readonly roleRepository: RoleRepository,
		private readonly roleService: RoleService,
		private readonly licenseState: LicenseState,
		private readonly eventService: EventService,
		private readonly moduleRegistry: ModuleRegistry,
		private readonly ownershipService: OwnershipService,
		private readonly transferHandlers: OwnershipTransferHandlerRegistry,
		private readonly connectionStatusProxy: CredentialConnectionStatusProxy,
	) {}

	// #region Scope checks

	/** The project, when the user holds all `scopes` globally or through their role in it. */
	async getProjectWithScope(
		user: User,
		projectId: string,
		scopes: Scope[],
		trx?: EntityManager,
	): Promise<Project | null> {
		const projects = trx?.getRepository(Project) ?? this.projectRepository;
		if (hasGlobalScope(user, scopes, { mode: 'allOf' })) {
			return await projects.findOneBy({ id: projectId });
		}

		const roles = await this.projectRolesWithScopes(scopes, trx);
		const relation = await (
			trx?.getRepository(ProjectRelation) ?? this.projectRelationRepository
		).findOne({
			where: { projectId, userId: user.id },
			relations: { role: true, project: true },
			loadEagerRelations: false,
		});
		return relation && roles.includes(relation.role.slug) ? relation.project : null;
	}

	/**
	 * The ids of the projects where the user holds all `scopes`, out of `projectIds` when given.
	 * A global role reaches every project. A project role reaches only team projects: callers add
	 * the personal project themselves.
	 */
	async getProjectIdsWithScope(
		user: User,
		scopes: Scope[],
		projectIds?: string[],
	): Promise<string[]> {
		if (projectIds?.length === 0) return [];
		if (hasGlobalScope(user, scopes, { mode: 'allOf' })) {
			const projects = projectIds
				? await this.projectRepository.findTypesByIds(projectIds)
				: await this.projectRepository.find({ select: { id: true } });
			return projects.map(({ id }) => id);
		}

		const roles = await this.projectRolesWithScopes(scopes);
		const relations = await this.projectRelationRepository.findAllByUser(user.id, {
			withProject: true,
		});
		return relations
			.filter(
				({ role, project }) =>
					roles.includes(role.slug) &&
					project.type === 'team' &&
					(!projectIds || projectIds.includes(project.id)),
			)
			.map(({ projectId }) => projectId);
	}

	/** The projects with these ids where the user holds all `scopes`, in the order of creation. */
	async findProjectsByIdsForUser(user: User, projectIds: string[], scopes: Scope[]) {
		const projects = (await this.projectRepository.find()).filter(({ id }) =>
			projectIds.includes(id),
		);
		if (hasGlobalScope(user, scopes, { mode: 'allOf' })) return projects;

		const roles = await this.projectRolesWithScopes(scopes);
		const relations = await this.projectRelationRepository.findAllByUser(user.id);
		const allowed = new Set(
			relations.filter(({ role }) => roles.includes(role.slug)).map(({ projectId }) => projectId),
		);
		return projects.filter(({ id }) => allowed.has(id));
	}

	/** The scopes of the user in a project: their global scopes and the scopes of their role in it. */
	async getProjectScopesForUser(user: User, projectId: string): Promise<Scope[]> {
		const relation = await this.projectRelationRepository.findOne({
			where: { projectId, userId: user.id },
			relations: { role: true },
		});
		return [
			...combineScopes({
				global: getAuthPrincipalScopes(user),
				...(relation && { project: relation.role.scopes.map(({ slug }) => slug) }),
			}),
		];
	}

	/** Add the role of the user in each project, or their global role, and their scopes there. */
	async addUserScopes<T extends Project>(user: User, projects: T[]) {
		const relations = await this.projectRelationRepository.findAllByUser(user.id);
		const globalScopes = getAuthPrincipalScopes(user);
		return projects.map((project) => {
			const relation = relations.find(({ projectId }) => projectId === project.id);
			return {
				...project,
				role: relation?.role.slug ?? user.role.slug,
				scopes: [
					...combineScopes({
						global: globalScopes,
						...(relation && { project: relation.role.scopes.map(({ slug }) => slug) }),
					}),
				],
			};
		});
	}

	// #endregion

	// #region Reading

	async getProject(projectId: string): Promise<Project> {
		return await this.projectRepository.findOneOrFail({ where: { id: projectId } });
	}

	async findProject(projectId: string): Promise<Project | null> {
		return await this.projectRepository.findOne({ where: { id: projectId } });
	}

	/** The ids out of `projectIds` that exist, without an access check. */
	async findExistingProjectIds(projectIds: string[]): Promise<Set<string>> {
		const projects = await this.projectRepository.findTypesByIds(projectIds);
		return new Set(projects.map(({ id }) => id));
	}

	async getPersonalProject(user: User): Promise<Project | null> {
		return await this.projectRepository.getPersonalProjectForUser(user.id);
	}

	/** Every relation of the user, with its project, its role and the scopes of the role. */
	async getProjectRelationsForUser(user: User): Promise<ProjectRelation[]> {
		return await this.projectRelationRepository.findAllByUser(user.id, { withProject: true });
	}

	async getProjectRelations(projectId: string): Promise<ProjectRelation[]> {
		return await this.projectRelationRepository.find({
			where: { projectId },
			relations: { user: true, role: true },
		});
	}

	async getProjectMembersAndCount(
		projectId: string,
		{ offset, limit }: { offset: number; limit: number },
	) {
		// The members in the order that they joined the project.
		const relations = await this.getProjectRelations(projectId);
		return { members: relations.slice(offset, offset + limit), count: relations.length };
	}

	async findUserIdsByProjectId(projectId: string): Promise<string[]> {
		return await this.projectRelationRepository.findUserIdsByProjectId(projectId);
	}

	/**
	 * The users who reach a team project through their global role and not through a relation:
	 * the enabled instance owners and admins.
	 */
	async getImplicitProjectMembers(project: Project): Promise<User[]> {
		if (project.type === 'personal') return [];
		return await this.userRepository.findEligibleByProjectOrGlobalRoles({
			projectId: project.id,
			projectRoleSlugs: [],
			globalRoleSlugs: INSTANCE_ROLES,
		});
	}

	/** The ids of the projects that a workflow is shared with or owned by. */
	async findProjectsWorkflowIsIn(workflowId: string): Promise<string[]> {
		const shares = await this.sharedWorkflowRepository.find({
			select: { projectId: true },
			where: { workflowId },
		});
		return shares.map(({ projectId }) => projectId);
	}

	/** Every project for a user with the global `project:read` scope, else the related ones. */
	async getAccessibleProjects(user: User): Promise<Project[]> {
		if (hasGlobalScope(user, 'project:read')) return await this.projectRepository.find();
		return await this.projectRepository.getAccessibleProjects(user.id);
	}

	async getAccessibleProjectsAndCount(user: User, options: ListOptions) {
		const [projects, count] = hasGlobalScope(user, 'project:read')
			? await this.projectRepository.findAllProjectsAndCount(options)
			: await this.projectRepository.getAccessibleProjectsAndCount(user.id, options);
		return { projects, count };
	}

	/** The projects that a user may share with: also the personal projects of other users. */
	async getShareableProjectsAndCount(user: User, options: ListOptions) {
		const [projects, count] = hasGlobalScope(user, 'project:read')
			? await this.projectRepository.findAllProjectsAndCount(options)
			: await this.projectRepository.getShareableProjectsAndCount(user.id, options);
		return { projects, count };
	}

	async getProjectsAndCount({ offset, limit }: { offset: number; limit: number }) {
		const [projects, count] = await this.projectRepository.findAndCount({
			skip: offset,
			take: limit,
		});
		return { projects, count };
	}

	async getProjectCounts() {
		return await this.projectRepository.getProjectCounts();
	}

	/**
	 * The projects of the user with their role and scopes. With the global `project:read` scope,
	 * also the other team projects, with the global role.
	 */
	async getMyProjects(user: User): Promise<ProjectRequest.GetMyProjectsResponse> {
		const relations = await this.projectRelationRepository.findAllByUser(user.id, {
			withProject: true,
		});
		const globalScopes = getAuthPrincipalScopes(user);
		const projects: ProjectRequest.GetMyProjectsResponse = relations.map(({ project, role }) =>
			Object.assign(project, {
				role: role.slug,
				scopes: [
					...combineScopes({ global: globalScopes, project: role.scopes.map(({ slug }) => slug) }),
				],
			}),
		);

		if (hasGlobalScope(user, 'project:read')) {
			const otherProjects = await this.projectRepository.findTeamProjectsExcluding(
				relations.map(({ projectId }) => projectId),
			);
			for (const project of otherProjects) {
				projects.push(
					Object.assign(project, {
						role: user.role.slug,
						scopes: [...combineScopes({ global: globalScopes })],
					}),
				);
			}
		}

		return projects;
	}

	// #endregion

	// #region Changing projects

	async createTeamProject(
		user: User,
		{ name, icon, uiContext }: Pick<CreateProjectDto, 'name' | 'icon' | 'uiContext'>,
		options: Partial<Pick<Project, 'id' | 'description' | 'customTelemetryTags'>> = {},
	): Promise<Project> {
		const limit = this.licenseState.getMaxTeamProjects();
		let project: Project | null;
		try {
			project = await this.projectRepository.insertTeamProjectWithAdmin(
				{ name, icon, ...options },
				user.id,
				limit,
			);
		} catch (error) {
			if (error instanceof ProjectIdConflictError) throw new ConflictError(error.message);
			throw error;
		}
		if (!project) throw new TeamProjectOverQuotaError(limit);

		this.eventService.emit('team-project-created', {
			userId: user.id,
			role: user.role.slug,
			uiContext,
		});
		return project;
	}

	/**
	 * Change the name, icon, description or custom telemetry tags of a team project. The keys of
	 * the tags are trimmed, unless `preserveCustomTelemetryTags` is set (a package import).
	 */
	async updateProject(
		user: User,
		projectId: string,
		data: UpdateProjectDto,
		{ preserveCustomTelemetryTags = false }: { preserveCustomTelemetryTags?: boolean } = {},
	): Promise<void> {
		await this.getTeamProject(projectId);

		const { customTelemetryTags, ...fields } = data;
		const changes: Partial<Project> = { ...fields };
		if (customTelemetryTags !== undefined) {
			changes.customTelemetryTags = preserveCustomTelemetryTags
				? customTelemetryTags
				: customTelemetryTags.map(({ key, value }) => ({ key: key.trim(), value }));
		}
		if (Object.keys(changes).length > 0) {
			await this.projectRepository.update({ id: projectId, type: 'team' }, changes);
		}
		this.eventService.emit('team-project-updated', {
			userId: user.id,
			role: user.role.slug,
			projectId,
			otelProjectCustomTagsCount: customTelemetryTags?.length,
		});
	}

	/**
	 * Delete a team project. Without `migrateToProject`, its workflows, credentials and module
	 * resources are deleted. With it, they move to that project.
	 */
	async deleteProject(
		user: User,
		projectId: string,
		{ migrateToProject }: { migrateToProject?: string } = {},
	): Promise<void> {
		if (projectId === migrateToProject) {
			throw new BadRequestError(
				'Request to delete a project failed because the project to delete and the project to migrate to are the same project',
			);
		}

		const project = await this.getProjectWithScope(user, projectId, ['project:delete']);
		if (!project) throw new ProjectNotFoundError(projectId);
		if (project.type !== 'team') {
			throw new ForbiddenError(
				`Can't delete project. Project with ID "${projectId}" is not a team project.`,
			);
		}

		let targetProject: Project | null = null;
		if (migrateToProject) {
			targetProject = await this.getProjectWithScope(user, migrateToProject, [
				'credential:create',
				'workflow:create',
				'dataTable:create',
			]);
			if (!targetProject) {
				// The message names the result of the lookup, which is null here.
				throw new NotFoundError(
					'Could not find project to migrate to. ID: null. You may lack permissions to create workflow, credentials or data tables in the target project.',
				);
			}
			if (targetProject.type === 'personal') await this.assertNoEndUserCredentials(projectId);
		}

		// These services depend on this one, so they are loaded at the time of use.
		const { OwnershipTransferService } = await import(
			'@/services/ownership-transfer/ownership-transfer.service.js'
		);
		const ownershipTransferService = Container.get(OwnershipTransferService);

		const memberIds = await this.findUserIdsByProjectId(projectId);

		if (targetProject) {
			await this.transferOwnedResources(projectId, targetProject.id);
		} else {
			await this.deleteOwnedResources(user, projectId);
			await ownershipTransferService.deleteModuleOwnedResources([projectId]);
		}

		await this.teamProjectRepository.deleteProject(projectId, {
			withSecretsProviderConnections: this.moduleRegistry.isActive('external-secrets'),
		});
		// The members lose the access that the project gave them, and with it their connections to
		// private credentials.
		await this.connectionStatusProxy.cleanupOrphanedEntriesForUsers(memberIds);

		this.eventService.emit('team-project-deleted', {
			userId: user.id,
			role: user.role.slug,
			projectId,
			removalType: targetProject ? 'transfer' : 'delete',
			targetProjectId: targetProject?.id,
		});
	}

	// #endregion

	// #region Changing members

	/** Add a user to a project, or change their role in it. No checks: callers check first. */
	async addUser(projectId: string, { userId, role }: MemberRelation, trx?: EntityManager) {
		const relations = trx?.getRepository(ProjectRelation) ?? this.projectRelationRepository;
		return await relations.save({ projectId, userId, role: { slug: role } });
	}

	/**
	 * Add users to a team project, or change their role in it. Instance owners and admins are
	 * left out: they reach every project through their global role.
	 */
	async addUsersToProject(user: User, projectId: string, relations: MemberRelation[]) {
		const project = await this.getTeamProject(projectId, { withRelations: true });
		await this.assertAssignableRoles(relations);
		if (relations.some(({ role }) => role === PROJECT_OWNER_ROLE_SLUG)) {
			throw new ForbiddenError("Can't add a personalOwner to a team project.");
		}
		this.assertLicensedRoles(project, relations);

		const added = await this.withoutInstanceUsers(relations);
		if (added.length > 0) {
			await this.projectRelationRepository.save(
				added.map(({ userId, role }) => ({ projectId, userId, role: { slug: role } })),
			);
		}
		// A member with a new role can lose access to private credentials of the project.
		const changedUserIds = added
			.filter(({ userId, role }) =>
				project.projectRelations.some(
					(relation) => relation.userId === userId && relation.role.slug !== role,
				),
			)
			.map(({ userId }) => userId);
		await this.connectionStatusProxy.cleanupOrphanedEntriesForUsers(changedUserIds);
		await this.emitMembersUpdated(user, projectId);
	}

	/**
	 * Add users to a team project. A user who is a member already keeps their role: with another
	 * role in the request, they are a conflict.
	 */
	async addUsersWithConflictSemantics(user: User, projectId: string, relations: MemberRelation[]) {
		const project = await this.getTeamProject(projectId, { withRelations: true });
		await this.assertAssignableRoles(relations);
		this.assertLicensedRoles(project, relations);

		const added: MemberRelation[] = [];
		const conflicts: Array<{ userId: string; currentRole: string; requestedRole: string }> = [];
		for (const relation of await this.withoutInstanceUsers(relations)) {
			const current = project.projectRelations.find(({ userId }) => userId === relation.userId);
			if (!current) added.push(relation);
			else if (current.role.slug !== relation.role) {
				conflicts.push({
					userId: relation.userId,
					currentRole: current.role.slug,
					requestedRole: relation.role,
				});
			}
		}
		if (added.length > 0) {
			await this.projectRelationRepository.insert(
				added.map(({ userId, role }) => ({ projectId, userId, role: { slug: role } })),
			);
		}
		await this.emitMembersUpdated(user, projectId);
		return { project, added, conflicts };
	}

	/** Replace all members of a team project. */
	async syncProjectRelations(projectId: string, relations: MemberRelation[]) {
		const project = await this.getTeamProject(projectId, { withRelations: true });
		await this.assertAssignableRoles(relations);
		this.assertLicensedRoles(project, relations);

		await this.teamProjectRepository.replaceRelations(projectId, relations);
		const newRelations = relations.filter(
			({ userId }) => !project.projectRelations.some((relation) => relation.userId === userId),
		);
		return { project, newRelations };
	}

	async changeUserRoleInProject(user: User, projectId: string, userId: string, role: string) {
		if (role === PROJECT_OWNER_ROLE_SLUG) {
			throw new ForbiddenError('Personal owner cannot be added to a team project.');
		}
		await this.getTeamProject(projectId);
		await this.roleService.checkRolesExist([role], 'project');
		if (await this.isInstanceUser(userId)) {
			throw new ForbiddenError(
				"This user has access through their instance role. Project roles can't change their access in this project.",
			);
		}

		const relation = await this.projectRelationRepository.findOne({
			where: { projectId, userId },
			relations: { role: true },
			loadEagerRelations: false,
		});
		if (!relation) throw new ProjectNotFoundError(projectId);
		// A role that does not change needs no licence.
		if (relation.role.slug !== role) this.assertLicensedRole(role);

		await this.projectRelationRepository.update({ projectId, userId }, { role: { slug: role } });
		// The new role can lack access to private credentials, and with it to their connections.
		await this.connectionStatusProxy.cleanupOrphanedEntriesForUsers([userId]);
		await this.emitMembersUpdated(user, projectId);
	}

	async deleteUserFromProject(user: User, projectId: string, userId: string) {
		await this.getTeamProject(projectId);
		if (await this.isInstanceUser(userId)) {
			throw new ForbiddenError(
				"This user has access through their instance role and can't be removed from the project.",
			);
		}

		const relation = await this.projectRelationRepository.findOne({
			where: { projectId, userId },
			relations: { role: true },
			loadEagerRelations: false,
		});
		if (relation?.role.slug === PROJECT_OWNER_ROLE_SLUG) {
			throw new ForbiddenError('Project owner cannot be removed from the project');
		}

		await this.projectRelationRepository.delete({ projectId, userId });
		await this.connectionStatusProxy.cleanupOrphanedEntriesForUsers([userId]);
		await this.emitMembersUpdated(user, projectId);
	}

	// #endregion

	// #region Helpers

	/** The team project, or a `ProjectNotFoundError` for a missing or personal project. */
	private async getTeamProject(projectId: string, { withRelations = false } = {}) {
		const project = await this.projectRepository.findOne({
			where: { id: projectId, type: 'team' },
			...(withRelations && { relations: { projectRelations: { role: true } } }),
		});
		if (!project) throw new ProjectNotFoundError(projectId);
		return project;
	}

	/** The slugs of the project roles that hold all `scopes`. */
	private async projectRolesWithScopes(scopes: Scope[], trx?: EntityManager) {
		return trx
			? await this.roleService.rolesWithScope(
					'project',
					scopes,
					async () => await this.roleRepository.findAll(trx),
				)
			: await this.roleService.rolesWithScope('project', scopes);
	}

	private async assertAssignableRoles(relations: MemberRelation[]) {
		await this.roleService.checkRolesExist(
			relations.map(({ role }) => role),
			'project',
		);
	}

	private assertLicensedRole(role: string) {
		if (!this.roleService.isRoleLicensed(role)) throw new UnlicensedProjectRoleError(role);
	}

	/** Every role must be licensed, except a role that the user has in the project already. */
	private assertLicensedRoles(project: Project, relations: MemberRelation[]) {
		for (const { userId, role } of relations) {
			const current = project.projectRelations.find((relation) => relation.userId === userId);
			if (current?.role.slug !== role) this.assertLicensedRole(role);
		}
	}

	/** Whether the user reaches every project through their global role. */
	private async isInstanceUser(userId: string) {
		const user = await this.userRepository.findByIdWithRole(userId);
		return user !== null && !user.disabled && INSTANCE_ROLES.includes(user.role.slug);
	}

	private async withoutInstanceUsers(relations: MemberRelation[]) {
		const instanceUserIds = await this.userRepository.findIdsWithGlobalOrProjectRoles({
			projectIds: [],
			projectRoleSlugs: [],
			globalRoleSlugs: INSTANCE_ROLES,
		});
		return relations.filter(({ userId }) => !instanceUserIds.includes(userId));
	}

	private async emitMembersUpdated(user: User, projectId: string) {
		const relations = await this.projectRelationRepository.find({
			where: { projectId },
			relations: { role: true },
			loadEagerRelations: false,
		});
		this.eventService.emit('team-project-updated', {
			userId: user.id,
			role: user.role.slug,
			members: relations.map(({ userId, role }) => ({ userId, role: role.slug })),
			projectId,
		});
	}

	/** End-user credentials resolve to the connection of each user, so a personal project can't own them. */
	private async assertNoEndUserCredentials(projectId: string) {
		const shares = await this.sharedCredentialsRepository.find({
			where: { projectId, role: 'credential:owner', credentials: { isResolvable: true } },
			relations: { credentials: true },
		});
		if (shares.length === 0) return;
		const names = shares.map(({ credentials }) => `"${credentials.name}"`).join(', ');
		throw new BadRequestError(
			`Can't migrate end-user credentials (${names}) to a personal project. Switch them back to fixed credentials, move them to another team project, or delete this project without migrating.`,
		);
	}

	/**
	 * Move what a project owns to another project, in one transaction: the workflows and
	 * credentials (a share with the target becomes ownership), the folders and the resources of
	 * modules. Shares with the project itself go with the project.
	 */
	private async transferOwnedResources(fromProjectId: string, toProjectId: string) {
		const workflows = await this.sharedWorkflowRepository.find({
			select: { workflowId: true },
			where: { projectId: fromProjectId, role: 'workflow:owner' },
		});
		const workflowIds = workflows.map(({ workflowId }) => workflowId);
		const credentials = await this.sharedCredentialsRepository.find({
			select: { credentialsId: true },
			where: { projectId: fromProjectId, role: 'credential:owner' },
		});

		await this.projectRepository.runInTransaction({}, async (trx) => {
			await this.sharedWorkflowRepository.makeOwner(workflowIds, toProjectId, trx);
			await this.sharedCredentialsRepository.makeOwner(
				credentials.map(({ credentialsId }) => credentialsId),
				toProjectId,
				trx,
			);
			await this.folderRepository.transferAllFoldersToProject(fromProjectId, toProjectId, trx);
			for (const handler of this.transferHandlers.getAll()) {
				await handler.transferAll(fromProjectId, toProjectId, trx);
			}
		});

		// The workflows have a new owner project, so their cached owner is stale.
		await this.ownershipService.invalidateWorkflowProjectCacheByIds(workflowIds);
	}

	/** Delete the workflows and credentials that a project owns, through their services. */
	private async deleteOwnedResources(user: User, projectId: string) {
		const { WorkflowService } = await import('@/workflows/workflow.service.js');
		const { CredentialsService } = await import('@/credentials/credentials.service.js');

		const workflows = await this.sharedWorkflowRepository.find({
			select: { workflowId: true },
			where: { projectId, role: 'workflow:owner' },
		});
		for (const { workflowId } of workflows) {
			await Container.get(WorkflowService).delete(user, workflowId, true);
		}

		const credentials = await this.sharedCredentialsRepository.find({
			select: { credentialsId: true },
			where: { projectId, role: 'credential:owner' },
		});
		for (const { credentialsId } of credentials) {
			await Container.get(CredentialsService).delete(user, credentialsId);
		}
	}

	// #endregion
}
