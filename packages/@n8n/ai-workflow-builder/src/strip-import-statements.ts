// Fork code (not in upstream n8n): removes the import lines from workflow code. The Workflow SDK
// gives its functions to the code without an import. See `../FORK.md`.

/** A whole line with an import statement: named, default, namespace, type or side-effect imports. */
const IMPORT_LINE = /^\s*import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"];?\s*$/gm;

/** Removes the import lines, the first empty line that they leave, and the outer whitespace. */
export function stripImportStatements(code: string): string {
	return code
		.replace(IMPORT_LINE, '')
		.replace(/^\s*\n/, '')
		.trim();
}
