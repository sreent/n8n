// The code under test: the fork module. A recording against the enterprise module points these
// exports at `@/modules/dynamic-credentials.ee/...` in a checkout of upstream n8n.
export { DynamicCredentialsModule } from '@/modules/dynamic-credentials/dynamic-credentials.module';
export {
	extractSharedFields,
	getChangedSharedFields,
} from '@/modules/dynamic-credentials/services/shared-fields';
