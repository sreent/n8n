// Fork code (not in upstream n8n): the create and update bodies of a provider of Git connections.
// Upstream n8n added Git hosts (GitLab) to the providers of environments, with a base URL and an
// optional username. The fork keeps Git connections with plain Git, so it keeps the bodies from
// before that change here, under names of their own. The shapes are the upstream shapes before
// Git hosts. See packages/cli/src/modules/promotions/README.md.
import { z } from 'zod';

import { promotionDisplayNameSchema } from './promotion-common.dto';
import {
	promotionGitSshKeyAuthInputSchema,
	promotionGitSshKeyAuthUpdateSchema,
} from './promotion-provider.dto';
import { Z } from '../../zod-class';

// Trim the username, so a padded value is never saved.
const usernameSchema = z.string().trim().min(1);
// Do not trim the password. A token is saved exactly as sent, and a blank one is rejected.
const secretSchema = z.string().min(1);

/** Username and password are required together, on create and on update. */
export const promotionConnectionTokenAuthInputSchema = z
	.object({
		authType: z.literal('token'),
		username: usernameSchema,
		password: secretSchema,
	})
	.strict();

export const promotionConnectionProviderAuthInputSchema = z.discriminatedUnion('authType', [
	promotionGitSshKeyAuthInputSchema,
	promotionConnectionTokenAuthInputSchema,
]);
export type PromotionConnectionProviderAuthInput = z.infer<
	typeof promotionConnectionProviderAuthInputSchema
>;

export const promotionConnectionProviderAuthUpdateSchema = z.discriminatedUnion('authType', [
	promotionGitSshKeyAuthUpdateSchema,
	promotionConnectionTokenAuthInputSchema,
]);
export type PromotionConnectionProviderAuthUpdate = z.infer<
	typeof promotionConnectionProviderAuthUpdateSchema
>;

/**
 * The auth type is stated once, inside `auth`, so it always matches the credentials beside it.
 * The service reads it from there for the `authType` column. `git` is the only provider type of
 * Git connections.
 */
export class CreatePromotionConnectionProviderDto extends Z.class(
	{
		name: promotionDisplayNameSchema,
		type: z.enum(['git']),
		auth: promotionConnectionProviderAuthInputSchema,
	},
	{ strict: true },
) {}

/**
 * `type` cannot change and `config` holds generated key material, so a strict shape rejects
 * both. Leaving out `auth` keeps the stored credentials. Sending it replaces them. The service
 * rejects a change of the auth type, and an SSH update without `keyType` keeps the key type of
 * the provider.
 */
const updatePromotionConnectionProviderSchema = z
	.object({
		name: promotionDisplayNameSchema.optional(),
		auth: promotionConnectionProviderAuthUpdateSchema.optional(),
	})
	.strict()
	.refine(({ name, auth }) => name !== undefined || auth !== undefined, {
		message: 'At least one field is required',
	})
	.openapi({ minProperties: 1 });

type UpdatePromotionConnectionProvider = z.infer<typeof updatePromotionConnectionProviderSchema>;

export class UpdatePromotionConnectionProviderDto implements UpdatePromotionConnectionProvider {
	name?: string;

	auth?: PromotionConnectionProviderAuthUpdate;

	static schema = updatePromotionConnectionProviderSchema;

	constructor(data: UpdatePromotionConnectionProvider) {
		Object.assign(this, updatePromotionConnectionProviderSchema.parse(data));
	}

	static safeParse(data: unknown) {
		return updatePromotionConnectionProviderSchema.safeParse(data);
	}

	static parse(data: unknown) {
		return updatePromotionConnectionProviderSchema.parse(data);
	}
}
