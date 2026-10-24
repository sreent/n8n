// Fork: upstream n8n removed this file when it replaced Git connections with environments. The
// fork keeps Git connections, so it keeps the DTOs of their configs. The direction and the settings
// of a direction have the same schemas as the settings of an environment, so this file takes them
// from `promotion-environment.dto.ts`. See packages/cli/src/modules/promotions/README.md.
import { z } from 'zod';

import { promotionDisplayNameSchema } from './promotion-common.dto';
import {
	promotionGitApplySettingsSchema,
	promotionGitPromoteSettingsSchema,
} from './promotion-environment.dto';
import { n8nIdSchema } from '../../schemas/id.schema';
import { Z } from '../../zod-class';

/**
 * Settings schema for each direction. Use this map when the direction is known,
 * such as when checking a stored row. A new provider type adds its own map, with
 * its own fields and no branch name.
 */
export const promotionGitSettingsSchemas = {
	apply: promotionGitApplySettingsSchema,
	promote: promotionGitPromoteSettingsSchema,
} as const;

export const promotionConfigSettingsSchema = z.union([
	promotionGitApplySettingsSchema,
	promotionGitPromoteSettingsSchema,
]);
export type PromotionConfigSettings = z.infer<typeof promotionConfigSettingsSchema>;

/*
 * Request bodies for `PUT /connections/:id/configs/:direction`, which creates the
 * config or replaces it. The direction is in the path, so the body needs no
 * discriminator and each direction gets a plain object of its own.
 *
 * A write replaces the whole config. An omitted `name` resets it to the direction
 * label, so a client changing only a branch has to resend the name it wants to
 * keep. The connection-create payload reuses these same two schemas.
 */

export class UpsertPromotionApplyConfigDto extends Z.class(
	{
		name: promotionDisplayNameSchema.optional(),
		settings: promotionGitApplySettingsSchema,
	},
	{ strict: true },
) {}

export class UpsertPromotionPromoteConfigDto extends Z.class(
	{
		name: promotionDisplayNameSchema.optional(),
		settings: promotionGitPromoteSettingsSchema,
	},
	{ strict: true },
) {}

/**
 * The local checkout state of one direction on the instance that answered. A
 * package operation needs a checkout that was cloned from the current remote and
 * branch, so both flags report on this replica only. Other replicas may differ.
 */
export const promotionConfigCheckoutSchema = z.object({
	/** A local checkout exists for this direction on this instance. */
	hasCheckout: z.boolean(),
	/** The checkout was cloned from the current remote and branch, so it is not stale. */
	matchesConfig: z.boolean(),
});
export type PromotionConfigCheckout = z.infer<typeof promotionConfigCheckoutSchema>;

const configPublicFields = {
	/**
	 * Also names the local checkout directory. Stable while the config exists, and
	 * replaced by a new one if the direction is deleted and set up again.
	 */
	id: n8nIdSchema,
	name: z.string(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	checkout: promotionConfigCheckoutSchema,
};

/*
 * Responses leave out the connection and the direction: both are the address the
 * caller already used.
 */

export const promotionApplyConfigPublicSchema = z.object({
	...configPublicFields,
	settings: promotionGitApplySettingsSchema,
});

export class PromotionApplyConfigPublicDto extends Z.class(
	promotionApplyConfigPublicSchema.shape,
) {}

export const promotionPromoteConfigPublicSchema = z.object({
	...configPublicFields,
	settings: promotionGitPromoteSettingsSchema,
});

export class PromotionPromoteConfigPublicDto extends Z.class(
	promotionPromoteConfigPublicSchema.shape,
) {}

/**
 * Configs keyed by direction, so a client reads `configs.promote?.settings`
 * without narrowing a union. A missing key means that direction is not set up.
 */
export const promotionConnectionConfigsPublicSchema = z.object({
	apply: promotionApplyConfigPublicSchema.optional(),
	promote: promotionPromoteConfigPublicSchema.optional(),
});
export type PromotionConnectionConfigsPublic = z.infer<
	typeof promotionConnectionConfigsPublicSchema
>;

/** List responses contain stored config fields only. */
export const promotionApplyConfigSummarySchema = promotionApplyConfigPublicSchema.omit({
	checkout: true,
});

export const promotionPromoteConfigSummarySchema = promotionPromoteConfigPublicSchema.omit({
	checkout: true,
});

export const promotionConnectionConfigsSummarySchema = z.object({
	apply: promotionApplyConfigSummarySchema.optional(),
	promote: promotionPromoteConfigSummarySchema.optional(),
});
export type PromotionConnectionConfigsSummary = z.infer<
	typeof promotionConnectionConfigsSummarySchema
>;
