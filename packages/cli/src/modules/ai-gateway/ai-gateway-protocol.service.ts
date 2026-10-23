import type { AiGatewayUsageEntry, AiGatewayUsageResponse } from '@n8n/api-types';
import { GlobalConfig } from '@n8n/config';
import { UserRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { hasGlobalScope } from '@n8n/permissions';
import { UnexpectedError, UserError } from 'n8n-workflow';

import type { ForkAiGatewayHandler, ForkAiGatewayRequest } from '@/services/fork-ai-gateway-bridge';

import { ForkAiGatewayConfig } from './ai-gateway.config';
import { AiGatewayBudgetService } from './ai-gateway-budget.service';
import { AiGatewaySettingsService } from './ai-gateway-settings.service';
import { AiGatewayTokenService } from './ai-gateway-token.service';
import type { AiGatewayUsage } from './database/entities/ai-gateway.entities';
import { AiGatewayUsageRepository } from './database/repositories/ai-gateway.repositories';
import { AI_GATEWAY_PROVIDERS, type AiGatewayProvider, backendOf } from './providers';

/** The path of the proxy routes, after the URL of the instance. */
export const AI_GATEWAY_ROUTE = '/ai-gateway';

const GATEWAY_PREFIX = '/v1/gateway/';

const MAX_USAGE_PAGE = 250;

/**
 * Answers the four requests that the ordinary `AiGatewayService` sends to the gateway service of
 * n8n: the config, a token, the wallet and the usage. `ForkAiGatewayBridge` sends them here in the
 * process, so the token endpoint is never open on the network. See `README.md`.
 */
@Service()
export class AiGatewayProtocolService implements ForkAiGatewayHandler {
	constructor(
		private readonly globalConfig: GlobalConfig,
		private readonly config: ForkAiGatewayConfig,
		private readonly settings: AiGatewaySettingsService,
		private readonly tokens: AiGatewayTokenService,
		private readonly budgets: AiGatewayBudgetService,
		private readonly usageRepository: AiGatewayUsageRepository,
		private readonly userRepository: UserRepository,
	) {}

	/** The URL of the gateway while it is on and has a provider, else `undefined`. */
	baseUrl() {
		const settings = this.settings.current();
		if (!settings.enabled || this.configuredProviders().length === 0) return undefined;
		const url =
			this.config.baseUrl || `http://127.0.0.1:${this.globalConfig.port}${AI_GATEWAY_ROUTE}`;
		return url.replace(/\/+$/, '');
	}

	/** The providers that have a credential of the admin. */
	configuredProviders(): AiGatewayProvider[] {
		const { providers } = this.settings.current();
		return AI_GATEWAY_PROVIDERS.filter((provider) => providers[provider.slug] !== undefined);
	}

	async answer(request: ForkAiGatewayRequest): Promise<unknown> {
		const url = new URL(request.url);
		const start = url.pathname.indexOf(GATEWAY_PREFIX);
		const route = start === -1 ? '' : url.pathname.slice(start + GATEWAY_PREFIX.length);
		const method = request.method.toUpperCase();

		if (method === 'GET' && route === 'config') return this.gatewayConfig();
		if (method === 'POST' && route === 'credentials') {
			const userId = request.headers?.['x-user-id'];
			if (!userId) throw new UserError('Gateway credits need a user for a token.');
			return this.tokens.issue(userId);
		}
		if (method === 'GET' && route === 'wallet') {
			const userId = this.userOf(request);
			return { ...(await this.budgets.walletFor(userId)), hasEverToppedUp: true };
		}
		if (method === 'GET' && route === 'usage') {
			const userId = this.userOf(request);
			const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
			const limit = Math.min(
				MAX_USAGE_PAGE,
				Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50),
			);
			return await this.usageOf(userId, offset, limit);
		}
		throw new UnexpectedError(`Unknown request to Gateway credits: ${method} ${route}`);
	}

	/** The config that the editor and `AiGatewayService` read: the nodes and the providers. */
	gatewayConfig() {
		const providers = this.configuredProviders();
		const merge = <T>(pick: (provider: AiGatewayProvider) => Record<string, T> | undefined) => {
			const merged: Record<string, T> = {};
			for (const provider of providers) Object.assign(merged, pick(provider));
			return merged;
		};
		return {
			nodes: [...new Set(providers.flatMap((provider) => provider.nodes))],
			credentialTypes: providers.map((provider) => provider.credentialType),
			providerConfig: Object.fromEntries(
				providers.map((provider) => [
					provider.credentialType,
					{
						gatewayPath: provider.gatewayPath,
						urlField: provider.urlField,
						apiKeyField: provider.apiKeyField,
					},
				]),
			),
			supportedActions: merge((provider) => this.supportedActionsOf(provider)),
			minNodeTypeVersion: merge((provider) => provider.minNodeTypeVersion),
			hiddenNodeProperties: merge((provider) => provider.hiddenNodeProperties),
		};
	}

	/** The operations of the app nodes that work with the backend of the admin's credential. */
	private supportedActionsOf(provider: AiGatewayProvider) {
		const credentialType = this.settings.current().providers[provider.slug]?.credentialType;
		const backend = credentialType ? backendOf(provider, credentialType) : undefined;
		return backend?.supportedActions ?? provider.supportedActions;
	}

	/** The user of the token in the `Authorization` header of a request. */
	private userOf(request: ForkAiGatewayRequest) {
		const header = request.headers?.Authorization ?? request.headers?.authorization ?? '';
		const userId = this.tokens.verify(header.replace(/^Bearer\s+/i, ''));
		if (!userId) throw new UserError("The Gateway credits token isn't valid.");
		return userId;
	}

	/** The calls of a user. An admin sees the calls of all users. */
	private async usageOf(
		userId: string,
		offset: number,
		limit: number,
	): Promise<AiGatewayUsageResponse> {
		const user = await this.userRepository.findOne({ where: { id: userId }, relations: ['role'] });
		const seesAll = user ? hasGlobalScope(user, 'aiAssistant:manage') : false;
		const { rows, count } = await this.usageRepository.findPage(
			seesAll ? {} : { userId },
			offset,
			limit,
		);
		return { entries: rows.map(toUsageEntry), total: count };
	}
}

export function toUsageEntry(row: AiGatewayUsage): AiGatewayUsageEntry {
	return {
		provider: row.provider,
		model: row.model,
		timestamp: new Date(row.createdAt).getTime(),
		cost: row.cost,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		metadata: {
			...(row.executionId ? { executionId: row.executionId } : {}),
			...(row.workflowId ? { workflowId: row.workflowId } : {}),
			...(row.projectId ? { projectId: row.projectId } : {}),
			...(row.agentId ? { agentId: row.agentId } : {}),
		},
	};
}
