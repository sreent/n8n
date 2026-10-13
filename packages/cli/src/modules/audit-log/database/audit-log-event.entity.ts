import { DateTimeColumn, JsonColumn } from '@n8n/db';
import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';
import type { JsonObject } from 'n8n-workflow';

/**
 * One audit event of the event bus. The id is the id of the event message, so an event that the
 * bus sends again is stored once.
 */
@Entity({ name: 'fork_audit_log_event' })
export class AuditLogEvent extends BaseEntity {
	@PrimaryColumn({ type: 'varchar', length: 36 })
	id: string;

	@Column({ type: 'varchar', length: 128 })
	eventName: string;

	/** The time of the event, not the time of the write. */
	@DateTimeColumn()
	timestamp: Date;

	/** The user that the event names, when it names one. */
	@Column({ type: 'varchar', length: 36, nullable: true })
	userId: string | null;

	@Column({ type: 'varchar', length: 254, nullable: true })
	userEmail: string | null;

	/**
	 * The project of the event: the project that the payload names, else the home project of the
	 * workflow or credential that it names. Null when the event names none of them.
	 */
	@Column({ type: 'varchar', length: 36, nullable: true })
	projectId: string | null;

	/** The type of that project: `personal` or `team`. */
	@Column({ type: 'varchar', length: 36, nullable: true })
	projectType: string | null;

	/** The payload of the event message, as the event bus sends it. */
	@JsonColumn()
	payload: JsonObject;
}
