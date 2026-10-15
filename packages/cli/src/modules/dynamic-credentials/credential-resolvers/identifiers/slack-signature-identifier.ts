import { createHmac, timingSafeEqual } from 'node:crypto';

import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import type { ICredentialContext } from 'n8n-workflow';

import {
	IdentifierValidationError,
	type IdentifierOptions,
	type ITokenIdentifier,
} from './identifier-interface';
import { slackResolverOptionsSchema } from '../oauth-options';

/** Slack rejects requests that are older than five minutes, and so does the identifier. */
const MAX_REQUEST_AGE_SECONDS = 5 * 60;

/**
 * Verifies the signature of a Slack request (the signing secret of the Slack app over the
 * timestamp and the raw body), and gives the Slack user of the request, optionally with the team.
 */
@Service()
export class SlackSignatureIdentifier implements ITokenIdentifier {
	constructor(private readonly logger: Logger) {}

	/** Verifies the age and the signature of the request, then gives its subject. */
	async resolve(context: ICredentialContext, identifierOptions: IdentifierOptions) {
		const options = slackResolverOptionsSchema.parse(identifierOptions);
		const { timestampText, signature } = this.signatureData(context);

		const timestamp = Number(timestampText);
		if (timestampText.trim() === '' || !Number.isFinite(timestamp)) {
			throw new IdentifierValidationError('Invalid Slack request timestamp');
		}
		if (Math.abs(Date.now() / 1000 - timestamp) > MAX_REQUEST_AGE_SECONDS) {
			throw new IdentifierValidationError('Slack request timestamp is too old');
		}

		const expected = `v0=${createHmac('sha256', options.signingSecret)
			.update(`v0:${timestampText}:${context.identity}`)
			.digest('hex')}`;
		const given = Buffer.from(signature);
		const wanted = Buffer.from(expected);
		if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
			throw new IdentifierValidationError('Slack signature verification failed');
		}
		this.logger.debug('Slack signature verified');

		return this.subjectOf(context.identity, options.subjectClaim);
	}

	/**
	 * Gives the subject of the request without a check of its age and signature. A store gets the
	 * context of a request that n8n verified before, for example at the end of an OAuth flow that
	 * started more than five minutes after the request. n8n builds that context on the server and
	 * keeps it encrypted.
	 */
	resolveKey(context: ICredentialContext, identifierOptions: IdentifierOptions) {
		const options = slackResolverOptionsSchema.parse(identifierOptions);
		this.signatureData(context);
		return this.subjectOf(context.identity, options.subjectClaim);
	}

	private signatureData(context: ICredentialContext) {
		const metadata = context.metadata;
		const timestampText = metadata?.timestamp;
		const signature = metadata?.signature;
		if (
			metadata?.source !== 'slack-signature' ||
			typeof timestampText !== 'string' ||
			typeof signature !== 'string'
		) {
			throw new IdentifierValidationError('Missing Slack signature verification data');
		}
		return { timestampText, signature };
	}

	private subjectOf(identity: string, subjectClaim: 'user_id' | 'team_user' | undefined) {
		const fields = new URLSearchParams(identity);
		const userId = fields.get('user_id');
		if (!userId) throw new IdentifierValidationError('Slack user_id not found in identity');
		if (subjectClaim === 'team_user') {
			const teamId = fields.get('team_id');
			if (!teamId) {
				throw new IdentifierValidationError('Slack team_id not found for team_user claim');
			}
			return `${teamId}:${userId}`;
		}
		return userId;
	}
}
