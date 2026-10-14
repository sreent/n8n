import type { GitCommitInfo, SourceControlledFile } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { EventService } from '@n8n/backend-services';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import { OnPubSubEvent } from '@n8n/decorators';
import { BadRequestError } from '@n8n/errors';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { mkdir, rm } from 'node:fs/promises';
import { jsonParse } from 'n8n-workflow';

import type { RelayEventMap } from '@/events/maps/relay.event-map';
import { Publisher } from '@/scaling/pubsub/publisher.service';

import {
	SOURCE_CONTROL_DEFAULT_BRANCH_COLOR,
	SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER,
} from './constants';
import {
	getRepoType,
	getTrackingInformationFromPostPushResult,
	getTrackingInformationFromPrePushResult,
	getTrackingInformationFromPullResult,
} from './source-control-helper';
import { SourceControlExportService } from './source-control-export.service';
import { SourceControlGitService } from './source-control-git.service';
import type { AutoPublishMode } from './source-control-import.service';
import { SourceControlImportService } from './source-control-import.service';
import { SourceControlPreferencesService } from './source-control-preferences.service';
import type { AccessScope } from './source-control-resources.service';
import { SourceControlResourcesService } from './source-control-resources.service';
import type {
	SourceControlGetStatusOptions,
	SourceControlVerboseStatus,
} from './source-control-status.service';
import { SourceControlStatusService } from './source-control-status.service';
import type { SourceControlPreferences } from './types/source-control-preferences';

/** A file to push: an entry of the status, or only its id and type. */
export interface PushFileSelector {
	id: string;
	type: SourceControlledFile['type'];
}

export interface PushWorkfolderOptions {
	fileNames: PushFileSelector[];
	commitMessage?: string;
	force?: boolean;
}

export interface PushWorkfolderResult {
	statusCode: 200 | 409;
	pushResult: GitCommitInfo | undefined;
	statusResult: SourceControlledFile[];
}

export interface PullWorkfolderResult {
	statusCode: 200 | 409;
	statusResult: SourceControlledFile[];
}

/** The commit message of a push without one. */
const DEFAULT_COMMIT_MESSAGE = 'Push from n8n';

/** The id of the status entry for changed tag mappings. */
const TAGS_ENTRY_ID = 'tags';

const errorMessage = (error: unknown) => ensureError(error).message;

/**
 * Fork code (not in upstream n8n): source control of the instance with a Git branch. It connects
 * the work folder to the repository, compares the instance with the branch, pushes resources to
 * the branch and pulls them from it. See `README.md` in this folder.
 */
@Service()
export class SourceControlService {
	/** Whether the Git set-up ran: the check of `ssh` and of the HTTPS credentials. */
	private gitReady = false;

	constructor(
		private readonly logger: Logger,
		private readonly publisher: Publisher,
		private readonly eventService: EventService,
		private readonly preferencesService: SourceControlPreferencesService,
		private readonly gitService: SourceControlGitService,
		private readonly statusService: SourceControlStatusService,
		private readonly exportService: SourceControlExportService,
		private readonly importService: SourceControlImportService,
		private readonly resources: SourceControlResourcesService,
	) {
		this.logger = logger.scoped('source-control');
	}

	/** Loads the preferences, makes a key pair when there is none, and checks the work folder. */
	async init() {
		this.gitReady = false;
		await this.preferencesService.loadFromDbAndApplySourceControlPreferences();
		if (!this.preferencesService.isSourceControlConnected()) return;
		try {
			await this.initGitService();
			// A new container has no work folder: clone the branch again.
			if (!this.gitService.isRepository()) {
				await this.gitService.initRepository();
				await this.gitService.setBranch(this.preferencesService.getBranchName());
			}
		} catch (error) {
			this.logger.warn('Could not set up the work folder of source control', {
				error: errorMessage(error),
			});
		}
	}

	/** Another main instance changed the preferences: the Git set-up runs again. */
	@OnPubSubEvent('reload-source-control-config', { instanceType: 'main' })
	async reloadConfiguration() {
		this.gitReady = false;
	}

