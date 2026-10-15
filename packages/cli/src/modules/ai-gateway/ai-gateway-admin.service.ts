import { ProjectRepository, UserRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { BadRequestError } from '@n8n/errors';
import { randomUUID } from 'node:crypto';

import { AiGatewayBudgetService, monthStart, nextMonthStart } from './ai-gateway-budget.service';
import type { AiGatewaySettingsDto, AiGatewayTopUpDto } from './ai-gateway.dto';
import { AiGatewayPriceService } from './ai-gateway-price.service';
import { AiGatewayProtocolService, toUsageEntry } from './ai-gateway-protocol.service';
import { AiGatewayProxyService } from './ai-gateway-proxy.service';
import { AiGatewaySettingsService } from './ai-gateway-settings.service';
import {
	type AiGatewayUsageFilter,
	AiGatewayCredentialOptionsRepository,
	AiGatewayTopUpRepository,
	AiGatewayUsageRepository,
	AiGatewayWalletRepository,
} from './database/repositories/ai-gateway.repositories';
import { AI_GATEWAY_PROVIDERS, providerBySlug } from './providers';

/** The REST API of the settings page **Settings > AI gateway**. See `README.md`. */
@Service()
export class AiGatewayAdminService {
	constructor(
		private readonly settings: AiGatewaySettingsService,
		private readonly protocol: AiGatewayProtocolService,
		private readonly proxy: AiGatewayProxyService,
		private readonly budgets: AiGatewayBudgetService,
		private readonly priceService: AiGatewayPriceService,
		private readonly usageRepository: AiGatewayUsageRepository,
		private readonly topUpRepository: AiGatewayTopUpRepository,
		private readonly walletRepository: AiGatewayWalletRepository,
		private readonly credentialOptions: AiGatewayCredentialOptionsRepository,
		private readonly projectRepository: ProjectRepository,
		private readonly userRepository: UserRepository,
	) {}

	/**
	 * The settings, each provider with its credential and the credentials of its type, the team
	 * projects, and the URL of the gateway.
	 */
	async getSettings() {
		const settings = this.settings.current();
		const credentials = await this.credentialOptions.ofTypes(
			AI_GATEWAY_PROVIDERS.map((provider) => provider.credentialType),
		);
		const providers = AI_GATEWAY_PROVIDERS.map((provider) => {
			const credentialOptions = credentials
				.filter((credential) => credential.type === provider.credentialType)
				.map(({ id, name }) => ({ id, name }));
			const credentialId = settings.providers[provider.slug]?.credentialId;
			return {
				slug: provider.slug,
				displayName: provider.displayName,
				credentialType: provider.credentialType,
				credential: credentialOptions.find((option) => option.id === credentialId) ?? null,
				credentialOptions,
			};
		});
		const projects = (await this.projectRepository.findTeamProjects())
			.map(({ id, name }) => ({ id, name }))
			.sort((a, b) => a.name.localeCompare(b.name));
		return { settings, providers, projects, baseUrl: this.protocol.baseUrl() ?? null };
	}

	async updateSettings(update: AiGatewaySettingsDto) {
		const credentials = await this.credentialOptions.ofTypes(
			AI_GATEWAY_PROVIDERS.map((provider) => provider.credentialType),
		);
		for (const [slug, { credentialId }] of Object.entries(update.providers)) {
			const provider = providerBySlug(slug);
			if (!provider) throw new BadRequestError(`The AI gateway has no provider "${slug}".`);
			const credential = credentials.find((option) => option.id === credentialId);
			if (!credential || credential.type !== provider.credentialType) {
				throw new BadRequestError(
					`The credential for ${provider.displayName} must be a credential of the type ${provider.credentialType}.`,
				);
			}
		}
		for (const slug of Object.keys(update.prices)) {
			if (!providerBySlug(slug))
				throw new BadRequestError(`The AI gateway has no provider "${slug}".`);
		}
		await this.settings.save({
			enabled: update.enabled,
			providers: update.providers,
			monthlyBudget: update.monthlyBudget,
			userMonthlyLimit: update.userMonthlyLimit,
			projectBudgets: update.projectBudgets,
			prices: update.prices,
		});
		this.proxy.clearCredentialCache();
		return await this.getSettings();
	}

	/** The month, the budgets, the spend and the projects with a budget or a spend. */
	async overview(now = new Date()) {
		const instance = await this.budgets.instanceStatus(now);
		const { projectBudgets, userMonthlyLimit } = this.settings.current();
		const spendByProject = await this.usageRepository.spendByProject({ from: monthStart(now) });
		const projectIds = new Set([
			...Object.keys(projectBudgets),
			...spendByProject.flatMap(({ projectId }) => (projectId ? [projectId] : [])),
		]);
		const projects = await Promise.all(
			[...projectIds].map(async (projectId) => {
				const project = await this.projectRepository.findOneBy({ id: projectId });
				const spent = spendByProject.find((row) => row.projectId === projectId)?.cost ?? 0;
				return {
					projectId,
					name: project?.name ?? null,
					monthlyBudget: projectBudgets[projectId] ?? null,
					spentThisMonth: spent,
				};
			}),
		);
		const withoutProject = spendByProject.find((row) => row.projectId === null)?.cost ?? 0;
		return {
			periodStart: monthStart(now).toISOString(),
			periodEnd: nextMonthStart(now).toISOString(),
			...instance,
			userMonthlyLimit,
			projects,
			spentWithoutProject: withoutProject,
		};
	}

	/** The newest 100 top-ups, with the e-mail of the admin who added each one. */
	async listTopUps() {
		const topUps = await this.topUpRepository.newestFirst(100);
		const userIds = [
			...new Set(topUps.flatMap((topUp) => (topUp.createdById ? [topUp.createdById] : []))),
		];
		const users = userIds.length > 0 ? await this.userRepository.findManyByIds(userIds) : [];
		return topUps.map((topUp) => ({
			id: topUp.id,
			createdAt: topUp.createdAt,
			amount: topUp.amount,
			createdById: topUp.createdById,
			createdByEmail: users.find((user) => user.id === topUp.createdById)?.email ?? null,
			note: topUp.note,
		}));
	}

	async addTopUp(topUp: AiGatewayTopUpDto, userId: string) {
		await this.walletRepository.addTopUp({
			id: randomUUID(),
			createdAt: new Date(),
			amount: topUp.amount,
			createdById: userId,
			note: topUp.note ?? null,
		});
		return await this.overview();
	}

	prices() {
		return this.priceService.table();
	}

	/** One page of calls, with the e-mail of the user and the name of the project. */
	async usage(filter: AiGatewayUsageFilter, skip: number, take: number) {
		const { rows, count } = await this.usageRepository.findPage(filter, skip, take);
		const userIds = [...new Set(rows.flatMap((row) => (row.userId ? [row.userId] : [])))];
		const users = userIds.length > 0 ? await this.userRepository.findManyByIds(userIds) : [];
		const projectIds = [...new Set(rows.flatMap((row) => (row.projectId ? [row.projectId] : [])))];
		const projects = await Promise.all(
			projectIds.map(async (id) => await this.projectRepository.findOneBy({ id })),
		);
		return {
			count,
			entries: rows.map((row) => ({
				...toUsageEntry(row),
				id: row.id,
				cachedInputTokens: row.cachedInputTokens,
				costFromTopUp: row.costFromTopUp,
				userId: row.userId,
				userEmail: users.find((user) => user.id === row.userId)?.email ?? null,
				projectId: row.projectId,
				projectName: projects.find((project) => project?.id === row.projectId)?.name ?? null,
			})),
		};
	}
}
