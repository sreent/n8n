import {
	LockAcquisitionTimeoutError,
	LockNamespace,
	LockService,
	Logger,
} from '@n8n/backend-common';
import { EventService } from '@n8n/backend-services';
import type { User } from '@n8n/db';
import { ProjectRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { scrubSecretsInText } from '@n8n/utils/scrub-secrets';
import { InstanceSettings } from 'n8n-core';
import { CREDENTIAL_BLANKING_VALUE, UserError } from 'n8n-workflow';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { GitClient, type GitIdentity } from './git/git-client';
import { validateBranch, validateDirectory, validateRepositoryUrl } from './git/git-validation';
import { GitSyncSettingsService, connectionFingerprint } from './git-sync-settings.service';
import { GitSyncConfig } from './git-sync.config';
import { GIT_SYNC_ERROR_CODES, GIT_SYNC_LOCK_KEY, MIN_GIT_VERSION } from './git-sync.constants';
import type { GitSyncSettingsDto } from './git-sync.dto';
import { GitSyncError } from './git-sync.errors';
import type {
	GitSyncConnection,
	GitSyncConnectionTestResult,
	GitSyncProjectOption,
	GitSyncPullResult,
	GitSyncPushResult,
	GitSyncSettingsResponse,
	GitSyncStatus,
	GitSyncWorkflowChange,
	PublishState,
	StoredConnection,
	StoredState,
	WorkflowBaseline,
} from './git-sync.types';
import { N8nPackagesAdapter, type ProjectExport } from './package/n8n-packages.adapter';
import {
	changesBetweenPackages,
	changesFromDiff,
	changesSinceBaseline,
	collectWorkflowSnapshots,
	findConflicts,
	metadataPathsById,
	parseWorkflowFilePath,
	publishStateOf,
	toPackagePath,
	type PackageFile,
	type PackageFileChange,
} from './package/package-changes';
import {
	MANAGED_PACKAGE_ENTRIES,
	MANIFEST_FILE_NAME,
	WORKFLOW_FILE_NAME,
} from './package/package-layout';

/** How long an operation waits for a running one before it reports "busy". */
const LOCK_WAIT_MS = 1_000;
/** Lease backstop for the Redis lock backend. The watchdog renews the lease while the operation runs. */
const LOCK_LEASE_TTL_MS = 60_000;

const notConfigured = () =>
	new GitSyncError(
		'Git sync is not set up. Save the connection settings first.',
		400,
		GIT_SYNC_ERROR_CODES.notConfigured,
	);

/** Removes the characters that Git does not accept in a name or an email address. */
const cleanIdentityPart = (text: string) => text.replace(/[<>\r\n\0]/g, '').trim();

/** The repository path of a file in the package folder. */
const repositoryPath = (directory: string, packagePath: string) =>
	directory ? `${directory}/${packagePath}` : packagePath;

/**
 * Connects one n8n project to one branch of a Git repository. A push exports the
 * workflows of the project to the branch. A pull imports the workflows that changed
 * on the branch. One operation runs at a time.
 */
@Service()
export class GitSyncService {
	private readonly baseDir: string;

	private gitVersionChecked = false;

	constructor(
		private readonly logger: Logger,
		private readonly config: GitSyncConfig,
		instanceSettings: InstanceSettings,
		private readonly settingsService: GitSyncSettingsService,
		private readonly packagesAdapter: N8nPackagesAdapter,
		private readonly lockService: LockService,
		private readonly projectRepository: ProjectRepository,
		private readonly eventService: EventService,
	) {
		this.logger = this.logger.scoped('git-sync');
		this.baseDir = this.config.dir || path.join(instanceSettings.n8nFolder, 'git-sync');
	}

	private get repoDir() {
		return path.join(this.baseDir, 'repo');
	}

	private get homeDir() {
		return path.join(this.baseDir, 'home');
	}

	/** Checks for Git at startup. A missing Git does not stop n8n; the API then reports it. */
	async init(): Promise<void> {
		try {
			await this.assertGitVersion(await this.createClient());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.warn(`Git sync is not available: ${message}`);
		}
	}

	// ── Settings ─────────────────────────────────────────────────────────────

	async getSettings(): Promise<GitSyncSettingsResponse | null> {
		const stored = await this.settingsService.getConnection();
		if (!stored) return null;

		const { encryptedToken, version: _version, ...connection } = stored;
		const project = await this.projectRepository.findOneBy({ id: stored.projectId });
		return {
			...connection,
			accessToken: encryptedToken ? CREDENTIAL_BLANKING_VALUE : '',
			projectName: project?.name ?? null,
		};
	}

	/** Saves the connection. Without a project, Git sync uses the personal project of `user`. */
	async saveSettings(user: User, dto: GitSyncSettingsDto): Promise<GitSyncSettingsResponse> {
		const previous = await this.settingsService.getConnection();
		const fields = await this.resolveSettings(
			user,
			dto,
			previous && { ...previous, hasToken: previous.encryptedToken !== null },
		);

		const encryptedToken =
			fields.token === undefined
				? (previous?.encryptedToken ?? null)
				: fields.token
					? await this.settingsService.encryptToken(fields.token)
					: null;

		const { token: _token, ...connectionFields } = fields;
		const connection: StoredConnection = { version: 1, ...connectionFields, encryptedToken };

		await this.withLock(async () => {
			// Other content means other history: start again with a clean working copy and state.
			if (!previous || connectionFingerprint(previous) !== connectionFingerprint(connection)) {
				await this.settingsService.deleteState();
				await rm(this.repoDir, { recursive: true, force: true });
			}
			await this.settingsService.saveConnection(connection);
		});

		this.eventService.emit('git-sync-settings-saved', {
			user,
			projectId: connection.projectId,
			repositoryUrl: scrubSecretsInText(connection.repositoryUrl),
			branch: connection.branch,
			directory: connection.directory,
			isNew: previous === null,
			tokenChanged: fields.token !== undefined,
		});

		const saved = await this.getSettings();
		if (!saved) throw notConfigured();
		return saved;
	}

	async disconnect(user: User): Promise<void> {
		const previous = await this.settingsService.getConnection();
		await this.withLock(async () => {
			await this.settingsService.deleteAll();
			await rm(this.repoDir, { recursive: true, force: true });
		});
		this.eventService.emit('git-sync-disconnected', {
			user,
			projectId: previous?.projectId ?? null,
			repositoryUrl: previous ? scrubSecretsInText(previous.repositoryUrl) : null,
		});
	}

	/** Checks the settings in the form against the remote, with the stored token when the form keeps it. */
	async testConnection(user: User, dto: GitSyncSettingsDto): Promise<GitSyncConnectionTestResult> {
		const previous = await this.settingsService.getDecryptedConnection();
		const fields = await this.resolveSettings(
			user,
			dto,
			previous && { ...previous, hasToken: previous.token !== null },
		);
		const token = fields.token === undefined ? (previous?.token ?? null) : fields.token || null;

		const client = await this.createClient({ ...fields, token });
		await this.assertGitVersion(client);

		const [defaultBranch, branchHead] = await Promise.all([
			client.remoteDefaultBranch(fields.repositoryUrl),
			client.remoteBranchHead(fields.repositoryUrl, fields.branch),
		]);
		return { defaultBranch, branchExists: branchHead !== null, branchHead };
	}

	async listProjects(search?: string): Promise<GitSyncProjectOption[]> {
		const [projects] = await this.projectRepository.findAllProjectsAndCount({
			search,
			take: 50,
			activated: true,
		});
		return projects.map(({ id, name, type }) => ({ id, name, type }));
	}

	// ── Sync ─────────────────────────────────────────────────────────────────

	async getStatus(user: User): Promise<GitSyncStatus> {
		return await this.withLock(async () => {
			const { connection, client, state } = await this.prepare();
			const { directory } = connection;
			const remoteHead = await client.fetchBranch(connection.repositoryUrl, connection.branch);

			const local = await this.packagesAdapter.exportProject(user, connection.projectId);
			const localSnapshots = collectWorkflowSnapshots(local.files, local.metadata);
			const names = new Map(local.workflows.map(({ id, name }) => [id, name]));

			const remoteFiles = remoteHead ? await this.packageTree(client, remoteHead, directory) : [];
			const remoteSnapshots = collectWorkflowSnapshots(remoteFiles);
			if (remoteHead) await this.addRemoteNames(client, remoteHead, directory, names);

			const outgoing =
				state.lastSyncedCommit !== null
					? changesSinceBaseline(localSnapshots, state.baseline, names)
					: changesBetweenPackages(localSnapshots, remoteSnapshots, names);

			let incoming: GitSyncWorkflowChange[] = [];
			if (remoteHead && remoteHead !== state.lastSyncedCommit) {
				const changes =
					state.lastSyncedCommit !== null &&
					(await client.isAncestor(state.lastSyncedCommit, remoteHead))
						? changesFromDiff(
								await this.packageDiff(client, state.lastSyncedCommit, remoteHead, directory),
								names,
							)
						: changesBetweenPackages(remoteSnapshots, localSnapshots, names);
				incoming = await this.changesToPull(
					changes,
					localSnapshots,
					remoteSnapshots,
					async (id) =>
						await this.remotePublishState(client, remoteHead, directory, remoteFiles, id),
				);
			}

			return {
				branch: connection.branch,
				remoteHead,
				lastSyncedCommit: state.lastSyncedCommit,
				remoteChanged: remoteHead !== null && remoteHead !== state.lastSyncedCommit,
				outgoing,
				incoming,
				conflicts: findConflicts(outgoing, incoming),
				lastPush: state.lastPush,
				lastPull: state.lastPull,
			};
		});
	}

	async push(
		user: User,
		message: string,
		replaceRemoteContent: boolean,
	): Promise<GitSyncPushResult> {
		return await this.withLock(async () => {
			const { connection, client, state } = await this.prepare();
			const { directory } = connection;
			const remoteHead = await client.fetchBranch(connection.repositoryUrl, connection.branch);

			if (
				remoteHead &&
				!replaceRemoteContent &&
				(await this.hasUnpulledPackageChanges(client, state, remoteHead, directory))
			) {
				throw new GitSyncError(
					'The branch has changes that are not in n8n yet. Pull them first, or replace the content in Git.',
					409,
					GIT_SYNC_ERROR_CODES.pullFirst,
					{ remoteHead },
				);
			}

			await client.resetTo(connection.branch, remoteHead);
			const headFiles = remoteHead ? await this.packageTree(client, remoteHead, directory) : [];
			const packageDir = await this.packageDir(directory);
			await this.packagesAdapter.clearManagedEntries(packageDir);
			const exported = await this.exportForPush(user, connection.projectId, packageDir);
			if (remoteHead) {
				await this.keepUnchangedMetadata(client, state, remoteHead, directory, headFiles, exported);
			}
			const baseline = Object.fromEntries(
				collectWorkflowSnapshots(exported.files, exported.metadata),
			);

			await client.stageAll(directory);
			// The manifest holds the export time, so it changes on every export. Alone, it is no change.
			const changedFiles = (await client.stagedChanges()).filter(
				(change) => toPackagePath(change.path, directory) !== MANIFEST_FILE_NAME,
			);

			if (changedFiles.length === 0) {
				await client.resetTo(connection.branch, remoteHead);
				await this.settingsService.saveState({ ...state, lastSyncedCommit: remoteHead, baseline });
				return { result: 'up-to-date', commit: remoteHead };
			}

			const commit = await client.commit({
				message,
				author: this.authorOf(user, connection),
				committer: {
					name: cleanIdentityPart(connection.authorName),
					email: cleanIdentityPart(connection.authorEmail),
				},
			});

			const pushed = await client.push(connection.branch);
			if (!pushed.pushed) {
				await client.resetTo(connection.branch, remoteHead);
				throw new GitSyncError(
					'The Git server rejected the push. Check the branch protection rules and the token permissions.',
					409,
					GIT_SYNC_ERROR_CODES.pushRejected,
					{ detail: pushed.detail },
				);
			}

			await this.settingsService.saveState({
				...state,
				lastSyncedCommit: commit,
				baseline,
				lastPush: { at: new Date().toISOString(), userId: user.id, commit, message },
			});
			this.logger.info('Pushed workflows to Git', { commit, changedFiles: changedFiles.length });
			this.eventService.emit('git-sync-pushed', {
				user,
				projectId: connection.projectId,
				repositoryUrl: scrubSecretsInText(connection.repositoryUrl),
				branch: connection.branch,
				commit,
				changedFiles: changedFiles.length,
				replacedRemoteContent: replaceRemoteContent,
			});

			return { result: 'pushed', commit, changedFiles: changedFiles.length };
		});
	}

	async pull(
		user: User,
		overwriteLocalChanges: boolean,
		full: boolean,
	): Promise<GitSyncPullResult> {
		return await this.withLock(async () => {
			const { connection, client, state } = await this.prepare();
			const { directory, projectId } = connection;
			const remoteHead = await client.fetchBranch(connection.repositoryUrl, connection.branch);
			if (!remoteHead) return { result: 'no-remote-branch' };

			await client.resetTo(connection.branch, remoteHead);
			const packageDir = await this.packageDir(directory);
			const manifest = await this.packagesAdapter.readManifest(packageDir);
			if (!manifest) {
				await this.settingsService.saveState({ ...state, lastSyncedCommit: remoteHead });
				return { result: 'no-package', commit: remoteHead };
			}

			const remoteFiles = await this.packageTree(client, remoteHead, directory);
			const remoteSnapshots = collectWorkflowSnapshots(remoteFiles);
			const local = await this.packagesAdapter.exportProject(user, projectId);
			const localSnapshots = collectWorkflowSnapshots(local.files, local.metadata);
			const names = new Map(local.workflows.map(({ id, name }) => [id, name]));
			for (const { id, name } of manifest.workflows ?? []) names.set(id, name);

			const base = state.lastSyncedCommit;
			const incremental =
				!full &&
				base !== null &&
				(base === remoteHead || (await client.isAncestor(base, remoteHead)));

			let incoming: GitSyncWorkflowChange[];
			if (full) {
				incoming = [...remoteSnapshots.keys()].map((id) => ({
					id,
					name: names.get(id) ?? id,
					change: localSnapshots.has(id) ? 'modified' : 'created',
				}));
			} else {
				const changes = !incremental
					? changesBetweenPackages(remoteSnapshots, localSnapshots, names)
					: base === remoteHead
						? []
						: changesFromDiff(await this.packageDiff(client, base, remoteHead, directory), names);
				incoming = await this.changesToPull(
					changes,
					localSnapshots,
					remoteSnapshots,
					async (id) =>
						await this.remotePublishState(client, remoteHead, directory, remoteFiles, id),
				);
			}

			const manifestIds = new Set((manifest.workflows ?? []).map(({ id }) => id));
			const toImport = incoming.filter(
				({ id, change }) => change !== 'deleted' && manifestIds.has(id),
			);
			const removedUpstream = incoming.filter(
				({ id, change }) => change === 'deleted' && localSnapshots.has(id),
			);

			// Without a baseline, every local workflow that differs from Git counts as changed.
			const localChanges =
				base !== null
					? changesSinceBaseline(localSnapshots, state.baseline, names)
					: changesBetweenPackages(localSnapshots, remoteSnapshots, names);
			const conflicts = findConflicts(localChanges, toImport);
			if (conflicts.length > 0 && !overwriteLocalChanges) {
				throw new GitSyncError(
					'Some workflows changed both in n8n and in Git. Push your changes first, or pull again and replace them.',
					409,
					GIT_SYNC_ERROR_CODES.localChanges,
					{ conflicts },
				);
			}

			const pulledAt = new Date().toISOString();
			if (toImport.length === 0) {
				await this.settingsService.saveState({
					...state,
					lastSyncedCommit: remoteHead,
					baseline: this.baselineAfterPull(state, localSnapshots, remoteSnapshots, new Set()),
					lastPull: {
						at: pulledAt,
						userId: user.id,
						commit: remoteHead,
						created: 0,
						updated: 0,
						skipped: 0,
					},
				});
				return { result: 'up-to-date', commit: remoteHead, removedUpstream };
			}

			const packageBuffer = await this.packagesAdapter.packSubset(
				packageDir,
				manifest,
				new Set(toImport.map(({ id }) => id)),
			);
			const imported = await this.importOrExplain(
				async () =>
					await this.packagesAdapter.importPackage({
						user,
						projectId,
						packageBuffer,
						credentialMatchingMode: connection.credentialMatchingMode,
					}),
			);

			const after = await this.packagesAdapter.exportProject(user, projectId);
			const importedIds = new Set(
				imported.workflows
					.filter(({ status }) => status !== 'skipped')
					.map(({ localId }) => localId),
			);
			const byStatus = (status: 'created' | 'updated' | 'skipped') =>
				imported.workflows.filter((workflow) => workflow.status === status).map(({ name }) => name);
			const created = byStatus('created');
			const updated = byStatus('updated');
			const skipped = byStatus('skipped');

			await this.settingsService.saveState({
				...state,
				lastSyncedCommit: remoteHead,
				baseline: this.baselineAfterPull(
					state,
					collectWorkflowSnapshots(after.files, after.metadata),
					remoteSnapshots,
					importedIds,
				),
				lastPull: {
					at: pulledAt,
					userId: user.id,
					commit: remoteHead,
					created: created.length,
					updated: updated.length,
					skipped: skipped.length,
				},
			});
			this.logger.info('Pulled workflows from Git', {
				commit: remoteHead,
				created: created.length,
				updated: updated.length,
			});
			this.eventService.emit('git-sync-pulled', {
				user,
				projectId,
				repositoryUrl: scrubSecretsInText(connection.repositoryUrl),
				branch: connection.branch,
				commit: remoteHead,
				created: created.length,
				updated: updated.length,
				skipped: skipped.length,
				overwroteLocalChanges: overwriteLocalChanges,
			});

			const credentialNames = new Map(
				(manifest.credentials ?? []).map(({ id, name }) => [id, name]),
			);
			return {
				result: 'pulled',
				commit: remoteHead,
				created,
				updated,
				skipped,
				stubbedCredentials: imported.credentials.stubbed.map((id) => credentialNames.get(id) ?? id),
				publishingBlocked: imported.workflows
					.filter(({ publishing }) => publishing.state === 'blocked')
					.map(({ name }) => name),
				removedUpstream,
			};
		});
	}

	// ── Pull and push rules ──────────────────────────────────────────────────

	/**
	 * Leaves out the workflows that a pull would not change: the workflow file in Git is the
	 * same as here. One exception: the source published this version, and this instance
	 * publishes an older one. The import then publishes the new version.
	 */
	private async changesToPull(
		changes: GitSyncWorkflowChange[],
		local: ReadonlyMap<string, WorkflowBaseline>,
		remote: ReadonlyMap<string, WorkflowBaseline>,
		remotePublishState: (id: string) => Promise<PublishState | undefined>,
	): Promise<GitSyncWorkflowChange[]> {
		const result: GitSyncWorkflowChange[] = [];
		for (const change of changes) {
			const mine = local.get(change.id);
			const theirs = remote.get(change.id);
			if (change.change === 'deleted' || !mine || !theirs || mine.workflow !== theirs.workflow) {
				result.push(change);
			} else if (
				mine.publishState === 'published-other-version' &&
				(await remotePublishState(change.id)) === 'published'
			) {
				result.push(change);
			}
		}
		return result;
	}

	private async remotePublishState(
		client: GitClient,
		commit: string,
		directory: string,
		remoteFiles: readonly PackageFile[],
		id: string,
	): Promise<PublishState | undefined> {
		const metadataPath = metadataPathsById(remoteFiles).get(id);
		if (!metadataPath) return undefined;
		const content = await client.readTextFile(commit, repositoryPath(directory, metadataPath));
		return content === null ? undefined : publishStateOf(content);
	}

	/**
	 * Puts back the metadata file from Git when only the version IDs differ. The version IDs
	 * differ on every instance, so without this a push after a pull rewrites every pulled
	 * workflow. A file changes only when the content or the publish state changed here.
	 */
	private async keepUnchangedMetadata(
		client: GitClient,
		state: StoredState,
		remoteHead: string,
		directory: string,
		headFiles: readonly PackageFile[],
		exported: ProjectExport,
	): Promise<void> {
		const headBlobs = new Map(headFiles.map(({ path: p, blobSha }) => [p, blobSha]));
		const exportedBlobs = new Map(exported.files.map(({ path: p, blobSha }) => [p, blobSha]));
		const baseline = new Map(Object.entries(state.baseline));
		const packageDir = path.join(this.repoDir, directory);

		for (const [metadataPath, content] of exported.metadata) {
			const headBlob = headBlobs.get(metadataPath);
			if (!headBlob || headBlob === exportedBlobs.get(metadataPath)) continue;

			const workflowPath = path.posix.join(path.posix.dirname(metadataPath), WORKFLOW_FILE_NAME);
			if (headBlobs.get(workflowPath) !== exportedBlobs.get(workflowPath)) continue;

			const headContent = await client.readTextFile(
				remoteHead,
				repositoryPath(directory, metadataPath),
			);
			if (headContent === null) continue;

			const localState = publishStateOf(content);
			const id = parseWorkflowFilePath(metadataPath)?.id;
			const syncedState = id === undefined ? undefined : baseline.get(id)?.publishState;
			const unchanged =
				syncedState !== undefined
					? syncedState === localState
					: publishStateOf(headContent) === localState;
			if (unchanged) await writeFile(path.join(packageDir, metadataPath), headContent);
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	/**
	 * Builds the baseline after a pull. Imported workflows are in sync. A workflow with the same
	 * content as Git is in sync too, but keeps its synced publish state, so a local publish stays
	 * visible. Other workflows keep their entry, so local changes stay visible. A workflow that Git
	 * does not have gets no entry.
	 */
	private baselineAfterPull(
		state: StoredState,
		local: ReadonlyMap<string, WorkflowBaseline>,
		remote: ReadonlyMap<string, WorkflowBaseline>,
		importedIds: ReadonlySet<string>,
	): Record<string, WorkflowBaseline> {
		const previous = new Map(Object.entries(state.baseline));
		const baseline = new Map<string, WorkflowBaseline>();

		for (const [id, snapshot] of local) {
			const remoteSnapshot = remote.get(id);
			const previousEntry = previous.get(id);
			if (importedIds.has(id)) {
				baseline.set(id, snapshot);
			} else if (!remoteSnapshot) {
				continue;
			} else if (remoteSnapshot.workflow === snapshot.workflow) {
				const publishState = previousEntry?.publishState ?? snapshot.publishState;
				baseline.set(
					id,
					publishState === undefined
						? { workflow: snapshot.workflow }
						: { workflow: snapshot.workflow, publishState },
				);
			} else if (previousEntry) {
				baseline.set(id, previousEntry);
			}
		}

		return Object.fromEntries(baseline);
	}

	/** True when the branch has package changes that the last sync did not include. */
	private async hasUnpulledPackageChanges(
		client: GitClient,
		state: StoredState,
		remoteHead: string,
		directory: string,
	): Promise<boolean> {
		const { lastSyncedCommit } = state;
		if (lastSyncedCommit === remoteHead) return false;

		const isManaged = (packagePath: string) =>
			MANAGED_PACKAGE_ENTRIES.includes(packagePath.split('/')[0]);

		if (lastSyncedCommit === null) {
			// First sync: building on the branch is safe only when it has no package yet.
			return (await this.packageTree(client, remoteHead, directory)).some(({ path: p }) =>
				isManaged(p),
			);
		}
		if (!(await client.isAncestor(lastSyncedCommit, remoteHead))) return true;

		// Commits that changed only other files, for example a README, do not need a pull.
		return (await this.packageDiff(client, lastSyncedCommit, remoteHead, directory)).some(
			({ path: p }) => isManaged(p),
		);
	}

	private async exportForPush(user: User, projectId: string, packageDir: string) {
		try {
			return await this.packagesAdapter.exportProject(user, projectId, packageDir);
		} catch (error) {
			if (error instanceof UserError) {
				throw new GitSyncError(error.message, 400, GIT_SYNC_ERROR_CODES.invalidPackage);
			}
			throw error;
		}
	}

	/** Reports package problems as a client error. Import conflicts keep their own response. */
	private async importOrExplain<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (error instanceof UserError) {
				throw new GitSyncError(
					`The package in Git cannot be imported: ${error.message}`,
					400,
					GIT_SYNC_ERROR_CODES.invalidPackage,
				);
			}
			throw error;
		}
	}

	private authorOf(user: User, connection: GitSyncConnection): GitIdentity {
		const email = cleanIdentityPart(user.email ?? '') || cleanIdentityPart(connection.authorEmail);
		const name = cleanIdentityPart([user.firstName, user.lastName].filter(Boolean).join(' '));
		return { name: name || email, email };
	}

	/** Files of the package at `commit`, with paths relative to the package folder. */
	private async packageTree(
		client: GitClient,
		commit: string,
		directory: string,
	): Promise<PackageFile[]> {
		return (await client.listTree(commit, directory)).flatMap(({ path: repoPath, blobSha }) => {
			const packagePath = toPackagePath(repoPath, directory);
			return packagePath === null ? [] : [{ path: packagePath, blobSha }];
		});
	}

	/** Package files that changed between two commits, with paths relative to the package folder. */
	private async packageDiff(
		client: GitClient,
		from: string,
		to: string,
		directory: string,
	): Promise<PackageFileChange[]> {
		return (await client.diffNames(from, to, directory)).flatMap(({ status, path: repoPath }) => {
			const packagePath = toPackagePath(repoPath, directory);
			return packagePath === null ? [] : [{ status, path: packagePath }];
		});
	}

	/** Adds the names of workflows that exist only in Git, for the status lists. */
	private async addRemoteNames(
		client: GitClient,
		commit: string,
		directory: string,
		names: Map<string, string>,
	): Promise<void> {
		const content = await client.readTextFile(
			commit,
			repositoryPath(directory, MANIFEST_FILE_NAME),
		);
		if (content === null) return;
		try {
			for (const { id, name } of this.packagesAdapter.parseManifest(content).workflows ?? []) {
				if (!names.has(id)) names.set(id, name);
			}
		} catch {
			// The status still works without names: the lists then show IDs.
		}
	}

	/** The package folder in the working copy. Every part of the path must be a folder or absent. */
	private async packageDir(directory: string): Promise<string> {
		let current = this.repoDir;
		for (const segment of directory ? directory.split('/') : []) {
			current = path.join(current, segment);
			const stats = await lstat(current).catch(() => null);
			if (stats && !stats.isDirectory()) {
				throw new GitSyncError(
					`"${directory}" in the repository is not a folder.`,
					400,
					GIT_SYNC_ERROR_CODES.unsupportedRepository,
				);
			}
		}
		return current;
	}

	private async prepare(): Promise<{
		connection: GitSyncConnection;
		client: GitClient;
		state: StoredState;
	}> {
		const connection = await this.settingsService.getDecryptedConnection();
		if (!connection) throw notConfigured();

		const client = await this.createClient(connection);
		await this.assertGitVersion(client);
		// Only one operation runs at a time, so a lock file here is left over from a crash.
		await rm(path.join(this.repoDir, '.git', 'index.lock'), { force: true });
		await client.ensureRepository(connection.repositoryUrl);

		const state = await this.settingsService.getState(connectionFingerprint(connection));
		return { connection, client, state };
	}

	private async createClient(
		connection?: Pick<GitSyncConnection, 'repositoryUrl' | 'username' | 'token'>,
	): Promise<GitClient> {
		await mkdir(this.repoDir, { recursive: true });
		await mkdir(this.homeDir, { recursive: true });

		let auth: { url: URL; username: string; token: string } | undefined;
		if (connection) {
			// Check again on every run: the allowed hosts can change after the settings were saved.
			const url = validateRepositoryUrl(
				connection.repositoryUrl,
				this.config.allowedProtocols,
				this.config.allowedHosts,
			);
			// Send the token only over HTTPS.
			if (connection.token && url.protocol === 'https:') {
				auth = { url, username: connection.username, token: connection.token };
			}
		}

		return new GitClient({
			repoDir: this.repoDir,
			homeDir: this.homeDir,
			timeoutMs: this.config.timeoutSeconds * 1000,
			allowedProtocols: this.config.allowedProtocols,
			auth,
		});
	}

	private async assertGitVersion(client: GitClient): Promise<void> {
		if (this.gitVersionChecked) return;

		const [major, minor] = await client.version();
		const [minMajor, minMinor] = MIN_GIT_VERSION;
		if (major < minMajor || (major === minMajor && minor < minMinor)) {
			throw new GitSyncError(
				`Git sync needs Git ${minMajor}.${minMinor} or later. This instance has Git ${major}.${minor}.`,
				503,
				GIT_SYNC_ERROR_CODES.gitMissing,
			);
		}
		this.gitVersionChecked = true;
	}

	/**
	 * Checks the settings from the form and fills in the defaults. `token` is undefined
	 * when the form keeps the stored token.
	 */
	private async resolveSettings(
		user: User,
		dto: GitSyncSettingsDto,
		previous: { projectId: string; repositoryUrl: string; hasToken: boolean } | null,
	): Promise<Omit<GitSyncConnection, 'token'> & { token: string | undefined }> {
		const url = validateRepositoryUrl(
			dto.repositoryUrl,
			this.config.allowedProtocols,
			this.config.allowedHosts,
		);

		const keepsStoredToken =
			dto.accessToken === undefined || dto.accessToken === CREDENTIAL_BLANKING_VALUE;
		// The stored token belongs to one server. Never send it to another one.
		if (
			keepsStoredToken &&
			previous?.hasToken &&
			new URL(previous.repositoryUrl).origin !== url.origin
		) {
			throw new GitSyncError(
				'The repository is on another server now. Enter the access token again.',
				400,
				GIT_SYNC_ERROR_CODES.invalidSettings,
			);
		}

		const projectId =
			dto.projectId ??
			previous?.projectId ??
			(await this.projectRepository.getPersonalProjectForUserOrFail(user.id)).id;
		if (!(await this.projectRepository.existsBy({ id: projectId }))) {
			throw new GitSyncError(
				'The project does not exist.',
				400,
				GIT_SYNC_ERROR_CODES.invalidSettings,
			);
		}

		const token = keepsStoredToken ? undefined : dto.accessToken?.trim();

		return {
			repositoryUrl: url.href,
			branch: validateBranch(dto.branch),
			directory: validateDirectory(dto.directory),
			projectId,
			username: dto.username,
			token,
			authorName: dto.authorName,
			authorEmail: dto.authorEmail,
			credentialMatchingMode: dto.credentialMatchingMode,
		};
	}

	private async withLock<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await this.lockService.withLease(
				LockNamespace.KNOWN_LOCKS,
				GIT_SYNC_LOCK_KEY,
				async () => await run(),
				{ waitTimeoutMs: LOCK_WAIT_MS, leaseTtlMs: LOCK_LEASE_TTL_MS },
			);
		} catch (error) {
			if (error instanceof LockAcquisitionTimeoutError) {
				throw new GitSyncError(
					'Another Git sync operation is running. Try again when it is done.',
					409,
					GIT_SYNC_ERROR_CODES.busy,
				);
			}
			throw error;
		}
	}
}