	/** Other instances read the preferences again: workers need the read-only flag. */
	private async broadcastReload() {
		await this.publisher.publishCommand({ command: 'reload-source-control-config' });
	}

	// #region Set-up

	/** Runs `ssh -V` and checks the HTTPS credentials. A missing credential is an error. */
	private async initGitService() {
		this.gitReady = false;
		await this.gitService.checkSshBinary();
		if (this.preferencesService.getPreferences().connectionType === 'https') {
			await this.preferencesService.getDecryptedHttpsCredentials();
		} else {
			await this.preferencesService.ensureSshFolder();
		}
		this.gitReady = true;
	}

	private async sanityCheck() {
		try {
			if (!this.gitReady) await this.initGitService();
		} catch (error) {
			throw new BadRequestError(errorMessage(error));
		}
	}

	private emitSettingsUpdated(preferences: SourceControlPreferences) {
		// As in the original, a preference without a value stays out of the payload.
		const payload = jsonParse<RelayEventMap['source-control-settings-updated']>(
			JSON.stringify({
				branchName: preferences.branchName,
				connected: preferences.connected,
				readOnlyInstance: preferences.branchReadOnly,
				repoType: getRepoType(preferences.repositoryUrl),
				connectionType: preferences.connectionType,
			}),
		);
		this.eventService.emit('source-control-settings-updated', payload);
	}

	// #endregion

	// #region Preferences

	/**
	 * Connects the instance to a repository: saves the preferences, clones the branch of `HEAD`
	 * of the remote, and marks the connection. With `initRepo: false` it only saves the
	 * preferences. A failed connection resets the preferences, except the connection type.
	 */
	async connect(user: User, body: unknown) {
		if (this.preferencesService.isSourceControlConnected()) {
			throw new BadRequestError(
				'Cannot change preferences while connected to a source control provider. Please disconnect first.',
			);
		}
		const {
			connected: _connected,
			publicKey: _publicKey,
			initRepo,
			...preferences
		} = this.parse(body);
		await this.preferencesService.setPreferences(preferences);

		if (initRepo === false) {
			await mkdir(this.preferencesService.gitFolder, { recursive: true });
		} else {
			try {
				await this.initGitService();
				const branch = await this.gitService.initRepository(user);
				await this.preferencesService.setPreferences({ branchName: branch, connected: true });
			} catch (error) {
				// The disconnection keeps the connection type and the key pair.
				await this.disconnect({ keepKeyPair: true });
				throw new BadRequestError(errorMessage(error));
			}
		}

		const result = this.preferencesService.getPreferences();
		this.emitSettingsUpdated(result);
		await this.broadcastReload();
		return result;
	}

	/**
	 * Changes the preferences of a connection. A new branch must exist in the remote. The URL of
	 * the repository does not change: a new URL needs a new connection.
	 */
	async updatePreferences(body: unknown) {
		const {
			connected: _connected,
			publicKey: _publicKey,
			initRepo: _initRepo,
			repositoryUrl: _repositoryUrl,
			branchName,
			...preferences
		} = this.parse(body);
		if (branchName) await this.setBranch(branchName);
		await this.preferencesService.setPreferences(preferences);

		try {
			await this.initGitService();
			// The work folder follows the branch of the preferences, when the remote has it.
			const current = await this.gitService.getCurrentBranchName();
			const wanted = this.preferencesService.getBranchName();
			if (current !== wanted) {
				await this.gitService.setBranch(wanted).catch((error: unknown) => {
					this.logger.debug('Could not check out the branch of the preferences', {
						error: errorMessage(error),
					});
				});
			}
		} catch (error) {
			throw new BadRequestError(errorMessage(error));
		}

		const result = this.preferencesService.getPreferences();
		this.emitSettingsUpdated(result);
		await this.broadcastReload();
		return result;
	}

	private parse(body: unknown) {
		try {
			return this.preferencesService.parseSourceControlPreferences(body);
		} catch (error) {
			throw new BadRequestError(errorMessage(error));
		}
	}

