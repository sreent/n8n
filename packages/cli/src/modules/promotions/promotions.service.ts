import type {
	ApplyPackageResultDto,
	PromotionDirection,
	PromotionBindingPreflightResult,
} from '@n8n/api-types';
import { EventService } from '@n8n/backend-services';
import type { User } from '@n8n/db';
import { ProjectRepository, SharedWorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { BadRequestError } from '@n8n/errors';
import { jsonParse, type JsonValue } from 'n8n-workflow';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { ProjectService } from '@/services/project.service';

import type { PromotionConfig } from './database/entities/promotion-config.entity';
import type { PromotionConnection } from './database/entities/promotion-connection.entity';
import { checkoutBranchOf, PromotionCheckouts } from './promotion-checkouts';
import type { PromotionGitCommand } from './promotion-git';
import { PromotionGitRunner } from './promotion-git';
import { PromotionPackages } from './promotion-packages';
import { PromotionPreflight } from './promotion-preflight';
import { PromotionProvidersService } from './promotion-providers.service';
import { PromotionTargets } from './promotion-targets';
import { PROMOTION_BRANCH_PREFIX } from './promotions.constants';

/** The commit message of a selective promotion without a message. */
const SELECTION_COMMIT_MESSAGE = 'Promote a selection of project changes';

interface PromoteInput {
	commitMessage: string;
	force?: boolean;
	canExportVariableValues: boolean;
}

interface PromoteSelectionInput {
	workflowIds: string[];
	commitMessage?: string;
	canExportVariableValues: boolean;
}

interface ExpectedSource {
	configId: string;
	branchName: string;
	commitSha: string;
}

/** The author of the commits of a promotion: the user who promotes. */
function authorOf(user: User) {
	const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
	return ['-c', `user.name=${name}`, '-c', `user.email=${user.email}`];
}

/**
 * Fork code (not in upstream n8n): the operations of Git connections. Clone and disconnect manage
 * the local checkouts. Promote exports the team projects to the branch of the promote
 * configuration, and a selective promotion changes only the chosen workflows of one project.
 * Apply imports the branch of the apply configuration after the preflight of its bindings. Each
 * configuration runs one operation at a time on this instance. See `README.md`.
 */
/** The counts of an operation as JSON, for its audit event. */
const toJson = (value: unknown) => jsonParse<JsonValue>(JSON.stringify(value));

@Service()
export class PromotionsService {
	/** The operations of each configuration, one after the other. */
	private readonly queues = new Map<string, Promise<unknown>>();

	constructor(
		private readonly targets: PromotionTargets,
		private readonly checkouts: PromotionCheckouts,
		private readonly git: PromotionGitRunner,
		private readonly providersService: PromotionProvidersService,
		private readonly packages: PromotionPackages,
		private readonly preflight: PromotionPreflight,
		private readonly projectRepository: ProjectRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly projectService: ProjectService,
		private readonly eventService: EventService,
	) {}

	/**
	 * Clones the branch of a configuration again. The new clone goes to a temporary folder first, so
	 * a failed clone keeps the old checkout.
	 */
	async clone(connectionId: string, direction: PromotionDirection, user: User) {
		const { connection, config } = await this.targets.forConnection(connectionId, direction);
		const branchName = checkoutBranchOf(config);
		await this.exclusive(config.id, async () => {
			const folder = this.checkouts.folder(config.id);
			await mkdir(folder, { recursive: true });
			const staging = await mkdtemp(path.join(folder, 'clone-'));
			try {
				await this.withRemote(connection, config, async (git) => {
					const heads = await git(folder, [
						'ls-remote',
						'--heads',
						'--',
						connection.target.remoteUrl,
						`refs/heads/${branchName}`,
					]);
					try {
						await git(folder, [
							'clone',
							'--single-branch',
							'--branch',
							branchName,
							'--no-tags',
							'--',
							connection.target.remoteUrl,
							staging,
						]);
					} catch (error) {
						if (heads.trim().length === 0) {
							throw new BadRequestError(`Remote branch does not exist: ${branchName}`);
						}
						throw error;
					}
				});
				await this.checkouts.clear(config.id);
				await rename(staging, this.checkouts.repository(config.id));
				await this.checkouts.writeCache(connection, config);
			} finally {
				await rm(staging, { recursive: true, force: true });
			}
		});
		this.eventService.emit('git-connection-updated', {
			user,
			connectionId,
			connectionName: connection.name,
			change: 'cloned',
			direction,
		});
		return { connectionId, configId: config.id, direction, branchName, hasCheckout: true };
	}

	/** Removes the checkout, and keeps the configuration and the known hosts. */
	async disconnect(connectionId: string, direction: PromotionDirection, user: User) {
		const { connection, config } = await this.targets.forConnection(connectionId, direction);
		await this.exclusive(config.id, async () => await this.checkouts.clear(config.id));
		this.eventService.emit('git-connection-updated', {
			user,
			connectionId,
			connectionName: connection.name,
			change: 'checkout-removed',
			direction,
		});
		return {
			connectionId,
			configId: config.id,
			direction,
			branchName: checkoutBranchOf(config),
			hasCheckout: false,
		};
	}

	/** Exports every team project, commits, and pushes to the branch of the promote configuration. */
	async promote(connectionId: string, user: User, input: PromoteInput) {
		const { connection, config } = await this.targets.forConnection(connectionId, 'promote');
		this.targets.assertInstanceConnection(connection, 'promote');
		await this.targets.assertCloned(connection, config);
		return await this.exclusive(config.id, async () => {
			const repository = this.checkouts.repository(config.id);
			const counts = await this.packages.exportAll(user, repository, input.canExportVariableValues);
			const git = await this.commitAndPush(connection, config, user, {
				message: input.commitMessage,
				force: input.force === true,
			});
			this.eventService.emit('git-connection-promoted', {
				user,
				connectionId,
				...git,
				counts: toJson(counts),
			});
			return { connectionId, configId: config.id, counts, git };
		});
	}

	/**
	 * Promotes chosen workflows of a team project. A chosen workflow that the project owns goes to
	 * the branch with its current state. Another chosen workflow leaves the branch, and must be on
	 * the branch under this project.
	 */
	async promoteProjectSelection(projectId: string, user: User, input: PromoteSelectionInput) {
		const { connection, config } = await this.targets.forProject(projectId, 'promote');
		this.targets.assertInstanceConnection(connection, 'promote');
		await this.targets.assertCloned(connection, config);
		return await this.exclusive(config.id, async () => {
			const repository = this.checkouts.repository(config.id);
			const owners = await this.sharedWorkflowRepository.findOwnerProjectsByWorkflowIds(
				input.workflowIds,
			);
			const owned = (id: string) => owners.get(id)?.id === projectId;
			const liveIds = input.workflowIds.filter(owned);
			const deletedIds = input.workflowIds.filter((id) => !owned(id));
			const counts = await this.packages.exportSelection(user, repository, {
				projectId,
				liveIds,
				deletedIds,
				canExportVariableValues: input.canExportVariableValues,
			});
			const git = await this.commitAndPush(connection, config, user, {
				message: input.commitMessage ?? SELECTION_COMMIT_MESSAGE,
				force: false,
			});
			this.eventService.emit('git-connection-promoted', {
				user,
				connectionId: connection.id,
				projectId,
				...git,
				counts: toJson(counts),
			});
			return { connectionId: connection.id, configId: config.id, counts, git };
		});
	}

	/**
	 * Imports the branch of the apply configuration. With `expectedSource`, a change of the
	 * configuration, the branch or the commit gives `source-changed` and imports nothing. Missing
	 * bindings and conflicts give `blocked` and import nothing.
	 */
	async apply(
		connectionId: string,
		user: User,
		expectedSource: ExpectedSource | undefined,
	): Promise<ApplyPackageResultDto> {
		const { connection, config } = await this.targets.forConnection(connectionId, 'apply');
		this.targets.assertInstanceConnection(connection, 'apply');
		await this.targets.assertCloned(connection, config);
		return await this.exclusive(config.id, async () => {
			const repository = this.checkouts.repository(config.id);
			const branchName = checkoutBranchOf(config);
			await this.withRemote(connection, config, async (git) => {
				await git(repository, [
					'fetch',
					'--no-tags',
					'origin',
					`+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
				]);
			});
			await this.git.run(repository, ['reset', '--hard', `origin/${branchName}`]);
			const commitSha = (await this.git.run(repository, ['rev-parse', 'HEAD'])).trim();
			const base = { connectionId, configId: config.id, git: { commitSha, branchName } };
			if (
				expectedSource &&
				(expectedSource.configId !== config.id ||
					expectedSource.branchName !== branchName ||
					expectedSource.commitSha !== commitSha)
			) {
				return { ...base, status: 'source-changed' };
			}

			const preflight = await this.preflight.check(repository);
			if (isBlocking(preflight)) return { ...base, status: 'blocked', preflight };

			const result = await this.packages.importAll(user, repository);
			const deleted = await this.deleteMissingProjects(user, result.packageProjectIds);
			const counts = { ...result.counts, projects: { ...result.counts.projects, deleted } };
			this.eventService.emit('git-connection-applied', {
				user,
				connectionId,
				branchName,
				commitSha,
				counts: toJson(counts),
			});
			return {
				...base,
				status: 'applied',
				counts,
				warnings: preflight.warnings,
			};
		});
	}

	/** Checks the source and the bindings again, and imports when nothing blocks. */
	async continueApply(
		connectionId: string,
		user: User,
		{ expectedSource }: { expectedSource: ExpectedSource },
	) {
		return await this.apply(connectionId, user, expectedSource);
	}

	/** Deletes the team projects of this instance that the package does not have. */
	private async deleteMissingProjects(user: User, packageProjectIds: ReadonlySet<string>) {
		const teamProjects = await this.projectRepository.findBy({ type: 'team' });
		let deleted = 0;
		for (const project of teamProjects) {
			if (packageProjectIds.has(project.id)) continue;
			await this.projectService.deleteProject(user, project.id);
			deleted++;
		}
		return deleted;
	}

	/** Commits the package of the checkout as the user, and pushes it. */
	private async commitAndPush(
		connection: PromotionConnection,
		config: PromotionConfig,
		user: User,
		{ message, force }: { message: string; force: boolean },
	) {
		const repository = this.checkouts.repository(config.id);
		const settings = config.settings;
		const createBranch = 'createBranchOnPromotion' in settings && settings.createBranchOnPromotion;
		const branchName = createBranch
			? `${PROMOTION_BRANCH_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}`
			: checkoutBranchOf(config);
		if (!(await this.git.isValidBranchName(branchName))) {
			throw new BadRequestError(`Invalid Git branch name: ${branchName}`);
		}
		await this.git.run(repository, ['add', '--all']);
		await this.git.run(repository, [
			...authorOf(user),
			'commit',
			'--quiet',
			'--allow-empty',
			'--no-verify',
			'-m',
			message,
		]);
		const commitSha = (await this.git.run(repository, ['rev-parse', 'HEAD'])).trim();
		await this.withRemote(connection, config, async (git) => {
			await git(repository, [
				'push',
				...(force ? ['--force'] : []),
				'origin',
				`HEAD:refs/heads/${branchName}`,
			]);
		});
		return { commitSha, branchName };
	}

	private async withRemote<T>(
		connection: PromotionConnection,
		config: PromotionConfig,
		action: (git: PromotionGitCommand) => Promise<T>,
	) {
		const provider = await this.providersService.getEntity(connection.providerId);
		const credentials = await this.providersService.decryptCredentials(provider);
		return await this.git.withRemote(
			{
				remoteUrl: connection.target.remoteUrl,
				credentials,
				knownHostsFile: this.checkouts.knownHostsFile(config.id),
			},
			action,
		);
	}

	/** Runs the operations of one configuration one after the other. */
	private async exclusive<T>(configId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(configId) ?? Promise.resolve();
		const next = previous.then(operation, operation);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		this.queues.set(configId, settled);
		try {
			return await next;
		} finally {
			if (this.queues.get(configId) === settled) this.queues.delete(configId);
		}
	}
}

function isBlocking(preflight: PromotionBindingPreflightResult) {
	return (
		preflight.missingBindings.length > 0 ||
		preflight.accessRequirements.length > 0 ||
		preflight.conflicts.length > 0
	);
}
