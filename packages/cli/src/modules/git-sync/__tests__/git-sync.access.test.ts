import { GLOBAL_ADMIN_ROLE, GLOBAL_MEMBER_ROLE, GLOBAL_OWNER_ROLE } from '@n8n/db';
import type { User } from '@n8n/db';

import { canUseGitSync } from '../git-sync.access';

describe('canUseGitSync', () => {
	const withRole = (slug: string) => ({ role: { slug } }) as Pick<User, 'role'>;

	it('allows the instance owner and admins', () => {
		expect(canUseGitSync(withRole(GLOBAL_OWNER_ROLE.slug))).toBe(true);
		expect(canUseGitSync(withRole(GLOBAL_ADMIN_ROLE.slug))).toBe(true);
	});

	it('refuses members, other roles and requests without a user', () => {
		expect(canUseGitSync(withRole(GLOBAL_MEMBER_ROLE.slug))).toBe(false);
		expect(canUseGitSync(withRole('global:chatUser'))).toBe(false);
		expect(canUseGitSync(undefined)).toBe(false);
	});
});
