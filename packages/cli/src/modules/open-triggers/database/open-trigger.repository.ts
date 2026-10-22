import {
	WorkflowEntity,
	WorkflowHistory,
	WorkflowReviewRequest,
	WorkflowReviewRequestWorkflow,
} from '@n8n/db';
import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { INode } from 'n8n-workflow';

/** A version of a workflow, with its nodes. */
export interface VersionNodes {
	workflowId: string;
	versionId: string;
	nodes: INode[];
}

/** The size of the lists of workflow ids in one query, below the parameter limits of SQLite. */
const ID_BATCH = 500;

/** The versions that the publish check of open triggers reads. */
@Service()
export class OpenTriggerRepository {
	constructor(private readonly dataSource: DataSource) {}

	/** The nodes of the published version of a workflow, or null when nothing is published. */
	async findPublishedVersionNodes(workflowId: string): Promise<INode[] | null> {
		const workflow = await this.dataSource.manager.findOne(WorkflowEntity, {
			select: { id: true, activeVersionId: true },
			where: { id: workflowId },
		});
		if (!workflow?.activeVersionId) return null;

		const version = await this.dataSource.manager.findOne(WorkflowHistory, {
			select: { versionId: true, nodes: true },
			where: { versionId: workflow.activeVersionId },
		});
		return version?.nodes ?? null;
	}

	/** The versions of the workflows that an approved workflow review pins. */
	async findApprovedVersionNodes(workflowIds: string[]): Promise<VersionNodes[]> {
		const versions: VersionNodes[] = [];
		for (let start = 0; start < workflowIds.length; start += ID_BATCH) {
			const batch = workflowIds.slice(start, start + ID_BATCH);
			const rows = await this.dataSource.manager
				.createQueryBuilder(WorkflowHistory, 'version')
				.innerJoin(
					WorkflowReviewRequestWorkflow,
					'link',
					'link.workflowVersionId = version.versionId AND link.workflowId = version.workflowId',
				)
				.innerJoin(WorkflowReviewRequest, 'request', 'request.id = link.workflowReviewRequestId')
				.select(['version.versionId', 'version.workflowId', 'version.nodes'])
				.where('version.workflowId IN (:...batch)', { batch })
				.andWhere('request.approvedAt IS NOT NULL')
				.getMany();
			for (const { workflowId, versionId, nodes } of rows) {
				versions.push({ workflowId, versionId, nodes });
			}
		}
		return versions;
	}
}
