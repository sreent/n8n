// Fork module (not in upstream n8n): the role mapping rules of the role provisioning, in place of
// the enterprise `role-mapping-rule.service.ee.ts`. The class keeps its name and the methods that
// the public API calls (`list`, `create`, `move`, `patch` and `delete`).
// packages/cli/src/modules/provisioning/FORK.md describes it.
import type {
	CreateRoleMappingRuleDto,
	ListRoleMappingRuleQueryInput,
	PatchRoleMappingRuleInput,
} from '@n8n/api-types';
import { EventService } from '@n8n/backend-services';
import type { OperationContext, RoleMappingRule, User } from '@n8n/db';
import { RoleRepository, TransactionRunner } from '@n8n/db';
import { Service } from '@n8n/di';
import { BadRequestError, ConflictError, NotFoundError } from '@n8n/errors';

import type { RuleSortField, RuleType } from './database/provisioning-rule.repository';
import { ProvisioningRuleRepository, ruleTypeOf } from './database/provisioning-rule.repository';

/** A rule as the REST API and the public API send it. */
export interface RoleMappingRuleResponse {
	id: string;
	expression: string;
	role: string;
	type: RuleType;
	order: number;
	projectIds: string[];
	createdAt: string;
	updatedAt: string;
}

/** The fields of a change, in the order in which the event names them. */
const PATCH_FIELDS = ['expression', 'role', 'type', 'order', 'projectIds'] as const;

type SortBy = NonNullable<ListRoleMappingRuleQueryInput['sortBy']>;

const SORTS: Record<SortBy, { field: RuleSortField; direction: 'ASC' | 'DESC' }> = {
	'order:asc': { field: 'order', direction: 'ASC' },
	'order:desc': { field: 'order', direction: 'DESC' },
	'createdAt:asc': { field: 'createdAt', direction: 'ASC' },
	'createdAt:desc': { field: 'createdAt', direction: 'DESC' },
	'updatedAt:asc': { field: 'updatedAt', direction: 'ASC' },
	'updatedAt:desc': { field: 'updatedAt', direction: 'DESC' },
};

const toResponse = (rule: RoleMappingRule): RoleMappingRuleResponse => ({
	id: rule.id,
	expression: rule.expression,
	role: rule.role.slug,
	type: ruleTypeOf(rule),
	order: rule.order,
	projectIds: (rule.projects ?? []).map((project) => project.id),
	createdAt: rule.createdAt.toISOString(),
	updatedAt: rule.updatedAt.toISOString(),
});

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

@Service()
export class RoleMappingRuleService {
	constructor(
		private readonly rules: ProvisioningRuleRepository,
		private readonly roleRepository: RoleRepository,
		private readonly transactionRunner: TransactionRunner,
		private readonly eventService: EventService,
	) {}

	async list(query: Partial<ListRoleMappingRuleQueryInput> & { type?: RuleType }) {
		const sort = SORTS[query.sortBy ?? 'order:asc'];
		const [rules, count] = await this.rules.findPage(
			{},
			{
				type: query.type,
				skip: query.skip,
				take: query.take,
				sortField: sort.field,
				sortDirection: sort.direction,
			},
		);
		return { count, items: rules.map(toResponse) };
	}

	async create(dto: CreateRoleMappingRuleDto, user: Pick<User, 'id' | 'email'>) {
		const projectIds = dto.projectIds ?? [];
		this.assertProjectIdsFitType(dto.type, projectIds);
		const role = await this.findRole(dto.role, dto.type);
		const projects = await this.findProjects(projectIds);

		const id = await this.transactionRunner.run({}, async (ctx) => {
			const siblings = await this.rules.findByType(ctx, dto.type);
			const position = clamp(dto.order ?? siblings.length, siblings.length);
			// Every rule of the type gets its order again, so the sequence stays 0, 1, 2, ...
			await this.rules.parkOrders(
				ctx,
				siblings.map((rule) => rule.id),
			);
			const created = await this.rules.saveRule(
				ctx,
				this.rules.create({
					expression: dto.expression,
					role,
					type: dto.type,
					order: position,
					projects,
				}),
			);
			const others = siblings.map((rule, index) => ({
				id: rule.id,
				order: index < position ? index : index + 1,
			}));
			await this.rules.setOrders(ctx, others);
			return created.id;
		});

		const rule = await this.findOrFail({}, id);
		this.eventService.emit('role-mapping-rule-created', {
			user: { id: user.id, email: user.email },
			ruleId: rule.id,
			ruleType: dto.type,
			expression: rule.expression,
			role: rule.role.slug,
		});
		return toResponse(rule);
	}

