import { WithTimestamps } from '@n8n/db';
import { Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/** The link of a team project to a `projects` connection. A project has one link at most. */
@Entity({ name: 'promotion_connection_project' })
export class PromotionConnectionProject extends WithTimestamps {
	@PrimaryColumn({ type: 'varchar', length: 36 })
	projectId: string;

	@Column({ type: 'varchar', length: 36 })
	connectionId: string;
}
