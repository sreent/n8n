import { BadRequestError } from '@n8n/errors';

/**
 * Fork code (not in upstream n8n): the opaque cursors of the inbox and of the activity feed. The
 * clients only send a cursor back, so the format is free. See `README.md`.
 */

const INVALID_CURSOR = 'Invalid pagination cursor';

function encode(value: unknown) {
	return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(cursor: string): unknown {
	try {
		return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
	} catch {
		throw new BadRequestError(INVALID_CURSOR);
	}
}

/** The inbox pages by creation time, then by id: the cursor holds both of the last item. */
export function encodeInboxCursor(createdAt: Date, id: string) {
	return encode({ c: createdAt.toISOString(), i: id });
}

export function decodeInboxCursor(cursor: string): { createdAt: Date; id: string } {
	const value = decode(cursor);
	if (value !== null && typeof value === 'object' && 'c' in value && 'i' in value) {
		const { c, i } = value;
		const createdAt = typeof c === 'string' ? new Date(c) : null;
		if (createdAt && !Number.isNaN(createdAt.getTime()) && typeof i === 'string' && i !== '') {
			return { createdAt, id: i };
		}
	}
	throw new BadRequestError(INVALID_CURSOR);
}

/** The feed pages backwards: the cursor holds the id of the oldest entry of the page. */
export function encodeActivityCursor(beforeId: number) {
	return encode({ b: beforeId });
}

export function decodeActivityCursor(cursor: string): number {
	const value = decode(cursor);
	if (value !== null && typeof value === 'object' && 'b' in value) {
		const { b } = value;
		if (typeof b === 'number' && Number.isInteger(b) && b > 0) return b;
	}
	throw new BadRequestError(INVALID_CURSOR);
}
