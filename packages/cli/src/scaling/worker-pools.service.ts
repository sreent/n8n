import { Service } from '@n8n/di';

import { InstanceRegistryService } from '@/modules/instance-registry/instance-registry.service';

/**
 * Fork code (not in upstream n8n): the worker pools that the workers of the cluster announce in
 * the instance registry. It replaces the enterprise service of the same name. See `./FORK.md`.
 */
@Service()
export class WorkerPoolsService {
	constructor(private readonly instanceRegistry: InstanceRegistryService) {}

	/** The names of the pools of the registered workers, sorted, without duplicates. */
	async getAvailablePools(): Promise<string[]> {
		const instances = await this.instanceRegistry.getAllInstances();
		const pools = new Set<string>();
		for (const { poolName } of instances) {
			if (poolName) pools.add(poolName);
		}
		return [...pools].sort();
	}
}
