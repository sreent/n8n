import { Z } from '@n8n/api-types';
import { z } from 'zod';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './audit-log.constants';

const dateTime = z
	.string()
	.datetime({ offset: true })
	.transform((value) => new Date(value));

/** A query parameter with a whole number, or the default when the request leaves it out. */
const wholeNumber = (defaultValue: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
	z
		.string()
		.regex(/^\d+$/, 'Must be a whole number')
		.optional()
		.transform((value) => (value === undefined ? defaultValue : Number(value)))
		.refine((value) => value >= min, `Must be at least ${min}`)
		.transform((value) => Math.min(value, max));

const filterSchema = {
	from: dateTime.optional(),
	to: dateTime.optional(),
	/** An event name, or a prefix that ends with a dot, for example `n8n.audit.user.`. */
	eventName: z.string().trim().min(1).max(128).optional(),
	userId: z.string().trim().min(1).max(36).optional(),
};

export class AuditLogEventsQueryDto extends Z.class({
	...filterSchema,
	skip: wholeNumber(0, 0),
	take: wholeNumber(DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
}) {}

export class AuditLogExportQueryDto extends Z.class({
	...filterSchema,
	format: z.enum(['csv', 'json']).default('csv'),
}) {}
