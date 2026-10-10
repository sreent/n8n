// Fork module (not in upstream n8n): the role provisioning of SSO, in place of the enterprise
// `provisioning.service.ee.ts`. The class keeps its name, the methods that ordinary code calls
// (`init`, `getConfig`, `loadConfig`, `handleReloadSsoProvisioningConfiguration`,
// `isInstanceRoleManaged` and `isProjectRoleManaged`) and the field `provisioningConfig`, which
// ordinary tests change. packages/cli/src/modules/provisioning/FORK.md describes it.
import {
	BLOCK_ACCESS_ASSIGNMENT,
	ProvisioningConfigDto,
	type ProvisioningConfigPatchDto,
} from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { EventService } from '@n8n/backend-services';
import { GlobalConfig } from '@n8n/config';
import { ProjectRelationRepository, RoleRepository, SettingsRepository, type User } from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { BadRequestError } from '@n8n/errors';
import { InstanceSettings } from 'n8n-core';
import { Expression, type IDataObject } from 'n8n-workflow';

import { Publisher } from '@/scaling/pubsub/publisher.service';
import { UserService } from '@/services/user.service';

import { PROVISIONING_PREFERENCES_DB_KEY } from './constants';
import type { RuleType } from './database/provisioning-rule.repository';
import { ProvisioningRuleRepository } from './database/provisioning-rule.repository';
import { SsoAccessDeniedError } from './errors/sso-access-denied.error';

type ConfigKey = Exclude<keyof ProvisioningConfigPatchDto, 'deleteProjectRules'>;

/** The values that an expression of a rule can read. */
export type RuleExpressionContext = {
	$claims: IDataObject;
	$oidc?: { idToken: IDataObject; userInfo: IDataObject };
	$saml?: { attributes: IDataObject };
	$provider: 'oidc' | 'saml';
};

/** What an SSO sign-in brings for the roles of the user. */
export interface SsoLoginClaims {
	provider: 'oidc' | 'saml';
	/** The claims that the direct-claim provisioning reads. */
	claims: Record<string, unknown>;
	/** The values of the rule expressions. */
	context: RuleExpressionContext;
}

interface ResolvedProjectRole {
	projectId: string;
	role: string;
	ruleId: string;
	expression: string;
}

/** The roles of a sign-in, before n8n knows or creates the user. */
export type ResolvedSsoRoles =
	| { mode: 'none' }
	| {
			mode: 'claims';
			instanceRole: string | undefined;
			projectRoles: Map<string, string> | undefined;
	  }
	| {
			mode: 'expressions';
			provider: 'oidc' | 'saml';
			hasInstanceRules: boolean;
			hasProjectRules: boolean;
			instanceRole: {
				role: string;
				matchedRuleId: string | null;
				expression: string | null;
				isFallback: boolean;
			};
			projectRoles: ResolvedProjectRole[];
	  };

const CONFIG_KEYS: ConfigKey[] = [
	'scopesProvisionInstanceRole',
	'scopesProvisionProjectRoles',
	'scopesName',
	'scopesInstanceRoleClaimName',
	'scopesProjectsRolesClaimName',
	'scopesUseExpressionMapping',
	'defaultInstanceRole',
];

const GLOBAL_OWNER = 'global:owner';
const GLOBAL_MEMBER = 'global:member';

/** Whether a config lets n8n set project roles, by claims or by rules. */
const setsProjectRoles = (config: ProvisioningConfigDto) =>
	config.scopesProvisionProjectRoles || config.scopesUseExpressionMapping;

/**
 * Whether the expression of a rule matches. A template gives `true`, or the text `true`. An
 * expression that does not evaluate does not match.
 */
function expressionMatches(expression: string, context: RuleExpressionContext) {
	try {
		const result: unknown = Expression.resolveWithoutWorkflow(expression, context);
		return result === true || result === 'true';
	} catch {
		return false;
	}
}

@Service()
export class ProvisioningService {
	/** The config in memory. The first read loads it. */
	private provisioningConfig: ProvisioningConfigDto | undefined;

