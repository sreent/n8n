import type { AiGatewayPrice, AiGatewayPrices } from '@n8n/api-types';

/** An amount in US dollars, with two decimals, or more for a small amount. */
export function formatUsd(value: number, maximumFractionDigits = 2) {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2,
		maximumFractionDigits: Math.max(2, maximumFractionDigits),
	}).format(value);
}

/** A time in the locale and the time zone of the browser. */
export function formatDateTime(value: string | number, locale?: string) {
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
		new Date(value),
	);
}

/** A day in UTC, for the start and the end of the budget month. */
export function formatUtcDay(value: string | number, locale?: string) {
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
		new Date(value),
	);
}

export interface AiGatewayPriceRow {
	provider: string;
	model: string;
	price: AiGatewayPrice;
	/** `admin` when an admin set the price. It then replaces the list price. */
	source: 'list' | 'admin';
	/** The list price that the price of the admin replaces. */
	listPrice?: AiGatewayPrice;
}

/** The list prices and the prices of the admin as one list, by provider and model. */
export function priceRows(listPrices: AiGatewayPrices, adminPrices: AiGatewayPrices) {
	const rows: AiGatewayPriceRow[] = [];
	const providers = new Set([...Object.keys(listPrices), ...Object.keys(adminPrices)]);
	for (const provider of providers) {
		const list = listPrices[provider] ?? {};
		const admin = adminPrices[provider] ?? {};
		const models = new Set([...Object.keys(list), ...Object.keys(admin)]);
		for (const model of models) {
			const adminPrice = admin[model];
			const listPrice = list[model];
			if (adminPrice) {
				rows.push({
					provider,
					model,
					price: adminPrice,
					source: 'admin',
					...(listPrice ? { listPrice } : {}),
				});
			} else if (listPrice) {
				rows.push({ provider, model, price: listPrice, source: 'list' });
			}
		}
	}
	return rows.sort((a, b) =>
		a.provider === b.provider
			? a.model.localeCompare(b.model)
			: a.provider.localeCompare(b.provider),
	);
}

/** The prices of the admin with one price set, or removed when `price` is `undefined`. */
export function withAdminPrice(
	adminPrices: AiGatewayPrices,
	provider: string,
	model: string,
	price: AiGatewayPrice | undefined,
) {
	const models = { ...(adminPrices[provider] ?? {}) };
	if (price) models[model] = price;
	else delete models[model];
	const next = { ...adminPrices };
	if (Object.keys(models).length > 0) next[provider] = models;
	else delete next[provider];
	return next;
}

/** The deployment names of a text with commas, spaces or line breaks, without duplicates. */
export function parseDeployments(text: string) {
	return [...new Set(text.split(/[\s,]+/).filter((name) => name.length > 0))];
}

/**
 * The processors of Document AI of a text with commas, spaces or line breaks, without duplicates.
 * A prediction endpoint from the Google Cloud console
 * (`https://us-documentai.googleapis.com/v1/projects/…/processors/<ID>:process`) gives its
 * resource name.
 */
export function parseDocumentAiProcessors(text: string) {
	const entries = text
		.split(/[\s,]+/)
		.map((entry) =>
			entry
				.replace(/^https:\/\/[^/]+\/v1\//i, '')
				.replace(/:process$/, '')
				.replace(/\/+$/, ''),
		)
		.filter((entry) => entry.length > 0);
	return [...new Set(entries)];
}
