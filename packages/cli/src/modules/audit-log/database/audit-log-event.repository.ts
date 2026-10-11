import { escapeLike, LIKE_ESCAPE_CLAUSE } from '@n8n/db';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';
import type { SelectQueryBuilder } from '@n8n/typeorm';

import { AuditLogEvent } from './audit-log-event.entity';

/** The filters of the list and of the export. All of them are optional. */
export interface AuditLogFilter {
	from?: Date;
	to?: Date;
	/** An event name, or a prefix that ends with a dot, for example `n8n.audit.user.`. */
	eventName?: string;
	userId?: string;
}

/** The last event of a batch of an export. The next batch starts after it. */
export interface AuditLogCursor {
	timestamp: Date;
	id: string;
}

export type AuditLogEventRow = Pick<
	AuditLogEvent,
	'id' | 'eventName' | 'timestamp' | 'userId' | 'userEmail' | 'payload'
>;

@Service()
export class AuditLogEventRepository extends Repository<AuditLogEvent> {
	constructor(dataSource: DataSource) {
		super(AuditLogEvent, dataSource.manager);
	}

	/** Stores events. An event whose id is already stored stays as it is. */
	async insertIgnoringDuplicates(events: AuditLogEventRow[]) {
		if (events.length === 0) return;
		await this.createQueryBuilder()
			.insert()
			.into(AuditLogEvent)
			.values(events)
			.orIgnore()
			.execute();
	}

	/** One page of the events that match, newest first, and the number of all events that match. */
	async findPage(filter: AuditLogFilter, skip: number, take: number) {
		const [events, count] = await this.newestFirst(this.matching(filter))
			.skip(skip)
			.take(take)
			.getManyAndCount();
		return { count, events };
	}

	/** The next events that match after the cursor, newest first. */
	async findBatch(filter: AuditLogFilter, after: AuditLogCursor | undefined, take: number) {
		const query = this.matching(filter);
		if (after) {
			query.andWhere(
				'(event.timestamp < :afterTimestamp OR (event.timestamp = :afterTimestamp AND event.id < :afterId))',
				{ afterTimestamp: after.timestamp, afterId: after.id },
			);
		}
		return await this.newestFirst(query).take(take).getMany();
	}

	/** Deletes the events older than the cutoff, and gives their number. */
	async deleteOlderThan(cutoff: Date) {
		const timestamp = this.manager.connection.driver.escape('timestamp');
		const result = await this.createQueryBuilder()
			.delete()
			.where(`${timestamp} < :cutoff`, { cutoff })
			.execute();
		return result.affected ?? 0;
	}

	private matching(filter: AuditLogFilter): SelectQueryBuilder<AuditLogEvent> {
		const query = this.createQueryBuilder('event');
		if (filter.from) {
			query.andWhere('event.timestamp >= :from', { from: filter.from });
		}
		if (filter.to) {
			query.andWhere('event.timestamp <= :to', { to: filter.to });
		}
		if (filter.userId) {
			query.andWhere('event.userId = :userId', { userId: filter.userId });
		}
		if (filter.eventName?.endsWith('.')) {
			query.andWhere(`event.eventName LIKE :eventNamePrefix ${LIKE_ESCAPE_CLAUSE}`, {
				eventNamePrefix: `${escapeLike(filter.eventName)}%`,
			});
		} else if (filter.eventName) {
			query.andWhere('event.eventName = :eventName', { eventName: filter.eventName });
		}
		return query;
	}

	private newestFirst(query: SelectQueryBuilder<AuditLogEvent>) {
		return query.orderBy('event.timestamp', 'DESC').addOrderBy('event.id', 'DESC');
	}
}