	/** Saves the branch, then checks it out. The preferences keep a branch that the remote lacks. */
	async setBranch(branch: string) {
		await this.preferencesService.setPreferences({ branchName: branch });
		try {
			await this.gitService.setBranch(branch);
		} catch (error) {
			throw new BadRequestError(errorMessage(error));
		}
	}

	/**
	 * Ends the connection: resets the preferences, deletes the HTTPS credentials and the work
	 * folder. The key pair stays.
	 */
	async disconnect(options: { keepKeyPair?: boolean } = {}) {
		await this.preferencesService.setPreferences({
			connected: false,
			branchName: '',
			repositoryUrl: '',
			branchReadOnly: false,
			branchColor: SOURCE_CONTROL_DEFAULT_BRANCH_COLOR,
		});
		await this.preferencesService.deleteHttpsCredentials();
		await this.gitService.deleteRepository();
		if (!options.keepKeyPair) {
			await rm(this.preferencesService.privateKeyTempFile, { force: true });
		}
		this.gitReady = false;
		await this.broadcastReload();
		return this.preferencesService.getPreferences();
	}

	async generateKeyPair(keyPairType?: string) {
		const preferences = await this.preferencesService.generateAndSaveKeyPair(keyPairType);
		await this.broadcastReload();
		return { ...preferences, publicKey: await this.preferencesService.getPublicKey() };
	}

	async getBranches() {
		await this.sanityCheck();
		try {
			return await this.gitService.getBranches();
		} catch (error) {
			throw new BadRequestError(errorMessage(error));
		}
	}

	// #endregion

	// #region Status

	/**
	 * Fetches the branch and compares it with the instance. A status for a push or a pull emits a
	 * telemetry event. `verbose` gives all the lists of the comparison.
	 */
	async getStatus(
		user: User,
		options: SourceControlGetStatusOptions,
	): Promise<SourceControlledFile[] | SourceControlVerboseStatus> {
		const status = await this.computeStatus(user, options);
		return options.verbose ? status : status.sourceControlledFiles;
	}

	private async computeStatus(user: User, options: SourceControlGetStatusOptions) {
		await this.sanityCheck();
		if (!this.preferencesService.isSourceControlSetup()) {
			throw new BadRequestError(
				'Source control is not properly set up, please disconnect and reconnect.',
			);
		}
		try {
			await this.gitService.pull();
		} catch (error) {
			throw new BadRequestError(errorMessage(error));
		}
		const status = await this.statusService.computeStatus(user, options);
		const files = status.sourceControlledFiles;
		const publicApi = options.origin === 'publicApi';
		if (options.track === false) return status;
		if (options.direction === 'push') {
			this.eventService.emit('source-control-user-started-push-ui', {
				...getTrackingInformationFromPrePushResult(user.id, files),
				publicApi,
			});
		} else {
			this.eventService.emit('source-control-user-started-pull-ui', {
				...getTrackingInformationFromPullResult(user.id, files),
				publicApi,
			});
		}
		return status;
	}

	// #endregion

	// #region Push

	/**
	 * Pushes the selected entries of a fresh status for a push. Without selected entries, it
	 * pushes all of them. An entry in conflict needs `force`. Each push writes `tags.json` again.
	 * A selected variable or folder writes all variables or folders.
	 */
	async pushWorkfolder(
		user: User,
		options: PushWorkfolderOptions,
		origin: 'ui' | 'publicApi' = 'ui',
	): Promise<PushWorkfolderResult> {
		await this.sanityCheck();
		if (this.preferencesService.isBranchReadOnly()) {
			throw new BadRequestError('Cannot push onto read-only branch.');
		}

		const status = (
			await this.computeStatus(user, {
				direction: 'push',
				preferLocalVersion: true,
				verbose: false,
				origin,
			})
		).sourceControlledFiles;
		const selected = this.selectFiles(status, options.fileNames);

		if (!options.force && selected.some((file) => file.conflict)) {
			return { statusCode: 409, pushResult: undefined, statusResult: selected };
		}

		const scope = await this.resources.getAccessScope(user);
		let pushResult: GitCommitInfo | undefined;
		try {
			await this.writeFiles(selected, scope);
			const message = options.commitMessage ?? DEFAULT_COMMIT_MESSAGE;
			const hash = await this.gitService.commit(message, user);
			const branch = await this.gitService.push(options.force ?? false);
			if (hash) pushResult = { hash, message, branch };
		} catch (error) {
			// The work folder goes back to the branch of the remote.
			await this.gitService.resetToRemote().catch(() => {});
			throw new BadRequestError(errorMessage(error));
		}

		const pushed = selected.map((file) => ({ ...file, pushed: true }));
		this.eventService.emit('source-control-user-finished-push-ui', {
			...getTrackingInformationFromPostPushResult(user.id, pushed),
			publicApi: origin === 'publicApi',
		});
		return { statusCode: 200, pushResult, statusResult: pushed };
	}

