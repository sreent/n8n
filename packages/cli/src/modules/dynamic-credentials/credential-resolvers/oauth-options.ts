import { z } from 'zod';

const metadataUri = z.string().url();
const expectedAudience = z.string().optional();
const subjectClaim = z.string().optional();

/** The options of an OAuth2 resolver that validates tokens at the introspection endpoint. */
export const oauthIntrospectionOptionsSchema = z.object({
	metadataUri,
	validation: z.literal('oauth2-introspection'),
	clientId: z.string(),
	clientSecret: z.string(),
	expectedAudience,
	subjectClaim,
});

/** The options of an OAuth2 resolver that validates tokens at the userinfo endpoint. */
export const oauthUserInfoOptionsSchema = z.object({
	metadataUri,
	validation: z.literal('oauth2-userinfo'),
	clientId: z.string().optional(),
	clientSecret: z.string().optional(),
	expectedAudience,
	subjectClaim,
});

export const oauthResolverOptionsSchema = z.discriminatedUnion('validation', [
	oauthIntrospectionOptionsSchema,
	oauthUserInfoOptionsSchema,
]);

export type OAuthResolverOptions = z.infer<typeof oauthResolverOptionsSchema>;

/** The options of a Slack resolver. */
export const slackResolverOptionsSchema = z.object({
	signingSecret: z.string().min(1, 'Slack signing secret is required'),
	subjectClaim: z.enum(['user_id', 'team_user']).optional(),
});
