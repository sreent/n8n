import { Service } from '@n8n/di';

import { AiGatewaySettingsService } from './ai-gateway-settings.service';
import { type AiGatewayModelPrice, findPrice, LIST_PRICES, LIST_PRICES_DATE } from './prices';
import type { AiGatewayProvider } from './providers';

/** The provider slug of a model id that names its maker, for example `openai/gpt-4o`. */
const MAKER_SLUGS: Readonly<Record<string, string>> = {
	openai: 'openai',
	anthropic: 'anthropic',
	google: 'google',
	xai: 'xai',
	'x-ai': 'xai',
	deepseek: 'deepseek',
	moonshotai: 'moonshot',
	minimax: 'minimax',
};

const FREE: AiGatewayModelPrice = { input: 0, output: 0 };

/** The prices of the models: the prices of the admin first, then the list prices. */
@Service()
export class AiGatewayPriceService {
	constructor(private readonly settings: AiGatewaySettingsService) {}

	/** The price of a model of a provider, or `undefined` when the model has no price. */
	priceOf(provider: AiGatewayProvider, model: string): AiGatewayModelPrice | undefined {
		const own = this.lookup(provider.slug, model);
		if (own) return own;

		// Vercel AI Gateway and OpenRouter name the maker of a model: `openai/gpt-4o`.
		const slash = model.indexOf('/');
		if (slash > 0) {
			const makerSlug = MAKER_SLUGS[model.slice(0, slash).toLowerCase()];
			const makerPrice = makerSlug ? this.lookup(makerSlug, model.slice(slash + 1)) : undefined;
			if (makerPrice) return makerPrice;
		}

		return provider.freeByDefault ? FREE : undefined;
	}

	/** The models of a provider that have a price of the admin or a list price, sorted. */
	modelsWithPrice(provider: AiGatewayProvider) {
		const models = new Set([
			...Object.keys(this.settings.current().prices[provider.slug] ?? {}),
			...Object.keys(LIST_PRICES[provider.slug] ?? {}),
		]);
		return [...models].sort((a, b) => a.localeCompare(b));
	}

	/** The list prices and the prices of the admin, for the settings page. */
	table() {
		return {
			listPricesDate: LIST_PRICES_DATE,
			listPrices: LIST_PRICES,
			adminPrices: this.settings.current().prices,
		};
	}

	private lookup(slug: string, model: string) {
		return (
			findPrice(this.settings.current().prices[slug], model) ?? findPrice(LIST_PRICES[slug], model)
		);
	}
}
