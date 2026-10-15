import { Z } from '@n8n/api-types';
import { z } from 'zod';

import { aiGatewaySettingsSchema } from './ai-gateway-settings.service';

const dateTime = z
	.string()
	.datetime({ offset: true })
	.transform((value) => new Date(value));

/** A query parameter with a whole number, or the default when the request leaves it out. */
const wholeNumber = (defaultValue: number, min: number, max: number) =>
	z
		.string()
		.regex(/^\d+$/, 'Must be a whole number')
		.optional()
		.transform((value) => (value === undefined ? defaultValue : Number(value)))
		.refine((value) => value >= min, `Must be at least ${min}`)
		.transform((value) => Math.min(value, max));

export class AiGatewaySettingsDto extends Z.class(aiGatewaySettingsSchema.shape) {}

export class AiGatewayTopUpDto extends Z.class({
	amount: z.number().finite().positive().max(1_000_000),
	note: z.string().trim().max(255).optional(),
}) {}

export class AiGatewayUsageQueryDto extends Z.class({
	from: dateTime.optional(),
	to: dateTime.optional(),
	userId: z.string().trim().min(1).max(36).optional(),
	projectId: z.string().trim().min(1).max(36).optional(),
	provider: z.string().trim().min(1).max(64).optional(),
	model: z.string().trim().min(1).max(255).optional(),
	skip: wholeNumber(0, 0, Number.MAX_SAFE_INTEGER),
	take: wholeNumber(50, 1, 250),
}) {}
