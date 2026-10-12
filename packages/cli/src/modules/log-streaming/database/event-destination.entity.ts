import { JsonColumn, WithTimestamps } from '@n8n/db';
import { Entity, PrimaryColumn } from '@n8n/typeorm';
import type { JsonObject } from 'n8n-workflow';

/**
 * A log streaming destination. The ordinary migration `MessageEventBusDestinations1671535397530`
 * creates the table. The id is a UUID, because the column has the type `uuid` on Postgres.
 */
@Entity({ name: 'event_destinations' })
export class EventDestination extends WithTimestamps {
	@PrimaryColumn('uuid')
	id: string;

	/** The options of the destination, with `__type` and `id`. */
	@JsonColumn()
	destination: JsonObject;
}
