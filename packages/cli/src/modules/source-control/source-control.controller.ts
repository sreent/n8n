import { PullWorkFolderRequestDto, PushWorkFolderRequestDto } from '@n8n/api-types';
import { EventService } from '@n8n/backend-services';
import { AuthenticatedRequest } from '@n8n/db';
import { Body, Get, GlobalScope, Param, Patch, Post, RestController } from '@n8n/decorators';
import { hasGlobalScope } from '@n8n/permissions';
import { Response } from 'express';

import { ProjectService } from '@/services/project.service';

import { getTrackingInformationFromPullResult } from './source-control-helper';
import { SourceControlPreferencesService } from './source-control-preferences.service';
import { SourceControlScopedService } from './source-control-scoped.service';
import { sourceControlConnectedMiddleware } from './source-control.middleware';
import { SourceControlService } from './source-control.service';
import type { SourceControlPreferences } from './types/source-control-preferences';

/** The preferences that a project admin and a user without a role in source control see. */
const PROJECT_ADMIN_KEYS = ['branchReadOnly', 'connected', 'branchName', 'branchColor'] as const;
const MEMBER_KEYS = ['branchReadOnly'] as const;

function pickPreferences(
	preferences: SourceControlPreferences,
	keys: ReadonlyArray<keyof SourceControlPreferences>,
): Partial<SourceControlPreferences> {
	const result: Partial<SourceControlPreferences> = {};
	for (const key of keys) {
		if (key in preferences) Object.assign(result, { [key]: preferences[key] });
	}
	return result;
}

/** A query value as a string, when it is one. */
const queryString = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * Fork code (not in upstream n8n): the REST API of source control (`/rest/source-control`), with
 * the routes, the answers and the access rules of the original. See `README.md` in this folder.
 */
@RestController('/source-control')
export class SourceControlController {
	constructor(
		private readonly sourceControlService: SourceControlService,
		private readonly preferencesService: SourceControlPreferencesService,
		private readonly scopedService: SourceControlScopedService,
		private readonly projectService: ProjectService,
		private readonly eventService: EventService,
	) {}

	/** All preferences need `sourceControl:manage`. A project admin sees the branch. */
	@Get('/preferences')
	async getPreferences(req: AuthenticatedRequest) {
		const preferences = this.preferencesService.getPreferences();
		if (hasGlobalScope(req.user, 'sourceControl:manage')) {
			return { ...preferences, publicKey: await this.preferencesService.getPublicKey() };
		}
		const projectIds = await this.projectService.getProjectIdsWithScope(req.user, [
			'sourceControl:push',
		]);
		return pickPreferences(preferences, projectIds.length > 0 ? PROJECT_ADMIN_KEYS : MEMBER_KEYS);
	}

	@Post('/preferences')
	@GlobalScope('sourceControl:manage')
	async setPreferences(req: AuthenticatedRequest) {
		const body: unknown = req.body;
		return await this.sourceControlService.connect(req.user, body);
	}

	@Patch('/preferences')
	@GlobalScope('sourceControl:manage')
	async updatePreferences(req: AuthenticatedRequest) {
		const body: unknown = req.body;
		return await this.sourceControlService.updatePreferences(body);
	}

	@Post('/disconnect')
	@GlobalScope('sourceControl:manage')
	async disconnect(req: AuthenticatedRequest) {
		const body: unknown = req.body;
		const keepKeyPair =
			typeof body === 'object' &&
			body !== null &&
			'keepKeyPair' in body &&
			body.keepKeyPair === true;
		return await this.sourceControlService.disconnect({ keepKeyPair });
	}

	@Get('/get-branches')
	@GlobalScope('sourceControl:manage')
	async getBranches() {
		return await this.sourceControlService.getBranches();
	}

	@Post('/push-workfolder', { middlewares: [sourceControlConnectedMiddleware] })
	async pushWorkfolder(
		req: AuthenticatedRequest,
		res: Response,
		@Body payload: PushWorkFolderRequestDto,
	) {
		await this.scopedService.ensureIsAllowedToPush(req);
		const result = await this.sourceControlService.pushWorkfolder(req.user, payload);
		res.statusCode = result.statusCode;
		return { files: result.statusResult, commit: result.pushResult ?? null };
	}

	@Post('/pull-workfolder', { middlewares: [sourceControlConnectedMiddleware] })
	@GlobalScope('sourceControl:pull')
	async pullWorkfolder(
		req: AuthenticatedRequest,
		res: Response,
		@Body payload: PullWorkFolderRequestDto,
	) {
		const result = await this.sourceControlService.pullWorkfolder(req.user, payload);
		res.statusCode = result.statusCode;
		if (result.statusCode === 200) {
			this.eventService.emit(
				'source-control-user-finished-pull-ui',
				getTrackingInformationFromPullResult(req.user.id, result.statusResult),
			);
		}
		return result.statusResult;
	}

	@Get('/reset-workfolder', { middlewares: [sourceControlConnectedMiddleware] })
	@GlobalScope('sourceControl:manage')
	async resetWorkfolder() {
		await this.sourceControlService.resetWorkfolder();
	}

	/**
	 * The status for a push or a pull. `verbose=true` gives the lists of the comparison. As in the
	 * original, any value of `preferLocalVersion` counts as true, also `false`.
	 */
	@Get('/get-status', { middlewares: [sourceControlConnectedMiddleware] })
	async getStatus(req: AuthenticatedRequest) {
		await this.scopedService.ensureIsAllowedToGetStatus(req);
		const query: Record<string, unknown> = req.query;
		const direction = queryString(query.direction);
		return await this.sourceControlService.getStatus(req.user, {
			direction: direction === 'pull' ? 'pull' : 'push',
			track: direction === 'pull' || direction === 'push',
			preferLocalVersion: Boolean(queryString(query.preferLocalVersion)),
			verbose: queryString(query.verbose) === 'true',
		});
	}

	/** The status for a push, without parameters. */
	@Get('/status')
	async status(req: AuthenticatedRequest) {
		await this.scopedService.ensureIsAllowedToGetStatus(req);
		return await this.sourceControlService.getStatus(req.user, {
			direction: 'push',
			preferLocalVersion: true,
			verbose: false,
		});
	}

	@Post('/generate-key-pair')
	@GlobalScope('sourceControl:manage')
	async generateKeyPair(req: AuthenticatedRequest) {
		const body: unknown = req.body;
		const keyGeneratorType =
			typeof body === 'object' &&
			body !== null &&
			'keyGeneratorType' in body &&
			typeof body.keyGeneratorType === 'string'
				? body.keyGeneratorType
				: undefined;
		return await this.sourceControlService.generateKeyPair(keyGeneratorType);
	}

	/** The content of a workflow in the branch. The user needs access to the workflow. */
	@Get('/remote-content/:type/:id', { middlewares: [sourceControlConnectedMiddleware] })
	async getFileContent(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('type') type: string,
		@Param('id') id: string,
	) {
		if (type === 'workflow') await this.scopedService.ensureIsAllowedToReadWorkflow(req.user, id);
		return await this.sourceControlService.getRemoteFileEntity(type, id);
	}
}