	constructor(
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
		private readonly settingsRepository: SettingsRepository,
		private readonly roleRepository: RoleRepository,
		private readonly projectRelationRepository: ProjectRelationRepository,
		private readonly rules: ProvisioningRuleRepository,
		private readonly userService: UserService,
		private readonly eventService: EventService,
		private readonly publisher: Publisher,
		private readonly instanceSettings: InstanceSettings,
	) {}

	async init() {
		this.provisioningConfig = await this.loadConfig();
	}

	async getConfig(): Promise<ProvisioningConfigDto> {
		this.provisioningConfig ??= await this.loadConfig();
		return this.provisioningConfig;
	}

	/**
	 * The stored config. Without a row, and with a row that is not a full config, the values of
	 * the environment.
	 */
	async loadConfig(): Promise<ProvisioningConfigDto> {
		const row = await this.settingsRepository.findByKey(PROVISIONING_PREFERENCES_DB_KEY);
		if (row) {
			try {
				const parsed = ProvisioningConfigDto.safeParse(JSON.parse(row.value));
				if (parsed.success) return parsed.data;
			} catch (error) {
				this.logger.warn('The stored provisioning config is not JSON', { error });
			}
		}
		const { provisioning } = this.globalConfig.sso;
		return {
			scopesProvisionInstanceRole: provisioning.scopesProvisionInstanceRole,
			scopesProvisionProjectRoles: provisioning.scopesProvisionProjectRoles,
			scopesName: provisioning.scopesName,
			scopesInstanceRoleClaimName: provisioning.scopesInstanceRoleClaimName,
			scopesProjectsRolesClaimName: provisioning.scopesProjectsRolesClaimName,
			scopesUseExpressionMapping: provisioning.scopesUseExpressionMapping,
		};
	}

	/**
	 * Change the config: the keys of the patch replace the keys of the config in memory, and `null`
	 * removes a key. When the new config sets no project roles where the old one did, or with
	 * `deleteProjectRules`, the project rules go.
	 */
	async patchConfig(patch: ProvisioningConfigPatchDto): Promise<ProvisioningConfigDto> {
		const current = await this.getConfig();
		const merged: Record<string, unknown> = { ...current };
		for (const key of CONFIG_KEYS) {
			const value = patch[key];
			if (value === null) delete merged[key];
			else if (value !== undefined) merged[key] = value;
		}
		if (
			merged.scopesUseExpressionMapping === true &&
			(merged.scopesProvisionInstanceRole === true || merged.scopesProvisionProjectRoles === true)
		) {
			throw new BadRequestError(
				'Expression-based mapping and direct-claim provisioning cannot both be enabled at the same time.',
			);
		}
		if (typeof merged.defaultInstanceRole === 'string') {
			await this.assertValidDefaultRole(merged.defaultInstanceRole);
		}
		const config = ProvisioningConfigDto.parse(merged);

		await this.settingsRepository.upsert(
			{
				key: PROVISIONING_PREFERENCES_DB_KEY,
				value: JSON.stringify(config),
				loadOnStartup: true,
			},
			{ conflictPaths: ['key'] },
		);
		this.provisioningConfig = config;

		if (
			patch.deleteProjectRules === true ||
			(setsProjectRoles(current) && !setsProjectRoles(config))
		) {
			const count = await this.rules.deleteByType({}, 'project');
			this.eventService.emit('role-mapping-rules-bulk-deleted', {
				ruleType: 'project',
				count,
				reason: 'strategy-switch',
			});
		}
		if (this.instanceSettings.isMultiMain) {
			void this.publisher.publishCommand({ command: 'reload-sso-provisioning-configuration' });
		}
		return config;
	}

	@OnPubSubEvent('reload-sso-provisioning-configuration', { instanceType: 'main' })
	async handleReloadSsoProvisioningConfiguration() {
		this.provisioningConfig = await this.loadConfig();
	}

	/** Whether SSO sets the instance roles, so that nobody can change them by hand. */
	async isInstanceRoleManaged() {
		const config = await this.getConfig();
		if (config.scopesProvisionInstanceRole) return true;
		return config.scopesUseExpressionMapping && (await this.rules.existsWithType('instance'));
	}

