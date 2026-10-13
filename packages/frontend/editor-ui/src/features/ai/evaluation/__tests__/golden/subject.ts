// Fork test helper (not in upstream n8n): the code under the golden tests of the evaluation
// editor. To record the snapshots against the original files, point these exports at the same
// paths in `@/features/ai/evaluation.ee/` (with `.ee` in the names where upstream has it). See
// `../../FORK.md`.
export { default as EvaluationsRootView } from '@/features/ai/evaluation/views/EvaluationsRootView.vue';
export { default as EvaluationsListSwitcher } from '@/features/ai/evaluation/views/EvaluationsListSwitcher.vue';
export { default as TestRunDetailView } from '@/features/ai/evaluation/views/TestRunDetailView.vue';
export { default as CompareCollectionView } from '@/features/ai/evaluation/views/CompareCollectionView.vue';
export { default as EvalCollectionsListView } from '@/features/ai/evaluation/views/EvalCollectionsListView.vue';
export { useEvaluationStore } from '@/features/ai/evaluation/evaluation.store';
export { useWorkflowEvaluationState } from '@/features/ai/evaluation/composables/useWorkflowEvaluationState';
export { useEvaluationsLicense } from '@/features/ai/evaluation/composables/useEvaluationsLicense';
