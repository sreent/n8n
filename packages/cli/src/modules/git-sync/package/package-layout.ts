import {
	PACKAGE_ENTITY_LAYOUT,
	WORKFLOW_METADATA_FILE_NAME,
} from '@/modules/n8n-packages/io/manifest-entry';

/** Git sync stores a flat workflow package, as the package export writes it. */
export const MANIFEST_FILE_NAME = 'manifest.json';
export const WORKFLOWS_DIRECTORY = PACKAGE_ENTITY_LAYOUT.workflows.directory;
export const WORKFLOW_FILE_NAME = PACKAGE_ENTITY_LAYOUT.workflows.fileName;
export { WORKFLOW_METADATA_FILE_NAME };

/**
 * The entries that the package owns in its folder. A push replaces them. Other
 * files in the folder, for example a README, stay as they are.
 */
export const MANAGED_PACKAGE_ENTRIES: readonly string[] = [
	MANIFEST_FILE_NAME,
	...Object.values(PACKAGE_ENTITY_LAYOUT).map(({ directory }) => directory),
];
