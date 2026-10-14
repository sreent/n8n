/**
 * A write that a unique index or a foreign key of the promotion tables refused, because another
 * request changed the same rows. The services turn it into an answer with the status 409.
 */
export class PromotionRowConflictError extends Error {}
