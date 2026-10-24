// Fork code (not in upstream n8n): the checkout, the change list, Promote and Apply of a Git
// connection. Upstream n8n gave the DTOs of these operations an environment ID when it replaced
// Git connections with environments. The fork keeps Git connections, so it keeps the shapes with
// the connection ID and the config ID here, under names of their own. The shapes are the upstream
// shapes before environments. See packages/cli/src/modules/promotions/README.md.
import { z } from 'zod';

import { promotableResourceSchema } from './promotable-resource.dto';
import {
	promotionBindingPreflightResultSchema,
	promotionBindingWarningSchema,
} from './promotion-binding-preflight.dto';
import { promotionDirectionSchema } from './promotion-environment.dto';
import { promotePackageCountsSchema, promotionGitResultSchema } from './promotion-operations.dto';
import { n8nIdSchema } from '../../schemas/id.schema';
import { Z } from '../../zod-class';

/**
 * The local checkout of one direction, after a clone or a disconnect. It reports
 * the instance that handled the request. Other replicas may hold a different
 * checkout, so this never says the whole deployment is ready.
 */
export const promotionConnectionCheckoutPublicSchema = z.object({
	connectionId: n8nIdSchema,
	configId: n8nIdSchema,
	direction: promotionDirectionSchema,
	/** Apply tracks the branch it imports from, Promote the branch it starts from. */
	branchName: z.string(),
	hasCheckout: z.boolean(),
});

export class PromotionConnectionCheckoutPublicDto extends Z.class(
	promotionConnectionCheckoutPublicSchema.shape,
) {}

export const promotionConnectionChangesSchema = z.object({
	commitSha: z.string().nullable(),
	changes: promotableResourceSchema.array(),
});

export type PromotionConnectionChanges = z.infer<typeof promotionConnectionChangesSchema>;

export class PromotionConnectionChangesDto extends Z.class(
	promotionConnectionChangesSchema.shape,
) {}

/** Describes the instance that handled the request, not any other instance. */
export const promotionConnectionPromoteResultSchema = z.object({
	connectionId: n8nIdSchema,
	configId: n8nIdSchema,
	counts: promotePackageCountsSchema,
	git: promotionGitResultSchema,
});

export class PromotionConnectionPromoteResultDto extends Z.class(
	promotionConnectionPromoteResultSchema.shape,
) {}

const count = () => z.number().int().nonnegative();

/** What the import changed. Partial results are visible here too. */
export const promotionConnectionApplyCountsSchema = z.object({
	projects: z.object({ created: count(), updated: count(), skipped: count(), deleted: count() }),
	folders: z.object({ created: count(), skipped: count(), removed: count() }),
	workflows: z.object({
		created: count(),
		updated: count(),
		skipped: count(),
		archived: count(),
		deleted: count(),
		publishing: z.object({
			published: count(),
			unpublished: count(),
			unchanged: count(),
			blocked: count(),
			failed: count(),
		}),
	}),
	credentials: z.object({ matched: count(), stubbed: count() }),
	dataTables: z.object({ matched: count(), created: count() }),
	variables: z.object({
		matched: count(),
		created: count(),
		updated: count(),
		stubbed: count(),
		missing: count(),
	}),
	tags: z.object({
		matched: count(),
		created: count(),
		renamed: count(),
		reconciled: count(),
		skipped: count(),
	}),
});

const expectedSourceSchema = z
	.object({
		configId: n8nIdSchema,
		branchName: z.string().min(1),
		commitSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
	})
	.strict();

/** Apply may pin the reviewed source. Without it, the branch tip is applied. */
export class PromotionConnectionApplyDto extends Z.class(
	{ expectedSource: expectedSourceSchema.optional() },
	{ strict: true },
) {}

/** Continue must name the source that the paused Apply reported. */
export class PromotionConnectionContinueApplyDto extends Z.class(
	{ expectedSource: expectedSourceSchema },
	{ strict: true },
) {}

const applyIdentitySchema = z.object({
	connectionId: n8nIdSchema,
	configId: n8nIdSchema,
	git: promotionGitResultSchema,
});

export const promotionConnectionApplyResultSchema = z.discriminatedUnion('status', [
	applyIdentitySchema.extend({
		status: z.literal('applied'),
		counts: promotionConnectionApplyCountsSchema,
		warnings: z.array(promotionBindingWarningSchema),
	}),
	applyIdentitySchema.extend({
		status: z.literal('blocked'),
		preflight: promotionBindingPreflightResultSchema,
	}),
	applyIdentitySchema.extend({ status: z.literal('source-changed') }),
]);

export const PromotionConnectionApplyResultDto = {
	name: 'PromotionConnectionApplyResultDto',
	schema: promotionConnectionApplyResultSchema,
	parse: (value: unknown) => promotionConnectionApplyResultSchema.parse(value),
};

export type PromotionConnectionApplyResultDto = z.infer<
	typeof promotionConnectionApplyResultSchema
>;
