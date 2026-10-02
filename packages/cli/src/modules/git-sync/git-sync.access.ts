import { GLOBAL_ADMIN_ROLE, GLOBAL_OWNER_ROLE } from '@n8n/db';
import type { User } from '@n8n/db';

const GIT_SYNC_ROLE_SLUGS: ReadonlySet<string> = new Set([
	GLOBAL_OWNER_ROLE.slug,
	GLOBAL_ADMIN_ROLE.slug,
]);

/**
 * Git sync replaces the content of a whole project and writes to a shared repository,
 * so only the instance owner and admins can use it. The check reads the role slug and
 * adds no permission scope.
 */
export function canUseGitSync(user: Pick<User, 'role'> | undefined): boolean {
	const slug = user?.role?.slug;
	return slug !== undefined && GIT_SYNC_ROLE_SLUGS.has(slug);
}