	/** Whether SSO sets the project roles, so that nobody can change them by hand. */
	async isProjectRoleManaged() {
		const config = await this.getConfig();
		if (config.scopesProvisionProjectRoles) return true;
		return config.scopesUseExpressionMapping && (await this.rules.existsWithType('project'));
	}

	/**
	 * The roles of an SSO sign-in. This runs before n8n links or creates the user, so that a refused
	 * sign-in changes nothing.
	 *
	 * @throws {SsoAccessDeniedError} when the role is `block:access`
	 */
	async resolveSsoRoles(login: SsoLoginClaims): Promise<ResolvedSsoRoles> {
		const config = await this.getConfig();
		if (config.scopesUseExpressionMapping) {
			return await this.resolveByExpressions(config, login);
		}
		if (config.scopesProvisionInstanceRole || config.scopesProvisionProjectRoles) {
			return await this.resolveByClaims(config, login.claims);
		}
		return { mode: 'none' };
	}

	/** Give the user the roles of the sign-in. This runs after n8n links or creates the user. */
	async applySsoRoles(user: User, resolved: ResolvedSsoRoles) {
		if (resolved.mode === 'none') return;
		const previousRole = user.role.slug;

		if (resolved.mode === 'claims') {
			if (resolved.instanceRole !== undefined) {
				await this.setInstanceRole(user, resolved.instanceRole);
			}
			if (resolved.projectRoles !== undefined) {
				await this.setProjectRoles(user.id, resolved.projectRoles);
			}
			return;
		}

		const { instanceRole } = resolved;
		if (resolved.hasInstanceRules) await this.setInstanceRole(user, instanceRole.role);

		const projectRoles = [];
		let removedProjectIds: string[] = [];
		if (resolved.hasProjectRules) {
			const previous = await this.teamProjectRoles(user.id);
			const target = new Map(resolved.projectRoles.map(({ projectId, role }) => [projectId, role]));
			removedProjectIds = await this.setProjectRoles(user.id, target);
			for (const { projectId, role, ruleId, expression } of resolved.projectRoles) {
				const previousProjectRole = previous.get(projectId) ?? null;
				projectRoles.push({
					projectId,
					role,
					matchedRuleId: `${ruleId}:${projectId}`,
					expression,
					previousRole: previousProjectRole,
					changed: previousProjectRole !== role,
				});
			}
		}

		this.eventService.emit('expression-mapping-roles-resolved', {
			userId: user.id,
			userEmail: user.email,
			provider: resolved.provider,
			instanceRole: {
				...instanceRole,
				previousRole,
				changed: resolved.hasInstanceRules && instanceRole.role !== previousRole,
			},
			projectRoles,
			removedProjectIds,
		});
	}

	private async resolveByExpressions(
		config: ProvisioningConfigDto,
		login: SsoLoginClaims,
	): Promise<ResolvedSsoRoles> {
		const instanceRules = await this.rules.findByType({}, 'instance');
		const projectRules = await this.rules.findByType({}, 'project');

		// The rules share one context: a value that a rule changes, the later rules read.
		const matched = instanceRules.find((rule) => expressionMatches(rule.expression, login.context));
		const instanceRole = matched
			? {
					role: matched.role.slug,
					matchedRuleId: matched.id,
					expression: matched.expression,
					isFallback: false,
				}
			: {
					role: config.defaultInstanceRole ?? GLOBAL_MEMBER,
					matchedRuleId: null,
					expression: null,
					isFallback: true,
				};
		if (instanceRole.role === BLOCK_ACCESS_ASSIGNMENT) throw new SsoAccessDeniedError();

		const projectRoles: ResolvedProjectRole[] = [];
		const assigned = new Set<string>();
		for (const rule of projectRules) {
			if (!expressionMatches(rule.expression, login.context)) continue;
			for (const project of rule.projects) {
				if (assigned.has(project.id)) continue;
				assigned.add(project.id);
				projectRoles.push({
					projectId: project.id,
					role: rule.role.slug,
					ruleId: rule.id,
					expression: rule.expression,
				});
			}
		}

		return {
			mode: 'expressions',
			provider: login.provider,
			hasInstanceRules: instanceRules.length > 0,
			hasProjectRules: projectRules.length > 0,
			instanceRole,
			projectRoles,
		};
	}

