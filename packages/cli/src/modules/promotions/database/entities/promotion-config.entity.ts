import type { PromotionConfigSettings, PromotionDirection } from '@n8n/api-types';
import { JsonColumn, WithTimestampsAndStringId } from '@n8n/db';
import { Column, Entity } from '@n8n/typeorm';

/** The settings of one direction of a connection. The id also names the folder of the checkout. */
@Entity({ name: 'promotion_config' })
export class PromotionConfig extends WithTimestampsAndStringId {
	@Column({ type: 'varchar', length: 36 })
	connectionId: string;

	@Column({ type: 'varchar', length: 128 })
	name: string;

	/** `apply` or `promote`. It cannot change. */
	@Column({ type: 'varchar', length: 16 })
	direction: PromotionDirection;

	@JsonColumn()
	settings: PromotionConfigSettings;
}