	/**
	 * The entries of the status that match a requested id and type. The entry of changed tag
	 * mappings comes with each request for tags.
	 */
	private selectFiles(status: SourceControlledFile[], requested: PushFileSelector[]) {
		if (requested.length === 0) return status;
		const wanted = new Set(requested.map((file) => `${file.type}:${file.id}`));
		const tagsRequested = requested.some((file) => file.type === 'tags');
		const selected = status.filter(
			(file) =>
				wanted.has(`${file.type}:${file.id}`) ||
				(tagsRequested && file.type === 'tags' && file.id === TAGS_ENTRY_ID),
		);
		if (selected.length === 0) {
			throw new BadRequestError('You are not allowed to push these changes');
		}
		return selected;
	}

	private async writeFiles(selected: SourceControlledFile[], scope: AccessScope) {
		const ids = (type: SourceControlledFile['type']) =>
			selected
				.filter((file) => file.type === type && file.status !== 'deleted')
				.map((file) => file.id);
		// A deleted entry of a push is a file that only the branch has.
		const removed = selected.filter(
			(file) =>
				file.status === 'deleted' &&
				['workflow', 'credential', 'project', 'datatable'].includes(file.type),
		);
		await this.exportService.deleteFiles(removed.map((file) => file.file));
		await this.exportService.exportWorkflows(ids('workflow'));
		await this.exportService.exportCredentials(ids('credential'));
		if (selected.some((file) => file.type === 'variables')) {
			await this.exportService.exportVariables();
		}
		await this.exportService.exportTags(scope);
		if (selected.some((file) => file.type === 'folders')) {
			await this.exportService.exportFolders(scope);
		}
		await this.exportService.exportProjects(ids('project'));
		await this.exportService.exportDataTables(ids('datatable'));
	}

	// #endregion

	// #region Pull

	/**
	 * Pulls the branch: the instance gets the resources of the branch, and loses the ones that
	 * the branch does not have, except projects. An entry in conflict needs `force`.
	 */
	async pullWorkfolder(
		user: User,
		options: { force?: boolean; autoPublish?: AutoPublishMode },
		origin: 'ui' | 'publicApi' = 'ui',
	): Promise<PullWorkfolderResult> {
		await this.sanityCheck();
		const status = (
			await this.computeStatus(user, {
				direction: 'pull',
				preferLocalVersion: false,
				verbose: false,
				origin,
			})
		).sourceControlledFiles;

		if (!options.force && status.some((file) => file.conflict)) {
			return { statusCode: 409, statusResult: status };
		}

		await this.importFiles(user, status, options.autoPublish ?? 'none');
		return { statusCode: 200, statusResult: status };
	}

