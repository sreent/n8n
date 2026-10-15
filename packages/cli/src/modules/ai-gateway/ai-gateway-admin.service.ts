import { ProjectRepository, UserRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { BadRequestError } from '@n8n/errors';
import { randomUUID } from 'node:crypto';

import { AiGatewayBudgetService, monthStart, nextMonthStart } from './ai-gateway-budget.service';
import type { AiGatewaySettingsDto, AiGatewayTopUpDto } from './ai-gateway.dto';
import { AiGatewayPriceService } from './ai-gateway-price.service';
import { AiGatewayProtocolService, toUsageEntry } from './ai-gateway-protocol.service';
import { AiGatewayProxyService } from './ai-gateway-proxy.service';
import {
	type AiGatewayProviderSettings,
	AiGatewaySettingsService,
} from './ai-gateway-settings.service';
import {
	type AiGatewayUsageFilter,
	AiGatewayCredentialOptionsRepository,
	AiGatewayTopUpRepository,
	AiGatewayUsageRepository,
	AiGatewayWalletRepository,
} from './database/repositories/ai-gateway.repositories';
import {
	AI_GATEWAY_PROVIDERS,
	type AiGatewayProvider,
	backendOf,
	credentialTypesOf,
	providerBySlug,
} from './providers';

const ALL_CREDENTIAL_TYPES = [...new Set(AI_GATEWAY_PROVIDERS.flatMap(credentialTypesOf))];

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
	 * The settings, each provider with its credential and the credentials of its types (its own
	 * type and the types of its backends), the team projects, and the URL of the gateway.
	 */
	async getSettings() {
		const settings = this.settings.current();
		const credentials = await this.credentialOptions.ofTypes(ALL_CREDENTIAL_TYPES);
		const providers = AI_GATEWAY_PROVIDERS.map((provider) => {
			const types = credentialTypesOf(provider);
			const credentialOptions = credentials
				.filter((credential) => types.includes(credential.type))
				.map(({ id, name, type }) => ({ id, name, type }));
			const credentialId = settings.providers[provider.slug]?.credentialId;
			return {
				slug: provider.slug,
				displayName: provider.displayName,
				credentialType: provider.credentialType,
				backends: (provider.backends ?? []).map(({ kind, credentialType, displayName }) => ({
					kind,
					credentialType,
					displayName,
				})),
				priceUnit: provider.priceUnit ?? 'tokens',
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
		const credentials = await this.credentialOptions.ofTypes(ALL_CREDENTIAL_TYPES);
		const providers: Record<string, AiGatewayProviderSettings> = {};
		for (const [slug, providerSettings] of Object.entries(update.providers)) {
			const provider = providerBySlug(slug);
			if (!provider) throw new BadRequestError(`The AI gateway has no provider "${slug}".`);
			const types = credentialTypesOf(provider);
			const credential = credentials.find((option) => option.id === providerSettings.credentialId);
			if (!credential || !types.includes(credential.type)) {
				throw new BadRequestError(
					`The credential for ${provider.displayName} must be a credential of the type ${types.join(' or ')}.`,
				);
			}
			providers[slug] = this.backendSettings(
				provider,
				credential.type,
				providerSettings,
				credentials,
			);
		}
		for (const slug of Object.keys(update.prices)) {
			if (!providerBySlug(slug))
				throw new BadRequestError(`The AI gateway has no provider "${slug}".`);
		}
		await this.settings.save({
			enabled: update.enabled,
			providers,
			monthlyBudget: update.monthlyBudget,
			userMonthlyLimit: update.userMonthlyLimit,
			projectBudgets: update.projectBudgets,
			prices: update.prices,
			estimateUsage: update.estimateUsage,
		});
		this.proxy.clearCredentialCache();
		return await this.getSettings();
	}

	/**
	 * The settings of a provider with the type of its credential, and only the options of the
	 * backend of that type: the project and the location of Vertex AI, the deployments of Azure
	 * OpenAI, and the open models of Vertex AI behind an OpenAI or Azure credential.
	 */
	private backendSettings(
		provider: AiGatewayProvider,
		credentialType: string,
		update: AiGatewayProviderSettings,
		credentials: Array<{ id: string; type: string }>,
	): AiGatewayProviderSettings {
		const result: AiGatewayProviderSettings = { credentialId: update.credentialId, credentialType };
		const backend = backendOf(provider, credentialType);
		if (backend?.kind === 'vertex-ai' || backend?.kind === 'vertex-openai') {
			if (update.projectId) result.projectId = update.projectId;
			if (update.location) result.location = update.location;
		}
		if (backend?.kind === 'azure-openai' && update.deployments?.length) {
			result.deployments = [...new Set(update.deployments)];
		}
		const openModelsBackend = provider.backends?.find(({ kind }) => kind === 'vertex-openai');
		if (update.openModels && openModelsBackend && backend?.kind !== 'vertex-openai') {
			const { credentialId, projectId, location } = update.openModels;
			const credential = credentials.find((option) => option.id === credentialId);
			if (credential?.type !== openModelsBackend.credentialType) {
				throw new BadRequestError(
					`The credential for the open models of Vertex AI must be a credential of the type ${openModelsBackend.credentialType}.`,
				);
			}
			result.openModels = {
				credentialId,
				credentialType: credential.type,
				...(projectId ? { projectId } : {}),
				...(location ? { location } : {}),
			};
		}
		return result;
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
				estimated: row.estimated,
				userId: row.userId,
				userEmail: users.find((user) => user.id === row.userId)?.email ?? null,
				projectId: row.projectId,
				projectName: projects.find((project) => project?.id === row.projectId)?.name ?? null,
			})),
		};
	}
}
