// Fork code (not in upstream n8n): the names of the workflow builder tools that the MCP server
// offers, and the import line of the Workflow SDK. See `../FORK.md`.

/** The name of a tool, and the title that a client shows while the tool runs. */
export interface BuilderToolInfo {
	toolName: string;
	displayTitle: string;
}

export const CODE_BUILDER_SEARCH_NODES_TOOL: BuilderToolInfo = {
	toolName: 'search_nodes',
	displayTitle: 'Searching nodes',
};

export const CODE_BUILDER_GET_NODE_TYPES_TOOL: BuilderToolInfo = {
	toolName: 'get_node_types',
	displayTitle: 'Getting node definitions',
};

export const CODE_BUILDER_GET_SUGGESTED_NODES_TOOL: BuilderToolInfo = {
	toolName: 'get_suggested_nodes',
	displayTitle: 'Getting suggested nodes',
};

export const CODE_BUILDER_VALIDATE_TOOL: BuilderToolInfo = {
	toolName: 'validate_workflow',
	displayTitle: 'Validating workflow',
};

export const CODE_BUILDER_VALIDATE_NODE_TOOL: BuilderToolInfo = {
	toolName: 'validate_node_config',
	displayTitle: 'Validating node config',
};

export const MCP_GET_SDK_REFERENCE_TOOL: BuilderToolInfo = {
	toolName: 'get_workflow_sdk_reference',
	displayTitle: 'Getting workflow SDK reference',
};

export const MCP_CREATE_WORKFLOW_FROM_CODE_TOOL: BuilderToolInfo = {
	toolName: 'create_workflow_from_code',
	displayTitle: 'Creating workflow from code',
};

export const MCP_ARCHIVE_WORKFLOW_TOOL: BuilderToolInfo = {
	toolName: 'archive_workflow',
	displayTitle: 'Archiving workflow',
};

export const MCP_UPDATE_WORKFLOW_TOOL: BuilderToolInfo = {
	toolName: 'update_workflow',
	displayTitle: 'Updating workflow',
};

export const MCP_EXPLORE_NODE_RESOURCES_TOOL: BuilderToolInfo = {
	toolName: 'explore_node_resources',
	displayTitle: 'Exploring node resources',
};

export const MCP_GET_WORKFLOW_BEST_PRACTICES_TOOL: BuilderToolInfo = {
	toolName: 'get_workflow_best_practices',
	displayTitle: 'Getting workflow best practices',
};

/** The functions of the Workflow SDK that workflow code can use without an import. */
const SDK_FUNCTIONS = [
	'workflow',
	'node',
	'trigger',
	'sticky',
	'placeholder',
	'newCredential',
	'ifElse',
	'switchCase',
	'merge',
	'splitInBatches',
	'nextBatch',
	'languageModel',
	'memory',
	'tool',
	'outputParser',
	'embedding',
	'embeddings',
	'vectorStore',
	'retriever',
	'documentLoader',
	'textSplitter',
	'reranker',
	'fromAi',
	'expr',
];

/** The import line of the Workflow SDK at the top of workflow code. */
export const SDK_IMPORT_STATEMENT = `import { ${SDK_FUNCTIONS.join(', ')} } from '@n8n/workflow-sdk';`;
