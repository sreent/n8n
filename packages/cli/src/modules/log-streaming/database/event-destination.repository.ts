import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';
import type { JsonObject } from 'n8n-workflow';

import { EventDestination } from './event-destination.entity';

export interface StoredDestinationRow {
	id: string;
	destination: JsonObject;
}

@Service()
export class EventDestinationRepository extends Repository<EventDestination> {
	constructor(dataSource: DataSource) {
		super(EventDestination, dataSource.manager);
	}

	/** All destinations, oldest first. */
	async findAllDestinations(): Promise<StoredDestinationRow[]> {
		return await this.find({ select: ['id', 'destination'], order: { createdAt: 'ASC' } });
	}

	/** Stores a destination: changes the options of an existing one, else adds it. */
	async saveDestination({ id, destination }: StoredDestinationRow) {
		const now = new Date();
		const { affected } = await this.update({ id }, { destination, updatedAt: now });
		if (!affected) await this.insert({ id, destination, createdAt: now, updatedAt: now });
	}

	/** Deletes a destination, and tells if it existed. */
	async deleteDestination(id: string) {
		const { affected } = await this.delete({ id });
		return (affected ?? 0) > 0;
	}

	/**
	 * Replaces all destinations with the given ones, in one transaction. Two instances that do this
	 * at the same time with the same ids give the same result.
	 */
	async replaceAll(destinations: StoredDestinationRow[]) {
		const now = new Date();
		await this.manager.transaction(async (manager) => {
			const keep = destinations.map(({ id }) => id);
			const deletion = manager.createQueryBuilder().delete().from(EventDestination);
			if (keep.length > 0) deletion.where('id NOT IN (:...keep)', { keep });
			await deletion.execute();
			for (const { id, destination } of destinations) {
				await manager.upsert(
					EventDestination,
					{ id, destination, createdAt: now, updatedAt: now },
					['id'],
				);
			}
		});
	}
}
