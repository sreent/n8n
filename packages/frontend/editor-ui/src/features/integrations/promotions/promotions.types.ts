// Fork code (not in upstream n8n): the types of the editor of Git connections. They follow the
// public API of the fork module (`packages/cli/src/modules/promotions`). See `FORK.md` in this
// folder.
import type {
	ApplyPackageResultDto,
	PromotePackageResultDto,
	PromotionBindingPreflightResult,
	PromotionChanges,
	PromotionCheckoutPublicDto,
	PromotionConnectionPublicDto,
	PromotionConnectionSummary,
	PromotionDirection,
	PromotionProviderPublicDto,
	PromotionSshKeyType,
} from '@n8n/api-types';

export type PromotionProvider = PromotionProviderPublicDto;
export type PromotionProviderSummary = Omit<PromotionProviderPublicDto, 'config'>;
export type PromotionConnection = PromotionConnectionPublicDto;
export type { PromotionConnectionSummary, PromotionDirection, PromotionSshKeyType };
export type PromotionCheckout = PromotionCheckoutPublicDto;
export type PromotionChangeList = PromotionChanges;
export type PromotionChange = PromotionChanges['changes'][number];
export type PromoteResult = PromotePackageResultDto;
export type ApplyResult = ApplyPackageResultDto;
export type BindingPreflight = PromotionBindingPreflightResult;

/** The configuration of Apply that the incoming banner gives to the selection modal. */
export interface PromotionApplySource {
	connectionId: string;
	configId: string;
	branchName: string;
}

/** The data of the selection modal. */
export type PromotionSelectModalData = {
	projectId: string;
	direction?: PromotionDirection;
	apply?: PromotionApplySource;
};

/** The answer of the create route of a provider. */
export interface PromotionProviderCreated {
	provider: PromotionProvider;
	publicKey: string | null;
}

export interface PromotionPage<T> {
	data: T[];
	nextCursor: string | null;
}