	private async resolveByClaims(
		config: ProvisioningConfigDto,
		claims: Record<string, unknown>,
	): Promise<ResolvedSsoRoles> {
		let instanceRole: string | undefined;
		if (config.scopesProvisionInstanceRole) {
			const claimed = claims[config.scopesInstanceRoleClaimName];
			instanceRole =
				typeof claimed === 'string' && (await this.isAssignableGlobalRole(claimed))
					? claimed
					: config.defaultInstanceRole;
			if (instanceRole === BLOCK_ACCESS_ASSIGNMENT) throw new SsoAccessDeniedError();
		}
		const projectRoles = config.scopesProvisionProjectRoles
			? await this.parseProjectRolesClaim(claims[config.scopesProjectsRolesClaimName])
			: undefined;
		return { mode: 'claims', instanceRole, projectRoles };
	}

	/**
	 * The project roles of a claim: entries `<project id>:<role>`, for example `abc:editor`. A claim
	 * with an entry that n8n cannot use, and an empty claim, change nothing.
	 */
	private async parseProjectRolesClaim(claim: unknown) {
		if (!Array.isArray(claim) || claim.length === 0) return undefined;
		const projectRoles = new Map<string, string>();
		for (const entry of claim) {
			if (typeof entry !== 'string') return undefined;
			const parts = entry.split(':');
			if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return undefined;
			const [projectId, roleName] = parts;
			const role = await this.roleRepository.findBySlug(`project:${roleName}`);
			if (role?.roleType !== 'project') return undefined;
			projectRoles.set(projectId, role.slug);
		}
		const projects = await this.rules.findProjects({}, [...projectRoles.keys()]);
		const teamProjects = projects.filter((project) => project.type === 'team');
		if (teamProjects.length !== projectRoles.size) return undefined;
		return projectRoles;
	}

	private async isAssignableGlobalRole(slug: string) {
		if (slug === GLOBAL_OWNER) return false;
		const role = await this.roleRepository.findBySlug(slug);
		return role?.roleType === 'global';
	}

	private async assertValidDefaultRole(slug: string) {
		if (slug === BLOCK_ACCESS_ASSIGNMENT || (await this.isAssignableGlobalRole(slug))) return;
		throw new BadRequestError(
			`defaultInstanceRole must be "${BLOCK_ACCESS_ASSIGNMENT}" or the slug of an assignable global role`,
		);
	}

	/** Change the global role, except of the owner. */
	private async setInstanceRole(user: User, role: string) {
		if (user.role.slug === GLOBAL_OWNER || user.role.slug === role) return;
		await this.userService.changeUserRole(user, { newRoleName: role });
		this.eventService.emit('sso-user-instance-role-updated', { userId: user.id, role });
	}

	/** The roles of the user in team projects, by project id. */
	private async teamProjectRoles(userId: string) {
		const relations = await this.projectRelationRepository.find({
			where: { userId },
			relations: ['project', 'role'],
		});
		return new Map(
			relations
				.filter((relation) => relation.project.type === 'team')
				.map((relation) => [relation.projectId, relation.role.slug]),
		);
	}

	/**
	 * Make the team project roles of the user these roles: the user leaves the other team projects.
	 * Gives the ids of the projects that the user left.
	 */
	private async setProjectRoles(userId: string, target: Map<string, string>) {
		const previous = await this.teamProjectRoles(userId);
		const removed = [...previous.keys()].filter((projectId) => !target.has(projectId));
		for (const projectId of removed) {
			await this.projectRelationRepository.delete({ userId, projectId });
		}
		for (const [projectId, role] of target) {
			const previousRole = previous.get(projectId);
			if (previousRole === role) continue;
			if (previousRole === undefined) {
				await this.projectRelationRepository.save(
					this.projectRelationRepository.create({ userId, projectId, role: { slug: role } }),
				);
			} else {
				await this.projectRelationRepository.update(
					{ userId, projectId },
					{ role: { slug: role } },
				);
			}
		}
		if (target.size + removed.length > 0) {
			this.eventService.emit('sso-user-project-access-updated', {
				projectsAdded: target.size,
				projectsRemoved: removed.length,
				userId,
			});
		}
		return removed;
	}
}

export type { RuleType };
