import { CredentialsEntity, User, WithTimestamps } from '@n8n/db';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from '@n8n/typeorm';

import { DynamicCredentialResolver } from './credential-resolver';

/**
 * The data of a private credential for one n8n user. The ordinary migration
 * `AddDynamicCredentialUserEntryTable1768901721000` creates the table.
 */
@Entity({ name: 'dynamic_credential_user_entry' })
export class DynamicCredentialUserEntry extends WithTimestamps {
	@PrimaryColumn({ type: 'varchar', length: 16 })
	credentialId: string;

	@PrimaryColumn({ type: 'uuid' })
	userId: string;

	@PrimaryColumn({ type: 'varchar', length: 16 })
	resolverId: string;

	/** The data as JSON, encrypted. */
	@Column({ type: 'text' })
	data: string;

	@ManyToOne(() => CredentialsEntity, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'credentialId' })
	credential: CredentialsEntity;

	@ManyToOne(() => User, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'userId' })
	user: User;

	@ManyToOne(() => DynamicCredentialResolver, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'resolverId' })
	resolver: DynamicCredentialResolver;
}
