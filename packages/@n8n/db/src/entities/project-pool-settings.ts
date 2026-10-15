import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from '@n8n/typeorm';

import { WithTimestamps } from './abstract-entity';
import { Project } from './project';

/**
 * Fork code (not in upstream n8n): the worker pool of a project. All executions of the project
 * go to the queue of this pool. It replaces the enterprise entity of the same name, and follows
 * the ordinary migration of the table `project_pool_settings`. See `./FORK.md`.
 */
@Entity()
export class ProjectPoolSettings extends WithTimestamps {
	@PrimaryColumn({ type: 'varchar', length: 36 })
	projectId: string;

	@OneToOne(() => Project, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'projectId' })
	project: Project;

	/** The pool of the executions of the project. `null` is the default queue. */
	@Column({ type: 'varchar', length: 63, nullable: true })
	defaultPool: string | null;
}