	private async importFiles(
		user: User,
		files: SourceControlledFile[],
		autoPublish: AutoPublishMode,
	) {
		const entries = (type: SourceControlledFile['type'], deleted: boolean) =>
			files.filter((file) => file.type === type && (file.status === 'deleted') === deleted);
		const idsOf = (list: SourceControlledFile[]) => new Set(list.map((file) => file.id));

		const projectIds = idsOf(entries('project', false));
		if (projectIds.size > 0) {
			const projects = await this.resources.getRemoteProjects();
			await this.importService.importProjects(
				projects.map(({ content }) => content).filter((project) => projectIds.has(project.id)),
				user,
			);
		}

		const folderIds = idsOf(entries('folders', false));
		if (folderIds.size > 0) {
			const folders = await this.resources.getRemoteFolders();
			await this.importService.importFolders(folders.filter((folder) => folderIds.has(folder.id)));
		}

		const tagEntries = files.filter((file) => file.type === 'tags');
		const remoteTags = await this.resources.getRemoteTags();
		const tagIds = idsOf(entries('tags', false));
		if (tagIds.size > 0) {
			await this.importService.importTags(remoteTags.tags.filter((tag) => tagIds.has(tag.id)));
		}

		const remoteWorkflows = new Map(
			(await this.resources.getRemoteWorkflows()).map(({ content }) => [content.id, content]),
		);
		const workflowFiles = entries('workflow', false).flatMap((entry) => {
			const content = remoteWorkflows.get(entry.id);
			return content ? [{ entry, content }] : [];
		});
		await this.importService.importWorkflows(workflowFiles, user, autoPublish);
		await this.importService.deleteWorkflows(entries('workflow', true).map((file) => file.id));

		// The imported workflows get the tags of the branch. A change of the tags updates all.
		const mappedWorkflows = new Set(workflowFiles.map(({ entry }) => entry.id));
		if (tagEntries.length > 0) {
			for (const workflowId of remoteWorkflows.keys()) mappedWorkflows.add(workflowId);
		}
		if (mappedWorkflows.size > 0) {
			await this.importService.importTagMappings(remoteTags.mappings, [...mappedWorkflows]);
		}
		await this.importService.deleteTags(
			entries('tags', true)
				.map((file) => file.id)
				.filter((id) => id !== TAGS_ENTRY_ID),
		);

		const credentialEntries = entries('credential', false);
		if (credentialEntries.length > 0) {
			const credentials = new Map(
				(await this.resources.getRemoteCredentials()).map(({ content }) => [content.id, content]),
			);
			await this.importService.importCredentials(
				credentialEntries.flatMap((entry) => {
					const content = credentials.get(entry.id);
					return content ? [{ entry, content }] : [];
				}),
				user,
			);
		}
		await this.importService.deleteCredentials(entries('credential', true).map((file) => file.id));

		const variableIds = idsOf(entries('variables', false));
		if (variableIds.size > 0) {
			const variables = await this.resources.getRemoteVariables();
			await this.importService.importVariables(
				variables.filter((variable) => variableIds.has(variable.id)),
			);
		}
		const deletedVariables = entries('variables', true).map((file) => file.id);
		if (deletedVariables.length > 0) await this.importService.deleteVariables(deletedVariables);

		const dataTableIds = idsOf(entries('datatable', false));
		if (dataTableIds.size > 0) {
			const tables = await this.resources.getRemoteDataTables();
			await this.importService.importDataTables(
				tables.map(({ content }) => content).filter((table) => dataTableIds.has(table.id)),
				user,
			);
		}
		await this.importService.deleteDataTables(entries('datatable', true).map((file) => file.id));

		await this.importService.deleteFolders(entries('folders', true).map((file) => file.id));
	}

	// #endregion

	// #region Work folder

	/** Moves the work folder to the branch of the remote. */
	async resetWorkfolder() {
		await this.sanityCheck();
		try {
			await this.gitService.pull();
		} catch (error) {
			throw new BadRequestError(errorMessage(error));
		}
	}

	/** The content of a file of the branch. Only workflows have one. */
	async getRemoteFileEntity(type: string, id: string) {
		if (type !== 'workflow') throw new BadRequestError(`Unsupported file type: ${type}`);
		await this.sanityCheck();
		const path = `${SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER}/${id}.json`;
		try {
			const content = await this.gitService.getFileContent(path);
			return { content: jsonParse<unknown>(content), type };
		} catch (error) {
			throw new BadRequestError(errorMessage(error));
		}
	}

	// #endregion
}
