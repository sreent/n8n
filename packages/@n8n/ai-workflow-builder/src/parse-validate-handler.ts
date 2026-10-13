// Fork code (not in upstream n8n): turns workflow code of the Workflow SDK into workflow JSON, and
// checks a workflow with the validators of the SDK. The MCP tools of the workflow builder use it.
// See `../FORK.md`.
import {
	parseWorkflowCodeToBuilder,
	validateWorkflow,
	workflow as workflowBuilder,
	type ValidationResult,
	type WorkflowBuilder,
	type WorkflowJSON,
} from '@n8n/workflow-sdk';
import type { INodeTypes } from 'n8n-workflow';

/** A finding of the validators. It does not stop a save. */
export interface ValidationWarning {
	code: string;
	message: string;
	nodeName?: string;
	parameterPath?: string;
}

export interface ParseAndValidateResult {
	workflow: WorkflowJSON;
	warnings: ValidationWarning[];
}

export interface ParseValidateHandlerOptions {
	/** The SDK can make sample output data for the nodes. The fork does not make it. */
	generatePinData?: boolean;
	nodeTypesProvider?: INodeTypes;
}

/** The workflow code does not parse, or does not give a workflow. */
export class WorkflowCodeParseError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'WorkflowCodeParseError';
	}
}

/** The key of a warning, to compare the warnings of two versions of a workflow. */
export function getWarningKey(warning: ValidationWarning): string {
	return `${warning.code}|${warning.nodeName ?? ''}|${warning.parameterPath ?? ''}`;
}

export class ParseValidateHandler {
	private readonly nodeTypesProvider?: INodeTypes;

	constructor(options: ParseValidateHandlerOptions) {
		this.nodeTypesProvider = options.nodeTypesProvider;
	}

	/**
	 * Parses workflow code without import lines. The nodes get stable IDs and, where the code
	 * gives no position, a layout. Each error becomes a `WorkflowCodeParseError`.
	 */
	async parseAndValidate(code: string): Promise<ParseAndValidateResult> {
		try {
			const builder = parseWorkflowCodeToBuilder(code);
			builder.regenerateNodeIds();
			const workflow = builder.toJSON({ tidyUp: true });
			const warnings = this.validate(builder, workflow);
			return { workflow, warnings };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new WorkflowCodeParseError(`Failed to parse generated workflow code: ${message}`, {
				cause: error,
			});
		}
	}

	/**
	 * Checks workflow JSON as it is. A workflow without nodes gives no warnings. Errors, also those
	 * of the node types provider, are thrown as they are.
	 */
	validateJSON(workflow: WorkflowJSON): ValidationWarning[] {
		if (workflow.nodes.length === 0) return [];
		return this.validate(workflowBuilder.fromJSON(workflow), workflow);
	}

	/** The graph checks of the builder, then the checks of the JSON, once for each key. */
	private validate(builder: WorkflowBuilder, json: WorkflowJSON): ValidationWarning[] {
		const options = { nodeTypesProvider: this.nodeTypesProvider };
		const graph = builder.validate(options);
		const schema = validateWorkflow(json, options);
		return toWarnings([graph, schema]);
	}
}

function toWarnings(results: ValidationResult[]): ValidationWarning[] {
	const seen = new Set<string>();
	const warnings: ValidationWarning[] = [];
	for (const result of results) {
		for (const issue of [...result.errors, ...result.warnings]) {
			const parameterPath = 'parameterPath' in issue ? issue.parameterPath : undefined;
			const key = getWarningKey({ ...issue, parameterPath });
			if (seen.has(key)) continue;
			seen.add(key);
			warnings.push({ code: issue.code, message: issue.message, nodeName: issue.nodeName });
		}
	}
	return warnings;
}
