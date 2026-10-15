import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule, OnShutdown } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Fork module (not in upstream n8n): the AI gateway of the Gateway credits of the editor. It answers
 * the ordinary `AiGatewayService` in the process, and forwards the calls of the nodes to the
 * providers with the credentials of an admin, within budgets. `README.md` describes it.
 */
@BackendModule({ name: 'ai-gateway' })
export class AiGatewayModule implements ModuleInterface {
	async init() {
		await import('./ai-gateway.controller.js');
		await import('./ai-gateway-proxy.controller.js');

		const { AiGatewaySettingsService } = await import('./ai-gateway-settings.service.js');
		await Container.get(AiGatewaySettingsService).init();

		// Each instance type answers `AiGatewayService`, because nodes run on workers in queue mode.
		const { AiGatewayProtocolService } = await import('./ai-gateway-protocol.service.js');
		const { ForkAiGatewayBridge } = await import('@/services/fork-ai-gateway-bridge.js');
		Container.get(ForkAiGatewayBridge).register(Container.get(AiGatewayProtocolService));
	}

	async entities() {
		const { AiGatewayTopUp, AiGatewayUsage, AiGatewayWallet } = await import(
			'./database/entities/ai-gateway.entities.js'
		);
		return [AiGatewayUsage, AiGatewayTopUp, AiGatewayWallet];
	}

	@OnShutdown()
	async shutdown() {
		const { AiGatewaySettingsService } = await import('./ai-gateway-settings.service.js');
		Container.get(AiGatewaySettingsService).shutdown();
	}
}
