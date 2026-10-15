import type { WorkflowExecutionStatus } from '@n8n/api-types';
import { UrlService } from '@n8n/backend-services';
import { GlobalConfig } from '@n8n/config';
import type { CredentialsEntity, User } from '@n8n/db';
import { CredentialsRepository, WorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { AuthError, BadRequestError, NotFoundError } from '@n8n/errors';
import type { Request, Response } from 'express';
import type { ICredentialContext, INode, IWorkflowSettings } from 'n8n-workflow';

import { AuthService } from '@/auth/auth.service';
import { OauthService } from '@/oauth/oauth.service';
import type { CreateCsrfStateData } from '@/oauth/types';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import { DynamicCredentialService, type ResolverWithHandle } from './dynamic-credential.service';
import { SYSTEM_RESOLVER_TYPE } from '../constants';
import { isN8nIdentity } from '../credential-resolvers/identifiers/n8n-identifier';
import { N8nIdentityNotSupportedError } from '../errors/n8n-identity-not-supported.error';

/** The identity of a request to an endpoint, and how the OAuth flow carries it to the callback. */
export type RequestIdentity = {
	context: ICredentialContext;
	/** The `Authorization` value that the OAuth state carries. */
	authorizationHeader: string;
	authMetadata: Record<string, unknown>;
	userId?: string;
};

export type CredentialStatus = 'missing' | 'configured' | 'resolver_missing';

export type CredentialStatusEntry = {
	credential: CredentialsEntity;
	resolverId: string | null;
	status: CredentialStatus;
};

const BEARER = /^bearer\s+(.+)$/i;

/** The work of the endpoints that external applications and the editor call. */
@Service()
export class DynamicCredentialWebService {
	constructor(
		private readonly authService: AuthService,
		private readonly dynamicCredentialService: DynamicCredentialService,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly workflowRepository: WorkflowRepository,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly oauthService: OauthService,
		private readonly urlService: UrlService,
		private readonly globalConfig: GlobalConfig,
	) {}

	/** The base URL of the REST API. */
	get restUrl() {
		return `${this.urlService.getInstanceBaseUrl()}/${this.globalConfig.endpoints.rest}`;
	}

	/**
	 * The identity of a request. `bearer` takes the token of the `Authorization` header, `cookie`
	 * takes the n8n session. Without a choice, a request with a bearer token uses it.
	 */
	identityOf(req: Request, authSource: unknown, user?: User): RequestIdentity {
		const bearer = BEARER.exec(req.headers.authorization ?? '')?.[1];
		const useBearer = authSource === 'bearer' || (authSource !== 'cookie' && bearer !== undefined);
		if (useBearer) {
			if (!bearer) throw new AuthError('Bearer token is missing');
			const metadata = { source: 'http-header', headerName: 'authorization' };
			return {
				context: { version: 1, identity: bearer, metadata },
				authorizationHeader: `Bearer ${bearer}`,
				authMetadata: metadata,
				userId: user?.id,
			};
		}
		const cookie = this.authService.getCookieToken(req);
		if (!user || !cookie) throw new AuthError('Session cookie is missing');
		const metadata = { source: 'manual-execution' };
		return {
			context: { version: 1, identity: cookie, metadata },
			authorizationHeader: `Bearer ${cookie}`,
			authMetadata: metadata,
			userId: user.id,
		};
	}

	/** The private credentials of the nodes, each one time, in the order of the nodes. */
	async privateCredentialsOf(nodes: INode[]) {
		const ids = [
			...new Set(
				nodes
					.filter((node) => node.disabled !== true)
					.flatMap((node) => Object.values(node.credentials ?? {}))
					.map((reference) => reference.id)
					.filter((id): id is string => typeof id === 'string'),
			),
		];
		if (ids.length === 0) return [];
		const byId = new Map(
			(await this.credentialsRepository.getManyByIds(ids)).map((credential) => [
				credential.id,
				credential,
			]),
		);
		return ids
			.map((id) => byId.get(id))
			.filter((credential): credential is CredentialsEntity => credential?.isResolvable === true);
	}

	/** Whether the identity has data for each private credential of the nodes. */
	async statusesOf(
		nodes: INode[],
		settings: IWorkflowSettings | undefined,
		context: ICredentialContext,
	): Promise<CredentialStatusEntry[]> {
		const statuses: CredentialStatusEntry[] = [];
		for (const credential of await this.privateCredentialsOf(nodes)) {
			const resolverId = this.dynamicCredentialService.effectiveResolverId(
				credential.resolverId,
				settings,
			);
			const found = resolverId
				? await this.dynamicCredentialService.findResolver(resolverId)
				: undefined;
			statuses.push({
				credential,
				resolverId,
				status: found ? await this.statusWith(found, credential.id, context) : 'resolver_missing',
			});
		}
		return statuses;
	}

	private async statusWith(
		found: ResolverWithHandle,
		credentialId: string,
		context: ICredentialContext,
	): Promise<CredentialStatus> {
		if (found.entity.type !== SYSTEM_RESOLVER_TYPE && isN8nIdentity(context)) {
			return 'resolver_missing';
		}
		try {
			await found.resolver.getSecret(credentialId, context, found.handle);
			return 'configured';
		} catch {
			return 'missing';
		}
	}

	/** The status of the private credentials of a workflow for the identity of a request. */
	async workflowStatus(
		workflowId: string,
		identity: RequestIdentity,
		user?: User,
	): Promise<WorkflowExecutionStatus> {
		const workflow = user
			? await this.workflowFinderService.findWorkflowForUser(workflowId, user, ['workflow:read'])
			: await this.workflowRepository.findOneBy({ id: workflowId });
		if (!workflow) throw new NotFoundError('Workflow not found');

		const statuses = await this.statusesOf(workflow.nodes, workflow.settings, identity.context);
		return {
			workflowId: workflow.id,
			readyToExecute: statuses.every(({ status }) => status === 'configured'),
			credentials: statuses.map(({ credential, resolverId, status }) => ({
				credentialId: credential.id,
				credentialName: credential.name,
				credentialStatus: status,
				credentialType: credential.type,
				...(status !== 'resolver_missing' && resolverId
					? {
							authorizationUrl: `${this.restUrl}/credentials/${credential.id}/authorize?resolverId=${resolverId}`,
							revokeUrl: `${this.restUrl}/credentials/${credential.id}/revoke?resolverId=${resolverId}`,
						}
					: {}),
			})),
		};
	}

	/** The resolver and the private credential of an authorize or revoke request. */
	async target(credentialId: string, resolverId: unknown) {
		if (typeof resolverId !== 'string' || resolverId.length === 0) {
			throw new BadRequestError('Missing resolverId query parameter');
		}
		const found = await this.dynamicCredentialService.findResolver(resolverId);
		if (!found) throw new NotFoundError('Resolver not found');
		const credential = await this.credentialsRepository.findOneBy({ id: credentialId });
		if (!credential?.isResolvable) throw new NotFoundError('Credential not found');
		return { found, credential };
	}

	/** Refuses an n8n identity for a resolver that keys its data by external users. */
	checkIdentity(
		found: ResolverWithHandle,
		credential: CredentialsEntity,
		identity: RequestIdentity,
	) {
		if (found.entity.type !== SYSTEM_RESOLVER_TYPE && isN8nIdentity(identity.context)) {
			throw new BadRequestError(new N8nIdentityNotSupportedError(credential.name).message);
		}
	}

	/** The URL of the identity provider that starts the OAuth flow of the identity. */
	async authorizationUrl(
		req: Request,
		res: Response,
		credential: CredentialsEntity,
		resolverId: string,
		identity: Omit<RequestIdentity, 'context'>,
	) {
		const csrfData: CreateCsrfStateData = {
			cid: credential.id,
			origin: 'dynamic-credential',
			credentialResolverId: resolverId,
			authorizationHeader: identity.authorizationHeader,
			authMetadata: identity.authMetadata,
			...(identity.userId ? { userId: identity.userId } : {}),
		};
		return await this.oauthService.generateAOauth2AuthUri(credential, csrfData, req, res);
	}
}
