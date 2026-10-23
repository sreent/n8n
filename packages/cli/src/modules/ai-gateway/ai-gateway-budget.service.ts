import { Service } from '@n8n/di';
import { randomUUID } from 'node:crypto';

import { AiGatewaySettingsService } from './ai-gateway-settings.service';
import {
	type AiGatewayUsageRow,
	AiGatewayUsageRepository,
	AiGatewayWalletRepository,
	roundDollars as round,
} from './database/repositories/ai-gateway.repositories';

/** The first moment of the month of `now`, in UTC. */
export const monthStart = (now: Date) =>
	new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** The first moment of the next month, in UTC. */
export const nextMonthStart = (now: Date) =>
	new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/** Who a call counts for. */
export interface AiGatewayCallContext {
	userId?: string;
	projectId?: string;
}

/** A call that the gateway priced. */
export type AiGatewayCharge = Omit<AiGatewayUsageRow, 'id' | 'createdAt' | 'costFromTopUp'>;

/**
 * The budgets of the gateway: the monthly budget of the instance, the top-ups, the monthly budgets
 * of projects and the monthly limit of a user. See `README.md`, "Budgets".
 */
@Service()
export class AiGatewayBudgetService {
	constructor(
		private readonly settings: AiGatewaySettingsService,
		private readonly usageRepository: AiGatewayUsageRepository,
		private readonly walletRepository: AiGatewayWalletRepository,
	) {}

	/** The budget of the instance in the month of `now`, and what is left of it. */
	async instanceStatus(now = new Date()) {
		const { monthlyBudget } = this.settings.current();
		const spend = await this.usageRepository.spend({ from: monthStart(now) });
		const spentFromBudget = Math.max(0, spend.cost - spend.costFromTopUp);
		const topUpBalance = await this.walletRepository.topUpBalance();
		const budgetLeft = Math.max(0, monthlyBudget - spentFromBudget);
		return {
			monthlyBudget,
			spentThisMonth: round(spend.cost),
			spentFromBudget: round(spentFromBudget),
			budgetLeft: round(budgetLeft),
			topUpBalance: round(topUpBalance),
			remaining: round(budgetLeft + Math.max(0, topUpBalance)),
		};
	}

	/** What is left of the monthly limit of a user, or `undefined` when users have no limit. */
	async userRemaining(userId: string, now = new Date()) {
		const { userMonthlyLimit } = this.settings.current();
		if (userMonthlyLimit === null) return undefined;
		const spend = await this.usageRepository.spend({ from: monthStart(now), userId });
		return round(Math.max(0, userMonthlyLimit - spend.cost));
	}

	/** What is left of the monthly budget of a project, or `undefined` when it has no budget. */
	async projectRemaining(projectId: string, now = new Date()) {
		const budget = this.settings.current().projectBudgets[projectId];
		if (budget === undefined) return undefined;
		const spend = await this.usageRepository.spend({ from: monthStart(now), projectId });
		return round(Math.max(0, budget - spend.cost));
	}

	/** The reason why a call cannot start, or `undefined` when each budget has money left. */
	async blockReason(context: AiGatewayCallContext, now = new Date()) {
		const instance = await this.instanceStatus(now);
		if (instance.remaining <= 0) {
			return 'The Gateway credits of this instance are spent. Ask an admin to raise the budget or add a top-up.';
		}
		if (context.projectId) {
			const projectLeft = await this.projectRemaining(context.projectId, now);
			if (projectLeft !== undefined && projectLeft <= 0) {
				return 'The monthly budget of Gateway credits for this project is spent. Ask an admin to raise it.';
			}
		}
		if (context.userId) {
			const userLeft = await this.userRemaining(context.userId, now);
			if (userLeft !== undefined && userLeft <= 0) {
				return 'Your monthly limit of Gateway credits is spent. Ask an admin to raise it.';
			}
		}
		return undefined;
	}

	/** The budget and the balance that the editor shows to a user. */
	async walletFor(userId: string, now = new Date()) {
		const instance = await this.instanceStatus(now);
		const userLeft = await this.userRemaining(userId, now);
		const balance =
			userLeft === undefined ? instance.remaining : Math.min(instance.remaining, userLeft);
		const instanceBudget = instance.monthlyBudget + instance.topUpBalance;
		const { userMonthlyLimit } = this.settings.current();
		const budget =
			userMonthlyLimit === null ? instanceBudget : Math.min(instanceBudget, userMonthlyLimit);
		return { budget: round(budget), balance: round(balance) };
	}

	/**
	 * Records a priced call. The monthly budget pays first, then the top-ups. When both are spent,
	 * the rest of the cost of the last call goes over the monthly budget. The split is approximate
	 * when calls end at the same time, as the budgets are.
	 */
	async charge(call: AiGatewayCharge, now = new Date()) {
		const cost = round(Math.max(0, call.cost));
		const { monthlyBudget } = this.settings.current();
		const spend = await this.usageRepository.spend({ from: monthStart(now) });
		const budgetLeft = Math.max(0, monthlyBudget - (spend.cost - spend.costFromTopUp));
		const costFromTopUp = await this.walletRepository.recordCall(
			{ ...call, id: randomUUID(), createdAt: now, cost },
			budgetLeft,
		);
		return { cost, costFromTopUp };
	}
}
