import type {
	PromotionProviderAuthType,
	PromotionProviderConfig,
	PromotionProviderType,
} from '@n8n/api-types';
import { JsonColumn, WithTimestampsAndStringId } from '@n8n/db';
import { Column, Entity } from '@n8n/typeorm';

/**
 * The credentials for a Git host. The ordinary migration `CreatePromotionsTables1788759351166`
 * makes the table.
 */
@Entity({ name: 'promotion_provider' })
export class PromotionProvider extends WithTimestampsAndStringId {
	@Column({ type: 'varchar', length: 128 })
	name: string;

	@Column({ type: 'varchar', length: 32 })
	type: PromotionProviderType;

	@Column({ type: 'varchar', length: 32 })
	authType: PromotionProviderAuthType;

	/** The settings that are not secret: the public key of an SSH provider. */
	@JsonColumn()
	config: PromotionProviderConfig;

	/** The credentials, encrypted. No answer gives them. */
	@Column({ type: 'text' })
	auth: string;
}
