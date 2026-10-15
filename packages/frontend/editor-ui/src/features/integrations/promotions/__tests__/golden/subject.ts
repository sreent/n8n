// Fork test (not in upstream n8n): the code under test of the golden tests of this folder. To
// record the snapshots against the enterprise files in a checkout of upstream n8n, point these
// exports at the same paths in `@/features/integrations/promotions/`. See `../../FORK.md`.
export { PromotionsModule } from '@/features/integrations/promotions/module.descriptor';
export {
	PROMOTION_SELECT_MODAL_KEY,
	PROMOTIONS_SETTINGS_VIEW,
} from '@/features/integrations/promotions/promotions.constants';
export { promotionEventBus } from '@/features/integrations/promotions/promotions.eventBus';
export { default as PromotionBanners } from '@/features/integrations/promotions/components/PromotionBanners.vue';
