import { CredentialsEntity, WithTimestamps } from '@n8n/db';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from '@n8n/typeorm';

import { DynamicCredentialResolver } from './credential-resolver';

/**
 * The data of a private credential for one subject of an external identity provider, for
 * example the subject of an OAuth2 token or a Slack user. The ordinary migrations
 * `AddDynamicCredentialEntryTable1764689388394` and `ExpandSubjectIDColumnLength1769784356000`
 * create the table.
 */
@Entity({ name: 'dynamic_credential_entry' })
export class DynamicCredentialEntry extends WithTimestamps {
	@PrimaryColumn({ name: 'credential_id', type: 'varchar', length: 16 })
	credentialId: string;

	@PrimaryColumn({ name: 'subject_id', type: 'varchar', length: 2048 })
	subjectId: string;

	@PrimaryColumn({ name: 'resolver_id', type: 'varchar', length: 16 })
	resolverId: string;

	/** The data as JSON, encrypted. */
	@Column({ type: 'text' })
	data: string;

	@ManyToOne(() => CredentialsEntity, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'credential_id' })
	credential: CredentialsEntity;

	@ManyToOne(() => DynamicCredentialResolver, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'resolver_id' })
	resolver: DynamicCredentialResolver;
}
