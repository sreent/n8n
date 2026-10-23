// Fork code (not in upstream n8n): the query parameters of the REST APIs of the fork modules.
import { z } from 'zod';

/**
 * A time in ISO 8601 with an offset, as a `Date`. `.datetime()` only checks the pattern, so an
 * impossible offset such as `+99:99` passes it; the refine rejects those values.
 */
export const dateTimeQueryParamSchema = z
	.string()
	.datetime({ offset: true })
	.refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid datetime')
	.transform((value) => new Date(value));

/**
 * A whole number, or the default when the request leaves it out. A value above `max` becomes
 * `max`. Unlike `take` of `PaginationDto`, a page size of 0 is not valid: TypeORM reads all rows
 * for `take: 0`.
 */
export const wholeNumberQueryParamSchema = (
	defaultValue: number,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
) =>
	z
		.string()
		.regex(/^\d+$/, 'Must be a whole number')
		.optional()
		.transform((value) => (value === undefined ? defaultValue : Number(value)))
		.refine((value) => value >= min, `Must be at least ${min}`)
		.transform((value) => Math.min(value, max));
