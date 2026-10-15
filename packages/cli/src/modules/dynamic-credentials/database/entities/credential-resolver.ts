import { WithTimestampsAndStringId } from '@n8n/db';
import { Column, Entity } from '@n8n/typeorm';

/**
 * A credential resolver: a stored configuration of a resolver type. The ordinary migration
 * `CreateDynamicCredentialResolverTable1764682447000` creates the table.
 */
@Entity({ name: 'dynamic_credential_resolver' })
export class DynamicCredentialResolver extends WithTimestampsAndStringId {
	@Column({ type: 'varchar', length: 128 })
	name: string;

	/** The name of the resolver type, for example `credential-resolver.oauth2-1.0`. */
	@Column({ type: 'varchar', length: 128 })
	type: string;

	/** The configuration as JSON, encrypted. */
	@Column({ type: 'text' })
	config: string;
}
