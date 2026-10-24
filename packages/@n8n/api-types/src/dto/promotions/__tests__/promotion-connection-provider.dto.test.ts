// Fork test (not in upstream n8n): the create and update bodies of a provider of Git connections.
// It is the upstream test of these bodies from before Git hosts, with the fork names. The
// upstream test of promotion-provider.dto.ts tests the responses. See
// packages/cli/src/modules/promotions/README.md.
import {
	CreatePromotionConnectionProviderDto,
	UpdatePromotionConnectionProviderDto,
} from '../promotion-connection-provider.dto';

const provider = { name: 'Staging', type: 'git' as const };
const sshAuth = { authType: 'ssh-key' as const };
const tokenAuth = { authType: 'token' as const, username: 'git-user', password: 'secret' };

describe('CreatePromotionConnectionProviderDto', () => {
	it('defaults an SSH key type to ed25519', () => {
		const result = CreatePromotionConnectionProviderDto.safeParse({ ...provider, auth: sshAuth });

		if (!result.success) throw result.error;
		expect(result.data.auth).toEqual({ authType: 'ssh-key', keyType: 'ed25519' });
	});

	it('trims the username but stores the password as sent', () => {
		const result = CreatePromotionConnectionProviderDto.safeParse({
			...provider,
			auth: { ...tokenAuth, username: '  git-user  ', password: '  secret  ' },
		});

		if (!result.success) throw result.error;
		expect(result.data.auth).toEqual({
			authType: 'token',
			username: 'git-user',
			password: '  secret  ',
		});
	});

	// The auth type lives inside `auth`, so credentials cannot be paired with
	// another auth type's fields.
	it('rejects an auth payload that mixes the two auth types', () => {
		expect(
			CreatePromotionConnectionProviderDto.safeParse({
				...provider,
				auth: { ...tokenAuth, keyType: 'rsa' },
			}).success,
		).toBe(false);
		expect(
			CreatePromotionConnectionProviderDto.safeParse({
				...provider,
				auth: { authType: 'ssh-key', username: 'git-user', password: 'secret' },
			}).success,
		).toBe(false);
	});

	it('rejects an auth payload with no auth type or no credentials', () => {
		expect(CreatePromotionConnectionProviderDto.safeParse({ ...provider, auth: {} }).success).toBe(
			false,
		);
		expect(
			CreatePromotionConnectionProviderDto.safeParse({ ...provider, auth: { authType: 'token' } })
				.success,
		).toBe(false);
		expect(
			CreatePromotionConnectionProviderDto.safeParse({
				...provider,
				auth: { authType: 'token', username: 'git-user' },
			}).success,
		).toBe(false);
	});

	it('rejects a blank name, an over-long name, and a blank password', () => {
		expect(
			CreatePromotionConnectionProviderDto.safeParse({ ...provider, name: ' ', auth: tokenAuth })
				.success,
		).toBe(false);
		expect(
			CreatePromotionConnectionProviderDto.safeParse({
				...provider,
				name: 'a'.repeat(129),
				auth: tokenAuth,
			}).success,
		).toBe(false);
		expect(
			CreatePromotionConnectionProviderDto.safeParse({
				...provider,
				auth: { ...tokenAuth, password: '' },
			}).success,
		).toBe(false);
	});

	it('rejects a top-level auth type and a config', () => {
		expect(
			CreatePromotionConnectionProviderDto.safeParse({
				...provider,
				authType: 'token',
				auth: tokenAuth,
			}).success,
		).toBe(false);
		expect(
			CreatePromotionConnectionProviderDto.safeParse({
				...provider,
				auth: sshAuth,
				config: { schemaVersion: 1, publicKey: 'ssh-ed25519 AAAAKEY', keyType: 'ed25519' },
			}).success,
		).toBe(false);
	});
});

describe('UpdatePromotionConnectionProviderDto', () => {
	it('rejects an empty update', () => {
		expect(UpdatePromotionConnectionProviderDto.safeParse({}).success).toBe(false);
	});

	it('keeps the stored credentials when auth is omitted', () => {
		expect(UpdatePromotionConnectionProviderDto.safeParse({ name: 'Renamed' }).success).toBe(true);
	});

	it('leaves the key type unset, so a rotation can keep the current algorithm', () => {
		const result = UpdatePromotionConnectionProviderDto.safeParse({ auth: sshAuth });

		if (!result.success) throw result.error;
		expect(result.data.auth).toEqual({ authType: 'ssh-key' });
	});

	it('still requires both credentials for a token provider', () => {
		expect(
			UpdatePromotionConnectionProviderDto.safeParse({ auth: { authType: 'token' } }).success,
		).toBe(false);
		expect(UpdatePromotionConnectionProviderDto.safeParse({ auth: tokenAuth }).success).toBe(true);
	});

	it('rejects a change to the provider type or the config', () => {
		expect(UpdatePromotionConnectionProviderDto.safeParse({ type: 'git' }).success).toBe(false);
		expect(
			UpdatePromotionConnectionProviderDto.safeParse({ config: { schemaVersion: 1 } }).success,
		).toBe(false);
	});
});

describe('the provider types of Git connections', () => {
	it('rejects a Git host and a token without a username', () => {
		expect(
			CreatePromotionConnectionProviderDto.safeParse({
				...provider,
				type: 'gitlab',
				auth: tokenAuth,
			}).success,
		).toBe(false);
		expect(
			CreatePromotionConnectionProviderDto.safeParse({
				...provider,
				auth: { authType: 'token', password: 'secret' },
			}).success,
		).toBe(false);
	});
});
