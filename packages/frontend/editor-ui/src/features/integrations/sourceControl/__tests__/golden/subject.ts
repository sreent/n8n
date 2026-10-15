// Fork test (not in upstream n8n): the code under test of the golden tests of this folder. To
// record the snapshots against the enterprise files in a checkout of upstream n8n, point these
// exports at the same paths in `@/features/integrations/sourceControl.ee/`. See `../../FORK.md`.
export { useSourceControlStore } from '@/features/integrations/sourceControl/sourceControl.store';
export {
	SOURCE_CONTROL_PULL_MODAL_KEY,
	SOURCE_CONTROL_PULL_RESULT_MODAL_KEY,
	SOURCE_CONTROL_PUSH_MODAL_KEY,
} from '@/features/integrations/sourceControl/sourceControl.constants';
export { sourceControlEventBus } from '@/features/integrations/sourceControl/sourceControl.eventBus';
export { default as SettingsSourceControl } from '@/features/integrations/sourceControl/views/SettingsSourceControl.vue';
export { default as SourceControlInitializationErrorMessage } from '@/features/integrations/sourceControl/components/SourceControlInitializationErrorMessage.vue';
export { default as SourceControlPushModal } from '@/features/integrations/sourceControl/components/SourceControlPushModal.vue';
export { default as SourceControlPullModal } from '@/features/integrations/sourceControl/components/SourceControlPullModal.vue';
export { default as SourceControlPullResultModal } from '@/features/integrations/sourceControl/components/SourceControlPullResultModal.vue';
export * as sourceControlApi from '@/features/integrations/sourceControl/sourceControl.api';
