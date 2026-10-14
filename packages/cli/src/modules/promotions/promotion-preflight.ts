import type {
	PromotionBindingConflict,
	PromotionBindingConsumer,
	PromotionBindingPreflightResult,
	PromotionBindingProject,
} from '@n8n/api-types';
import { CredentialsRepository, ProjectRepository, VariablesRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import path from 'node:path';

import { CredentialTypes } from '@/credential-types';
import { visitWorkflowCredentials } from '@/modules/n8n-packages/entities/credential/workflow-credential-references';
import { VariableRequirementsExtractor } from '@/modules/n8n-packages/entities/variable/variable-requirements.extractor';
import { DirectoryPackageReader } from '@/modules/n8n-packages/io/directory/directory-package-reader';
import type {
	InventoryCredential,
	InventoryWorkflow,
	PackageDirectoryInventory,
} from '@/modules/n8n-packages/io/directory/package-directory-inventory-reader';
import { PackageDirectoryInventoryReader } from '@/modules/n8n-packages/io/directory/package-directory-inventory-reader';
import { PackageImportConfig } from '@/modules/n8n-packages/n8n-packages.config';

import { PROMOTION_PACKAGE_FOLDER } from './promotions.constants';

type Preflight = PromotionBindingPreflightResult;

/** One use of a credential or a variable by a workflow of the package. */
interface Use {
	workflow: InventoryWorkflow;
}

/** The workflows that use a credential or a variable, grouped by their project. */
class Consumers {
	private readonly byProject = new Map<
		string,
		{ project: PromotionBindingProject; workflows: Map<string, string> }
	>();

	constructor(private readonly projectOf: (projectId: string) => PromotionBindingProject) {}

	add({ workflow }: Use) {
		let group = this.byProject.get(workflow.projectId);
		if (!group) {
			group = { project: this.projectOf(workflow.projectId), workflows: new Map() };
			this.byProject.set(workflow.projectId, group);
		}
		group.workflows.set(workflow.id, workflow.name);
	}

	projectIds() {
		return [...this.byProject.keys()];
	}

	list(onlyProjects?: ReadonlySet<string>): PromotionBindingConsumer[] {
		return [...this.byProject.entries()]
			.filter(([projectId]) => !onlyProjects || onlyProjects.has(projectId))
			.map(([, { project, workflows }]) => ({
				project,
				workflows: [...workflows].map(([id, name]) => ({ id, name })),
			}));
	}
}

/** The references of the workflows of the package to one credential id. */
interface CredentialReferences {
	sourceId: string;
	name: string;
	types: string[];
	files: string[];
	consumers: Consumers;
}

/** The references of the workflows of the package to one variable name in one scope. */
interface VariableReferences {
	name: string;
	/** The project of the package variable, `null` for a global variable, `undefined` for none. */
	scope: string | null | undefined;
	files: string[];
	consumers: Consumers;
}

const pushUnique = (list: string[], value: string) => {
	if (!list.includes(value)) list.push(value);
};

/**
 * Fork code (not in upstream n8n): the preflight of Apply. It reads the package of the checkout
 * and checks what its workflows need on this instance: the credentials by id, the variables by
 * name, and the projects. It writes nothing. A missing binding, an access requirement or a
 * conflict blocks the apply. A missing project and a warning do not. See `README.md`.
 */
@Service()
export class PromotionPreflight {
	constructor(
		private readonly inventoryReader: PackageDirectoryInventoryReader,
		private readonly importConfig: PackageImportConfig,
		private readonly variableExtractor: VariableRequirementsExtractor,
		private readonly credentialTypes: CredentialTypes,
		private readonly projectRepository: ProjectRepository,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly variablesRepository: VariablesRepository,
	) {}

	async check(repository: string): Promise<Preflight> {
		const reader = new DirectoryPackageReader(
			path.join(repository, PROMOTION_PACKAGE_FOLDER),
			this.importConfig,
		);
		const inventory = await this.inventoryReader.read(reader);
		const projectNames = new Map(inventory.projects.map(({ id, name }) => [id, name]));
		const projectOf = (projectId: string) => ({
			id: projectId,
			name: projectNames.get(projectId) ?? '',
		});

		const result: Preflight = {
			missingProjects: [],
			missingBindings: [],
			accessRequirements: [],
			conflicts: [],
			warnings: [],
		};
		await this.checkProjects(inventory, result);
		await this.checkCredentials(inventory, projectOf, result);
		await this.checkVariables(inventory, projectOf, result);
		return result;
	}

	/** Projects of the package that this instance does not have, or has as a personal project. */
	private async checkProjects(inventory: PackageDirectoryInventory, result: Preflight) {
		for (const project of inventory.projects) {
			const existing = await this.projectRepository.findOneBy({ id: project.id });
			if (!existing) {
				result.missingProjects.push({
					id: project.id,
					name: project.name,
					...(project.icon ? { icon: project.icon } : {}),
					...(project.description !== undefined ? { description: project.description } : {}),
					...(project.customTelemetryTags
						? { customTelemetryTags: project.customTelemetryTags }
						: {}),
				});
			} else if (existing.type !== 'team') {
				result.conflicts.push({
					kind: 'project',
					code: 'project-not-team',
					project: { id: project.id, name: project.name },
					filePath: `${project.path}/project.json`,
					workflows: inventory.workflows
						.filter(({ projectId }) => projectId === project.id)
						.map(({ id, name }) => ({ id, name })),
				});
			}
		}
	}

	private async checkCredentials(
		inventory: PackageDirectoryInventory,
		projectOf: (projectId: string) => PromotionBindingProject,
		result: Preflight,
	) {
		const withoutId = new Map<string, CredentialReferences>();
		const byId = new Map<string, CredentialReferences>();
		for (const workflow of inventory.workflows) {
			visitWorkflowCredentials(workflow.content.nodes, (type, details) => {
				const id = typeof details.id === 'string' && details.id.length > 0 ? details.id : null;
				const key = id ?? `${type}:${details.name}`;
				const references = id ? byId : withoutId;
				let entry = references.get(key);
				if (!entry) {
					entry = {
						sourceId: id ?? '',
						name: details.name,
						types: [],
						files: [],
						consumers: new Consumers(projectOf),
					};
					references.set(key, entry);
				}
				pushUnique(entry.types, type);
				pushUnique(entry.files, workflow.path);
				entry.consumers.add({ workflow });
				return false;
			});
		}

		for (const entry of withoutId.values()) {
			result.conflicts.push({
				kind: 'credential',
				sourceId: null,
				name: entry.name,
				expectedTypes: entry.types,
				referenceFiles: entry.files,
				consumers: entry.consumers.list(),
				code: 'missing-id',
			});
		}

		const files = new Map<string, InventoryCredential>(
			inventory.credentials.map((credential) => [credential.credential.id, credential]),
		);
		const consumerProjects = [
			...new Set([...byId.values()].flatMap(({ consumers }) => consumers.projectIds())),
		];
		const targets = new Map(
			(
				await this.credentialsRepository.findPromotionBindingAccess(
					[...byId.keys()],
					consumerProjects,
				)
			).map((credential) => [credential.id, credential]),
		);

		for (const entry of byId.values()) {
			const file = files.get(entry.sourceId);
			const conflictBase = {
				kind: 'credential' as const,
				sourceId: entry.sourceId,
				name: file?.credential.name ?? entry.name,
				expectedTypes: entry.types,
				...(file ? { filePath: file.path } : {}),
				referenceFiles: entry.files,
				consumers: entry.consumers.list(),
			};
			if (entry.types.length > 1) {
				result.conflicts.push({ ...conflictBase, code: 'conflicting-types' });
				continue;
			}
			const [type] = entry.types;
			if (!this.credentialTypes.recognizes(type)) {
				result.conflicts.push({ ...conflictBase, code: 'unknown-type' });
				continue;
			}
			const target = targets.get(entry.sourceId);
			if (!target) {
				if (!file?.projectId) {
					result.conflicts.push({ ...conflictBase, code: 'unknown-owner' });
					continue;
				}
				result.missingBindings.push({
					kind: 'credential',
					sourceId: entry.sourceId,
					name: conflictBase.name,
					credentialType: type,
					consumers: conflictBase.consumers,
					ownerProject: projectOf(file.projectId),
					...(file.credential.data ? { expressionData: file.credential.data } : {}),
				});
				continue;
			}
			if (target.type !== type) {
				result.conflicts.push({ ...conflictBase, code: 'type-mismatch', targetType: target.type });
				continue;
			}
			if (target.usageScope !== 'project') {
				result.conflicts.push({
					...conflictBase,
					code: 'incompatible-usage-scope',
					usageScope: target.usageScope,
				} satisfies PromotionBindingConflict);
				continue;
			}
			const withoutAccess = new Set(
				entry.consumers
					.projectIds()
					.filter((projectId) => !target.isGlobal && !target.projectIds.includes(projectId)),
			);
			if (withoutAccess.size > 0) {
				result.accessRequirements.push({
					kind: 'credential',
					sourceId: entry.sourceId,
					name: conflictBase.name,
					credentialType: type,
					consumers: entry.consumers.list(withoutAccess),
					code: 'access-required',
				});
			}
		}
	}

	private async checkVariables(
		inventory: PackageDirectoryInventory,
		projectOf: (projectId: string) => PromotionBindingProject,
		result: Preflight,
	) {
		const packageVariables = new Map(
			inventory.variables.map((entry) => [
				`${entry.projectId ?? ''}/${entry.variable.name}`,
				entry,
			]),
		);
		const references = new Map<string, VariableReferences>();
		for (const workflow of inventory.workflows) {
			const requirements = this.variableExtractor.extract({
				id: workflow.id,
				nodes: workflow.content.nodes,
				settings: workflow.content.settings,
			});
			for (const { variableName } of requirements) {
				const scope = packageVariables.has(`${workflow.projectId}/${variableName}`)
					? workflow.projectId
					: packageVariables.has(`/${variableName}`)
						? null
						: undefined;
				const key = `${scope === undefined ? '?' : (scope ?? '')}/${variableName}`;
				let entry = references.get(key);
				if (!entry) {
					entry = { name: variableName, scope, files: [], consumers: new Consumers(projectOf) };
					references.set(key, entry);
				}
				pushUnique(entry.files, workflow.path);
				entry.consumers.add({ workflow });
			}
		}

		const targets = await this.variablesRepository.find({ relations: { project: true } });
		const targetHas = (name: string, projectId: string | null) =>
			targets.some(
				(variable) => variable.key === name && (variable.project?.id ?? null) === projectId,
			);

		for (const entry of references.values()) {
			if (entry.scope === undefined) {
				const defined = entry.consumers
					.projectIds()
					.every((projectId) => targetHas(entry.name, projectId) || targetHas(entry.name, null));
				if (!defined) {
					result.conflicts.push({
						kind: 'variable',
						code: 'missing-definition',
						name: entry.name,
						referenceFiles: entry.files,
						consumers: entry.consumers.list(),
					});
				}
				continue;
			}
			if (!targetHas(entry.name, entry.scope)) {
				const packageVariable = packageVariables.get(`${entry.scope ?? ''}/${entry.name}`);
				result.missingBindings.push({
					kind: 'variable',
					name: entry.name,
					variableType: packageVariable?.variable.type ?? 'string',
					scope:
						entry.scope === null
							? { kind: 'global' }
							: { kind: 'project', project: projectOf(entry.scope) },
					...(packageVariable?.variable.value !== undefined
						? { sourceValue: packageVariable.variable.value }
						: {}),
					consumers: entry.consumers.list(),
				});
				continue;
			}
			if (entry.scope === null) {
				const shadowed = new Set(
					entry.consumers.projectIds().filter((projectId) => targetHas(entry.name, projectId)),
				);
				if (shadowed.size > 0) {
					result.warnings.push({
						kind: 'variable',
						code: 'variable-shadowed',
						name: entry.name,
						scope: { kind: 'global' },
						consumers: entry.consumers.list(shadowed),
					});
				}
			}
		}
	}
}