	async patch({
		id,
		dto,
		userId,
		userEmail,
	}: {
		id: string;
		dto: PatchRoleMappingRuleInput;
		userId: string;
		userEmail: string;
	}) {
		const patchedFields = PATCH_FIELDS.filter((field) => dto[field] !== undefined);
		if (patchedFields.length === 0) throw new BadRequestError('At least one field is required');

		const rule = await this.findOrFail({}, id);
		const oldType = ruleTypeOf(rule);
		const type = dto.type ?? oldType;
		const projectIds = dto.projectIds ?? rule.projects.map((project) => project.id);
		this.assertProjectIdsFitType(type, type === 'instance' ? (dto.projectIds ?? []) : projectIds);
		const role = await this.findRole(dto.role ?? rule.role.slug, type);
		const projects =
			dto.projectIds !== undefined ? await this.findProjects(dto.projectIds) : rule.projects;
		const order = dto.order ?? rule.order;

		await this.transactionRunner.run({}, async (ctx) => {
			if (
				(order !== rule.order || type !== oldType) &&
				(await this.rules.isOrderTaken(ctx, type, order, rule.id))
			) {
				throw new ConflictError(
					`A role mapping rule already exists with type "${type}" and order ${order}. Use a different order value.`,
				);
			}
			rule.expression = dto.expression ?? rule.expression;
			rule.role = role;
			rule.type = type;
			rule.order = order;
			rule.projects = type === 'instance' ? [] : projects;
			await this.rules.saveRule(ctx, rule);
			await this.closeGaps(ctx, type);
			if (type !== oldType) await this.closeGaps(ctx, oldType);
		});

		const updated = await this.findOrFail({}, id);
		this.eventService.emit('role-mapping-rule-updated', {
			user: { id: userId, email: userEmail },
			ruleId: id,
			ruleType: type,
			patchedFields: [...patchedFields],
		});
		return toResponse(updated);
	}

	async move({
		id,
		targetIndex,
		userId,
		userEmail,
	}: {
		id: string;
		targetIndex: number;
		userId: string;
		userEmail: string;
	}) {
		const rule = await this.findOrFail({}, id);
		const type = ruleTypeOf(rule);

		await this.transactionRunner.run({}, async (ctx) => {
			const others = (await this.rules.findByType(ctx, type)).filter(
				({ id: other }) => other !== id,
			);
			const ordered = others.map((other) => other.id);
			ordered.splice(clamp(targetIndex, others.length), 0, id);
			await this.renumber(ctx, ordered);
		});

		const moved = await this.findOrFail({}, id);
		this.eventService.emit('role-mapping-rule-updated', {
			user: { id: userId, email: userEmail },
			ruleId: id,
			ruleType: type,
			patchedFields: ['order'],
		});
		return toResponse(moved);
	}

	async delete({ id, userId, userEmail }: { id: string; userId: string; userEmail: string }) {
		const rule = await this.findOrFail({}, id);
		const type = ruleTypeOf(rule);

		await this.transactionRunner.run({}, async (ctx) => {
			await this.rules.deleteRule(ctx, id);
			await this.closeGaps(ctx, type);
		});

		this.eventService.emit('role-mapping-rule-deleted', {
			user: { id: userId, email: userEmail },
			ruleId: id,
			ruleType: type,
		});
		return toResponse(rule);
	}

	private async findOrFail(ctx: OperationContext, id: string) {
		const rule = await this.rules.findWithRelations(ctx, id);
		if (!rule) throw new NotFoundError('Could not find role mapping rule');
		return rule;
	}

	private assertProjectIdsFitType(type: RuleType, projectIds: string[]) {
		if (type === 'project' && projectIds.length === 0) {
			throw new BadRequestError('projectIds is required when type is project');
		}
		if (type === 'instance' && projectIds.length > 0) {
			throw new BadRequestError('projectIds must be omitted or empty when type is instance');
		}
	}

	/** The role of a rule: it must exist, and its role type must fit the type of the rule. */
	private async findRole(slug: string, type: RuleType) {
		const role = await this.roleRepository.findBySlug(slug);
		if (!role) throw new NotFoundError(`Could not find role with slug "${slug}"`);
		if (type === 'instance' && role.roleType !== 'global') {
			throw new BadRequestError('Instance mapping rules must use a global role');
		}
		if (type === 'project' && role.roleType !== 'project') {
			throw new BadRequestError('Project mapping rules must use a project role');
		}
		return role;
	}

	private async findProjects(projectIds: string[]) {
		const unique = [...new Set(projectIds)];
		const projects = await this.rules.findProjects({}, unique);
		if (projects.length !== unique.length) {
			throw new BadRequestError('One or more projects were not found');
		}
		return projects;
	}

	/** Give the rules of a type the order values 0, 1, 2, ... when their values have a gap. */
	private async closeGaps(ctx: OperationContext, type: RuleType) {
		const rules = await this.rules.findByType(ctx, type);
		if (rules.every((rule, index) => rule.order === index)) return;
		await this.renumber(
			ctx,
			rules.map((rule) => rule.id),
		);
	}

	/** Give the rules the order values of their place in the list. Each rule gets written. */
	private async renumber(ctx: OperationContext, ruleIds: string[]) {
		await this.rules.parkOrders(ctx, ruleIds);
		await this.rules.setOrders(
			ctx,
			ruleIds.map((id, order) => ({ id, order })),
		);
	}
}
