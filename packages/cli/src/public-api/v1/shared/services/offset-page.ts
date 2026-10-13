// Fork code (not in upstream n8n): a check of the page of a fork route of the public API.
import { MAX_ITEMS_PER_PAGE } from '@n8n/api-types';
import { BadRequestError } from '@n8n/errors';

/**
 * A client can change the cursor, and `limit=0` reads without a limit. A page of a fork route must
 * have 1 to 250 items, from an offset that is a whole number of 0 or more.
 */
export function assertOffsetPage({ offset, limit }: { offset: number; limit: number }) {
	const valid =
		Number.isSafeInteger(offset) &&
		offset >= 0 &&
		Number.isSafeInteger(limit) &&
		limit >= 1 &&
		limit <= MAX_ITEMS_PER_PAGE;
	if (!valid) {
		throw new BadRequestError(
			`The limit must be 1 to ${MAX_ITEMS_PER_PAGE}, and the cursor must come from a previous page`,
		);
	}
}
