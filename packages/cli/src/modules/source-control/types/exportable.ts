import type { INode, IConnections, IWorkflowGroup, IWorkflowSettings } from 'n8n-workflow';

/** The owner of a resource in a file of the repository. */
export type RemoteResourceOwner =
	| { type: 'personal'; projectId?: string; projectName?: string; personalEmail: string }
	| { type: 'team'; teamId: string; teamName: string };

/** The owner of a resource in a status: a local project. */
export interface StatusResourceOwner {
	type: 'personal' | 'team';
	projectId: string;
	projectName: string;
}

/** `workflows/<id>.json`. */
export interface ExportableWorkflow {
	id: string;
	name: string;
	description?: string | null;
	nodes: INode[];
	connections: IConnections;
	settings?: IWorkflowSettings | null;
	triggerCount: number;
	versionId?: string;
	owner?: RemoteResourceOwner;
	parentFolderId?: string | null;
	isArchived?: boolean;
	nodeGroups?: IWorkflowGroup[];
}

/** `credential_stubs/<id>.json`. */
export interface ExportableCredential {
	id: string;
	name: string;
	type: string;
	data: Record<string, unknown>;
	ownedBy?: RemoteResourceOwner | null;
	isGlobal?: boolean;
	isResolvable?: boolean;
	resolvableAllowFallback?: boolean;
}

/** An entry of `variable_stubs.json`, and of the `variableStubs` of a project. */
export interface ExportableVariable {
	id: string;
	key: string;
	type: string;
	value: string;
}

/** `tags.json`. */
export interface ExportableTags {
	tags: Array<{ id: string; name: string }>;
	mappings: Array<{ workflowId: string; tagId: string }>;
}

export interface ExportableFolder {
	id: string;
	name: string;
	parentFolderId: string | null;
	homeProjectId: string;
	createdAt: string;
	updatedAt: string;
}

/** `folders.json`. */
export interface ExportableFolders {
	folders: ExportableFolder[];
}

/** `projects/<id>.json`. */
export interface ExportableProject {
	id: string;
	name: string;
	icon: unknown;
	description: string | null;
	type: 'team';
	owner: { type: 'team'; teamId: string; teamName: string };
	variableStubs: ExportableVariable[];
}

export interface ExportableDataTableColumn {
	id: string;
	name: string;
	type: string;
	index: number;
}

/** `datatables/<id>.json`. */
export interface ExportableDataTable {
	id: string;
	name: string;
	columns: ExportableDataTableColumn[];
	ownedBy: RemoteResourceOwner | { type: 'team'; projectId: string; projectName: string };
	createdAt: string;
	updatedAt: string;
}
