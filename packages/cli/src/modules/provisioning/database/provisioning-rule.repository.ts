// Fork module (not in upstream n8n): the queries of the role provisioning of SSO.
// packages/cli/src/modules/provisioning/FORK.md describes them.
import type { OperationContext } from '@n8n/db';
import { BaseRepository, Project, RoleMappingRule, TransactionRunner } from '@n8n/db';
import { Service } from '@n8n/di';
import { UnexpectedError } from '@n8n/errors';
import { DataSource, In } from '@n8n/typeorm';

export type RuleType = 'instance' | 'project';

export type RuleSortField = 'order' | 'createdAt' | 'updatedAt';

/** The type of a stored rule. The API accepts only the two rule types. */
export function ruleTypeOf(rule: Pick<RoleMappingRule, 'type'>): RuleType {
	if (rule.type === 'instance' || rule.type === 'project') return rule.type;
	throw new UnexpectedError(`Unknown role mapping rule type "${rule.type}"`);
}

/** The role mapping rules, with the queries that the provisioning needs. */
@Service()
export class ProvisioningRuleRepository extends BaseRepository<RoleMappingRule> {
	constructor(dataSource: DataSource, transactionRunner: TransactionRunner) {
		super(RoleMappingRule, dataSource.manager, transactionRunner);
	}

	/** A page of rules with their role and projects, and the number of rules that match. */
	async findPage(
		ctx: OperationContext,
		options: {
			type?: RuleType;
			skip?: number;
			take?: number;
			sortField: RuleSortField;
			sortDirection: 'ASC' | 'DESC';
		},
	): Promise<[RoleMappingRule[], number]> {
		return await this.managerFor(ctx).findAndCount(RoleMappingRule, {
			where: options.type ? { type: options.type } : {},
			relations: ['projects', 'role'],
			order: { [options.sortField]: options.sortDirection },
			skip: options.skip,
			take: options.take,
		});
	}

	async findWithRelations(ctx: OperationContext, id: string) {
		return await this.managerFor(ctx).findOne(RoleMappingRule, {
			where: { id },
			relations: ['projects', 'role'],
		});
	}

	/** The rules of a type in their evaluation order, with their role and projects. */
	async findByType(ctx: OperationContext, type: RuleType) {
		return await this.managerFor(ctx).find(RoleMappingRule, {
			where: { type },
			relations: ['projects', 'role'],
			order: { order: 'ASC' },
		});
	}

	async isOrderTaken(ctx: OperationContext, type: string, order: number, exceptId: string) {
		const rule = await this.managerFor(ctx).findOne(RoleMappingRule, {
			where: { type, order },
			select: ['id'],
		});
		return rule !== null && rule.id !== exceptId;
	}

	async existsWithType(type: RuleType) {
		return await this.exists({ where: { type } });
	}

	async countByRole(roleSlug: string) {
		return await this.count({ where: { role: { slug: roleSlug } } });
	}

	/** The projects with these ids that exist, of any type. */
	async findProjects(ctx: OperationContext, ids: string[]) {
		if (ids.length === 0) return [];
		return await this.managerFor(ctx).find(Project, { where: { id: In(ids) } });
	}

	async saveRule(ctx: OperationContext, rule: RoleMappingRule) {
		return await this.managerFor(ctx).save(RoleMappingRule, rule);
	}

	async deleteRule(ctx: OperationContext, id: string) {
		await this.managerFor(ctx).delete(RoleMappingRule, { id });
	}

	/** Delete every rule of a type, and give the number of deleted rules. */
	async deleteByType(ctx: OperationContext, type: RuleType) {
		const result = await this.managerFor(ctx).delete(RoleMappingRule, { type });
		return result.affected ?? 0;
	}

	/**
	 * Move the rules of a type out of the way of new order values: each one gets a negative order.
	 * The unique key on the type and the order allows no other sequence of updates.
	 */
	async parkOrders(ctx: OperationContext, ruleIds: string[]) {
		const manager = this.managerFor(ctx);
		for (const [index, id] of ruleIds.entries()) {
			await manager.update(RoleMappingRule, { id }, { order: -1 - index });
		}
	}

	/** Give the rules the order values of their place in the list. */
	async setOrders(ctx: OperationContext, orders: Array<{ id: string; order: number }>) {
		const manager = this.managerFor(ctx);
		for (const { id, order } of orders) {
			await manager.update(RoleMappingRule, { id }, { order });
		}
	}
}
