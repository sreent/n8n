// Fork test (not in upstream n8n): the code under test of `source-control.golden.test.ts`. To
// record the snapshot against the enterprise files, point these exports at the same paths in
// `@/features/integrations/sourceControl/`. See `../../FORK.md`.
export { useSourceControlStore } from '@/features/integrations/sourceControl/sourceControl.store';
export {
	SOURCE_CONTROL_PULL_MODAL_KEY,
	SOURCE_CONTROL_PULL_RESULT_MODAL_KEY,
	SOURCE_CONTROL_PUSH_MODAL_KEY,
} from '@/features/integrations/sourceControl/sourceControl.constants';
export { sourceControlEventBus } from '@/features/integrations/sourceControl/sourceControl.eventBus';
export { default as SettingsSourceControl } from '@/features/integrations/sourceControl/views/SettingsSourceControl.vue';
export { default as SourceControlInitializationErrorMessage } from '@/features/integrations/sourceControl/components/SourceControlInitializationErrorMessage.vue';
