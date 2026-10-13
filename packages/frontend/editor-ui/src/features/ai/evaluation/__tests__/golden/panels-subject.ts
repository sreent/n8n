// Fork test helper (not in upstream n8n): the code under the golden test of the evaluation panels
// of the canvas. To record the snapshot against the original files in a checkout of upstream n8n,
// point these exports at the same paths in `@/features/ai/evaluation.ee/`. See `../../FORK.md`.
export { default as EvaluationsCanvasInfoCard } from '@/features/ai/evaluation/components/EvaluationsCanvasInfoCard/EvaluationsCanvasInfoCard.vue';
export { default as TestsPanel } from '@/features/ai/evaluation/components/Tests/TestsPanel.vue';
export { useEvaluationsWizardSidepanelStore } from '@/features/ai/evaluation/wizardSidepanel.store';
export { default as AddExecutionToDatasetModal } from '@/features/ai/evaluation/components/AddExecutionToDataset/AddExecutionToDatasetModal.vue';
export { useAddExecutionToDataset } from '@/features/ai/evaluation/composables/useAddExecutionToDataset';
