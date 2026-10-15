import type { PromotionConnectionScope, PromotionConnectionTarget } from '@n8n/api-types';
import { JsonColumn, WithTimestampsAndStringId } from '@n8n/db';
import { Column, Entity, JoinColumn, ManyToOne } from '@n8n/typeorm';

import { PromotionProvider } from './promotion-provider.entity';

/** A remote and the provider of its credentials. */
@Entity({ name: 'promotion_connection' })
export class PromotionConnection extends WithTimestampsAndStringId {
	@Column({ type: 'varchar', length: 128 })
	name: string;

	@Column({ type: 'varchar', length: 36 })
	providerId: string;

	@ManyToOne(() => PromotionProvider, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'providerId' })
	provider?: PromotionProvider;

	/** `instance` or `projects`. It cannot change. */
	@Column({ type: 'varchar', length: 16 })
	scope: PromotionConnectionScope;

	@JsonColumn()
	target: PromotionConnectionTarget;
}
