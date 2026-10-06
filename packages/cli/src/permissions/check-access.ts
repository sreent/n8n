import { RoleService } from '@n8n/backend-services';
import type { EntityManager, User } from '@n8n/db';
import {
	CredentialsEntity,
	CredentialsRepository,
	ProjectRelation,
	ProjectRelationRepository,
	RoleRepository,
	SharedCredentials,
	SharedCredentialsRepository,
	SharedWorkflow,
	SharedWorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { NotFoundError } from '@n8n/errors';
import type { RoleNamespace, Scope } from '@n8n/permissions';
import { hasGlobalScope } from '@n8n/permissions';
import { UnexpectedError } from 'n8n-workflow';

import { DataTable } from '@/modules/data-table/data-table.entity';
import { DataTableRepository } from '@/modules/data-table/data-table.repository';

/** The resource of a scope check. The controller registries pass the route params. */
export type ScopeCheckResource = {
	projectId?: string;
	workflowId?: string;
	credentialId?: string;
	dataTableId?: string;
};

/** The scopes that `credential:manageInstance` gives on an instance credential. */
const INSTANCE_CREDENTIAL_SCOPES: readonly Scope[] = [
	'credential:read',
	'credential:update',
	'credential:delete',
	'credential:manageInstance',
];

/**
 * Check if a user holds all `scopes` for a resource.
 *
 * - A user whose global role holds all the scopes passes for every resource.
 * - With `globalOnly`, only the global role counts.
 * - Otherwise one id names the resource. When several ids are given, the first of credential,
 *   workflow, data table and project counts. A missing data table, and a credential or workflow
 *   without shares, throw a `NotFoundError`.
 * - A user whose global role holds `credential:manageInstance` may read, update and delete an
 *   instance credential.
 * - The user passes when one of their project roles holds all the scopes, in a project that owns
 *   the resource or that it is shared with. For a shared credential or workflow, the role of the
 *   share must also hold all the scopes.
 *
 * Give `trx` to read inside a running transaction.
 */
export async function userHasScopes(
	user: User,
	scopes: Scope[],
	globalOnly: boolean,
	{ projectId, workflowId, credentialId, dataTableId }: ScopeCheckResource,
	trx?: EntityManager,
): Promise<boolean> {
	if (hasGlobalScope(user, scopes, { mode: 'allOf' })) return true;
	if (globalOnly) return false;

	const repositories = {
		credentials: trx?.getRepository(CredentialsEntity) ?? Container.get(CredentialsRepository),
		dataTables: trx?.getRepository(DataTable) ?? Container.get(DataTableRepository),
		projectRelations:
			trx?.getRepository(ProjectRelation) ?? Container.get(ProjectRelationRepository),
		sharedCredentials:
			trx?.getRepository(SharedCredentials) ?? Container.get(SharedCredentialsRepository),
		sharedWorkflows: trx?.getRepository(SharedWorkflow) ?? Container.get(SharedWorkflowRepository),
	};

	const roleService = Container.get(RoleService);
	const loadRoles = trx ? async () => await Container.get(RoleRepository).findAll(trx) : undefined;
	const rolesWithScopes = async (namespace: RoleNamespace): Promise<string[]> =>
		loadRoles
			? await roleService.rolesWithScope(namespace, scopes, loadRoles)
			: await roleService.rolesWithScope(namespace, scopes);

	/** Whether the role of the user in a project holds all the scopes. */
	const holdsScopesInProject = async (projectId: string, projectRoles: string[]) => {
		const relation = await repositories.projectRelations.findOne({
			where: { userId: user.id, projectId },
			relations: { role: true },
		});
		return relation !== null && projectRoles.includes(relation.role.slug);
	};

	/**
	 * Whether the user manages an instance credential: their global role holds
	 * `credential:manageInstance`, and every scope is one that this role gives on instance
	 * credentials. Shares do not count here.
	 */
	const managesInstanceCredential = async (credentialId: string) => {
		if (!hasGlobalScope(user, 'credential:manageInstance')) return false;
		if (!scopes.every((scope) => INSTANCE_CREDENTIAL_SCOPES.includes(scope))) return false;
		const credential = await repositories.credentials.findOne({
			where: { id: credentialId },
			select: { id: true, usageScope: true },
		});
		return credential?.usageScope === 'instance';
	};

	/** Whether a share of the resource gives the user all the scopes. */
	const holdsScopesThroughShares = async (
		shares: Array<{ projectId: string; role: string }>,
		namespace: 'credential' | 'workflow',
	) => {
		const [projectRoles, shareRoles] = await Promise.all([
			rolesWithScopes('project'),
			rolesWithScopes(namespace),
		]);
		for (const share of shares) {
			if (!shareRoles.includes(share.role)) continue;
			if (await holdsScopesInProject(share.projectId, projectRoles)) return true;
		}
		return false;
	};

	// A credential or workflow without shares is not found, also when its row exists.
	if (credentialId) {
		if (await managesInstanceCredential(credentialId)) return true;
		const shares = await repositories.sharedCredentials.findBy({ credentialsId: credentialId });
		if (shares.length === 0)
			throw new NotFoundError(`Credential with ID "${credentialId}" not found.`);
		return await holdsScopesThroughShares(shares, 'credential');
	}

	if (workflowId) {
		const shares = await repositories.sharedWorkflows.findBy({ workflowId });
		if (shares.length === 0) throw new NotFoundError(`Workflow with ID "${workflowId}" not found.`);
		return await holdsScopesThroughShares(shares, 'workflow');
	}

	if (dataTableId) {
		const dataTable = await repositories.dataTables.findOne({
			where: { id: dataTableId },
			select: { id: true, projectId: true },
		});
		if (!dataTable) throw new NotFoundError(`Data table with ID "${dataTableId}" not found.`);
		// A data table belongs to one project. Its project decides.
		return await holdsScopesInProject(dataTable.projectId, await rolesWithScopes('project'));
	}

	if (projectId) {
		return await holdsScopesInProject(projectId, await rolesWithScopes('project'));
	}

	throw new UnexpectedError(
		'A project-scoped route needs a `credentialId`, `workflowId`, `dataTableId` or `projectId` URL parameter. Use a global scope for routes without one.',
	);
}
