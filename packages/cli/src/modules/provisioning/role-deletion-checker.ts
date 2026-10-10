// Fork module (not in upstream n8n): the check before a custom role is deleted, in place of the
// enterprise `role-deletion-checker.ee.ts`. packages/cli/src/modules/provisioning/FORK.md
// describes it.
import type { RoleDeletionChecker } from '@n8n/backend-services';
import { Service } from '@n8n/di';

import { ProvisioningRuleRepository } from './database/provisioning-rule.repository';

/** A role that a role mapping rule gives cannot be deleted. */
@Service()
export class ProvisioningRoleDeletionChecker implements RoleDeletionChecker {
	constructor(private readonly rules: ProvisioningRuleRepository) {}

	async findRoleDeletionBlockers(roleSlug: string): Promise<string[]> {
		const count = await this.rules.countByRole(roleSlug);
		if (count === 0) return [];
		return [`referenced by ${count} role mapping rule${count === 1 ? '' : 's'}`];
	}
}
