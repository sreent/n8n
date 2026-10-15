import { UrlService } from '@n8n/backend-services';
import { WorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { NotFoundError } from '@n8n/errors';
import { ExecutionContextService } from 'n8n-core';
import type {
	CredentialCheckOptions,
	CredentialCheckResult,
	CredentialCheckStatus,
	DynamicCredentialCheckProxyProvider,
	ICredentialContext,
} from 'n8n-workflow';

import { LoadNodesAndCredentials } from '@/load-nodes-and-credentials';

import { AuthorizeIntentService } from './authorize-intent.service';
import { DynamicCredentialWebService } from './dynamic-credential-web.service';
import { N8NIdentifier, isN8nIdentity } from '../credential-resolvers/identifiers/n8n-identifier';
import { extractToken } from '../credential-resolvers/identifiers/oauth2-utils';

/**
 * The credential check of the module context: the forms and the Dynamic Credential Check node
 * ask whether the identity of a run has connected each private credential of the workflow. A
 * missing credential gets an authorization link for that identity.
 */
@Service()
export class CredentialCheckProxyService implements DynamicCredentialCheckProxyProvider {
	constructor(
		private readonly workflowRepository: WorkflowRepository,
		private readonly executionContextService: ExecutionContextService,
		private readonly web: DynamicCredentialWebService,
		private readonly intents: AuthorizeIntentService,
		private readonly identifier: N8NIdentifier,
		private readonly loadNodesAndCredentials: LoadNodesAndCredentials,
		private readonly urlService: UrlService,
	) {}

	async checkCredentialStatus(
		workflowId: string,
		executionContext: { credentials?: string },
		options?: CredentialCheckOptions,
	): Promise<CredentialCheckResult> {
		if (!executionContext.credentials) {
			throw new Error(
				'Execution context is present but contains no credential context. Ensure credential context establishment hooks are configured for this workflow.',
			);
		}
		const context = await this.executionContextService.decryptCredentialContext(
			executionContext.credentials,
		);
		const workflow = await this.workflowRepository.findOneBy({ id: workflowId });
		if (!workflow) throw new NotFoundError('Workflow not found');

		const statuses = await this.web.statusesOf(
			options?.rootNodes ?? workflow.nodes,
			workflow.settings,
			context,
		);
		const credentials: CredentialCheckStatus[] = [];
		for (const { credential, resolverId, status } of statuses) {
			const iconUrl = this.iconUrlOf(credential.type);
			const base = {
				credentialId: credential.id,
				credentialName: credential.name,
				credentialType: credential.type,
				...(resolverId ? { resolverId } : {}),
				status,
				...(iconUrl ? { iconUrl } : {}),
			};
			if (status === 'configured' && resolverId) {
				credentials.push({
					...base,
					revokeUrl: `${this.web.restUrl}/credentials/${credential.id}/revoke?resolverId=${resolverId}`,
				});
			} else if (status === 'missing' && resolverId) {
				const token = await this.createIntent(credential.id, resolverId, context);
				credentials.push({
					...base,
					authorizationUrl: `${this.web.restUrl}/credentials/${credential.id}/authorize?token=${token}`,
				});
			} else {
				credentials.push(base);
			}
		}
		return {
			readyToExecute: credentials.every(({ status }) => status === 'configured'),
			credentials,
		};
	}

	/** An authorization link for the identity of the run. */
	private async createIntent(
		credentialId: string,
		resolverId: string,
		context: ICredentialContext,
	) {
		if (isN8nIdentity(context)) {
			const userId = await this.identifier.identify(context);
			return await this.intents.create({ credentialId, resolverId, userId });
		}
		return await this.intents.create({
			credentialId,
			resolverId,
			authorizationHeader: `Bearer ${extractToken(context.identity)}`,
			authMetadata: context.metadata ?? {},
		});
	}

	/** The absolute URL of the icon of a credential type, when the type has one. */
	private iconUrlOf(credentialType: string) {
		const description = this.loadNodesAndCredentials.types.credentials.find(
			({ name }) => name === credentialType,
		);
		const iconUrl = description?.iconUrl;
		const path = typeof iconUrl === 'string' ? iconUrl : iconUrl?.light;
		return path ? `${this.urlService.getInstanceBaseUrl()}/${path}` : undefined;
	}
}
