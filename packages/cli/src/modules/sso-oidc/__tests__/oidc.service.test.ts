// Fork test (not in upstream n8n). The golden test gives `openid-client` a fetch of its own, so
// this test checks the fetch that the fork's service gives it: the outbound HTTP transport of n8n,
// with a direct connection and without the SSRF policy. packages/cli/src/modules/sso-oidc/FORK.md
// tells why.
import type { ProvisioningConfigDto } from '@n8n/api-types';
import type { OutboundHttp, HttpTransport } from '@n8n/backend-network';
import type { UrlService } from '@n8n/backend-services';
import type { GlobalConfig } from '@n8n/config';
import type { Settings, SettingsRepository } from '@n8n/db';
import type { Cipher } from 'n8n-core';
import * as client from 'openid-client';
import { mock } from 'vitest-mock-extended';

import type { ProvisioningService } from '@/modules/provisioning/provisioning.service';

import { OidcService } from '../oidc.service';

vi.mock('openid-client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('openid-client')>();
	return { ...actual, discovery: vi.fn(), buildAuthorizationUrl: vi.fn() };
});

const DISCOVERY_ENDPOINT = 'https://idp.example.test/.well-known/openid-configuration';

describe('OidcService', () => {
	test('sends the requests to the provider through a direct transport without the SSRF policy', async () => {
		const customFetch = vi.fn();
		const outboundHttp = mock<OutboundHttp>();
		outboundHttp.transport.mockReturnValue(
			mock<HttpTransport>({ asCustomFetch: () => customFetch }),
		);
		const settingsRepository = mock<SettingsRepository>();
		settingsRepository.findByKey.mockResolvedValue(
			mock<Settings>({
				value: JSON.stringify({
					clientId: 'client',
					clientSecret: 'encrypted',
					discoveryEndpoint: DISCOVERY_ENDPOINT,
				}),
			}),
		);
		const cipher = mock<Cipher>();
		cipher.decryptV2.mockResolvedValue('secret');
		vi.mocked(client.discovery).mockResolvedValue(mock<client.Configuration>());
		vi.mocked(client.buildAuthorizationUrl).mockReturnValue(
			new URL('https://idp.example.test/authorize'),
		);
		const provisioningService = mock<ProvisioningService>();
		provisioningService.getConfig.mockResolvedValue(
			mock<ProvisioningConfigDto>({
				scopesProvisionInstanceRole: false,
				scopesProvisionProjectRoles: false,
			}),
		);
		const service = new OidcService(
			mock(),
			mock<GlobalConfig>({ endpoints: { rest: 'rest' } }),
			settingsRepository,
			mock(),
			mock(),
			cipher,
			mock<UrlService>({ getInstanceBaseUrl: () => 'http://localhost:5678' }),
			mock(),
			mock(),
			provisioningService,
			outboundHttp,
		);

		await service.generateTestLoginUrl();

		expect(outboundHttp.transport).toHaveBeenCalledWith({
			proxy: false,
			useDefaultSsrfPolicy: 'unsafe',
		});
		expect(client.discovery).toHaveBeenCalledWith(
			new URL(DISCOVERY_ENDPOINT),
			'client',
			'secret',
			undefined,
			{ [client.customFetch]: customFetch },
		);
	});
});
