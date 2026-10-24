// Fork code (not in upstream n8n): the types of the editor of Git connections. They follow the
// public API of the fork module (`packages/cli/src/modules/promotions`). See `FORK.md` in this
// folder.
import type {
	PromotionConnectionApplyResultDto,
	PromotionConnectionPromoteResultDto,
	PromotionBindingPreflightResult,
	PromotionConnectionChanges,
	PromotionConnectionCheckoutPublicDto,
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
export type PromotionCheckout = PromotionConnectionCheckoutPublicDto;
export type PromotionChangeList = PromotionConnectionChanges;
export type PromotionChange = PromotionConnectionChanges['changes'][number];
export type PromoteResult = PromotionConnectionPromoteResultDto;
export type ApplyResult = PromotionConnectionApplyResultDto;
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
