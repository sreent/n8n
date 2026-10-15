import { Service } from '@n8n/di';

/** A request of `AiGatewayService` to the gateway service. */
export interface ForkAiGatewayRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: unknown;
}

/** The fork AI gateway, as `AiGatewayService` sees it. */
export interface ForkAiGatewayHandler {
	/** The URL of the gateway that the nodes call, or `undefined` while the gateway is off. */
	baseUrl(): string | undefined;
	/** Answers a request of `AiGatewayService` in the process, without HTTP. */
	answer(request: ForkAiGatewayRequest): Promise<unknown>;
}

/**
 * Fork code (not in upstream n8n): the hook between the ordinary `AiGatewayService` and the fork
 * module `ai-gateway`, which registers itself here. While the fork gateway is on, the module answers
 * the requests of `AiGatewayService` in place of the gateway service of n8n. See
 * `packages/cli/src/modules/ai-gateway/README.md`.
 */
@Service()
export class ForkAiGatewayBridge {
	private handler: ForkAiGatewayHandler | undefined;

	register(handler: ForkAiGatewayHandler) {
		this.handler = handler;
	}

	/** The fork gateway when it is on, else `undefined`. */
	active(): (ForkAiGatewayHandler & { url: string }) | undefined {
		const url = this.handler?.baseUrl();
		if (!this.handler || !url) return undefined;
		const handler = this.handler;
		return {
			url,
			baseUrl: () => handler.baseUrl(),
			answer: async (request) => await handler.answer(request),
		};
	}
}
