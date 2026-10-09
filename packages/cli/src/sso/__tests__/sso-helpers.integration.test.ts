// The behaviour of the SSO helpers: for each sign-in method, licence state and SSO config, what
// each helper gives or throws, and what it changes in the config and in the database. The snapshot
// records what n8n does, so a change in behaviour shows up as a snapshot diff.
// packages/cli/src/sso/FORK.md tells how the fork made the snapshot.
import { LicenseState } from '@n8n/backend-common';
import { testDb } from '@n8n/backend-test-utils';
import { GlobalConfig } from '@n8n/config';
import type { BooleanLicenseFeature } from '@n8n/constants';
import { SettingsRepository } from '@n8n/db';
import { Container } from '@n8n/di';

import config from '@/config';
import { License } from '@/license';

import { GoldenRecorder } from '@test-integration/golden-recorder';
import { LicenseMocker } from '@test-integration/license';

// The module under test. To record the snapshot against the original file, point this import at
// `@/sso.ee/sso-helpers`.
import * as helpers from '@/sso/sso-helpers';

const license = new LicenseMocker();
const recorder = new GoldenRecorder();
const { describeError, dumpDb, diffDumps } = recorder;

const METHOD_KEY = 'userManagement.authenticationMethod';
const METHODS = ['email', 'ldap', 'saml', 'oidc', 'unknown'] as const;

const LICENCES: Record<string, BooleanLicenseFeature[]> = {
	none: [],
	saml: ['feat:saml'],
	oidc: ['feat:oidc'],
	ldap: ['feat:ldap'],
	all: ['feat:saml', 'feat:oidc', 'feat:ldap'],
};

type SsoFlags = { saml: boolean; oidc: boolean; ldap: boolean };
const FLAG_SETS: Record<string, SsoFlags> = {
	'no login flags': { saml: false, oidc: false, ldap: false },
	'saml login flag': { saml: true, oidc: false, ldap: false },
	'oidc login flag': { saml: false, oidc: true, ldap: false },
	'ldap login flag': { saml: false, oidc: false, ldap: true },
	'all login flags': { saml: true, oidc: true, ldap: true },
};

function setLicence(features: BooleanLicenseFeature[]) {
	for (const feature of Object.values(LICENCES).flat()) license.disable(feature);
	for (const feature of features) license.enable(feature);
}

function setSsoConfig(flags: SsoFlags, samlLabel = '') {
	const { sso } = Container.get(GlobalConfig);
	sso.saml.loginEnabled = flags.saml;
	sso.oidc.loginEnabled = flags.oidc;
	sso.ldap.loginEnabled = flags.ldap;
	sso.saml.loginLabel = samlLabel;
}

/** The SSO config and the method in the legacy config, as they are now. */
function describeConfig() {
	const { sso } = Container.get(GlobalConfig);
	return {
		method: config.getEnv(METHOD_KEY) as string,
		saml: { loginEnabled: sso.saml.loginEnabled, loginLabel: sso.saml.loginLabel },
		oidc: { loginEnabled: sso.oidc.loginEnabled },
		ldap: { loginEnabled: sso.ldap.loginEnabled },
	};
}

/** The result of a call, or its error. */
function attempt(fn: () => unknown) {
	try {
		const result = fn();
		return result === undefined ? '<undefined>' : result;
	} catch (error) {
		return `throws ${describeError(error)}`;
	}
}

async function attemptAsync(fn: () => Promise<unknown>) {
	try {
		const result = await fn();
		return result === undefined ? '<undefined>' : result;
	} catch (error) {
		return `throws ${describeError(error)}`;
	}
}

/** What each reading helper gives in the current state. */
function readAll() {
	return {
		getCurrentAuthenticationMethod: attempt(() => helpers.getCurrentAuthenticationMethod()),
		isSsoCurrentAuthenticationMethod: attempt(() => helpers.isSsoCurrentAuthenticationMethod()),
		isSamlCurrentAuthenticationMethod: attempt(() => helpers.isSamlCurrentAuthenticationMethod()),
		isOidcCurrentAuthenticationMethod: attempt(() => helpers.isOidcCurrentAuthenticationMethod()),
		isSamlLicensed: attempt(() => helpers.isSamlLicensed()),
		isSamlLicensedAndEnabled: attempt(() => helpers.isSamlLicensedAndEnabled()),
		getSamlLoginLabel: attempt(() => helpers.getSamlLoginLabel()),
		assertAuthenticationMethodCanBeEnabled: Object.fromEntries(
			METHODS.map((method) => [
				method,
				attempt(() => helpers.assertAuthenticationMethodCanBeEnabled(method as never)),
			]),
		),
	};
}

let baselineSettings: Array<{ key: string; value: string; loadOnStartup: boolean }> = [];

/** Put the settings table back as it was before the first case. */
async function restoreSettings() {
	const repository = Container.get(SettingsRepository);
	await repository.clear();
	if (baselineSettings.length > 0) await repository.insert(baselineSettings);
}

beforeAll(async () => {
	await testDb.init();
	license.mock(Container.get(License));
	license.mockLicenseState(Container.get(LicenseState));
	baselineSettings = (await Container.get(SettingsRepository).find()).map(
		({ key, value, loadOnStartup }) => ({ key, value, loadOnStartup }),
	);
});

afterAll(async () => {
	await testDb.terminate();
});

describe('SSO helpers', () => {
	test('reading helpers', () => {
		const outcomes: Record<string, unknown> = {};
		for (const [licenceName, features] of Object.entries(LICENCES)) {
			setLicence(features);
			for (const method of METHODS) {
				config.set(METHOD_KEY, method);
				for (const [flagsName, flags] of Object.entries(FLAG_SETS)) {
					setSsoConfig(flags);
					outcomes[`licence ${licenceName} | method ${method} | ${flagsName}`] = readAll();
				}
			}
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('the SAML login label', () => {
		const outcomes: Record<string, unknown> = {};
		setLicence(LICENCES.all);
		config.set(METHOD_KEY, 'saml');
		for (const label of ['', 'Company SSO', '  spaced  ']) {
			setSsoConfig(FLAG_SETS['saml login flag'], label);
			outcomes[`label "${label}"`] = attempt(() => helpers.getSamlLoginLabel());
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('setCurrentAuthenticationMethod', async () => {
		const outcomes: Record<string, unknown> = {};
		for (const licenceName of ['none', 'all']) {
			setLicence(LICENCES[licenceName]);
			for (const from of METHODS) {
				for (const to of METHODS) {
					await restoreSettings();
					config.set(METHOD_KEY, from);
					setSsoConfig(FLAG_SETS['no login flags']);
					const before = await dumpDb();
					const result = await attemptAsync(
						async () => await helpers.setCurrentAuthenticationMethod(to as never),
					);
					outcomes[`licence ${licenceName} | from ${from} to ${to}`] = {
						result,
						config: describeConfig(),
						reads: {
							getCurrentAuthenticationMethod: attempt(() =>
								helpers.getCurrentAuthenticationMethod(),
							),
						},
						database: diffDumps(before, await dumpDb()),
					};
				}
			}
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('setCurrentAuthenticationMethod with all login flags on', async () => {
		const outcomes: Record<string, unknown> = {};
		setLicence(LICENCES.all);
		for (const from of METHODS) {
			for (const to of METHODS) {
				await restoreSettings();
				config.set(METHOD_KEY, from);
				setSsoConfig(FLAG_SETS['all login flags'], 'Company SSO');
				const result = await attemptAsync(
					async () => await helpers.setCurrentAuthenticationMethod(to as never),
				);
				outcomes[`from ${from} to ${to}`] = { result, config: describeConfig() };
			}
		}
		await restoreSettings();
		expect(outcomes).toMatchSnapshot();
	});

	test('the licence source of the SAML checks', () => {
		const licenseClass = Container.get(License);
		const licenseState = Container.get(LicenseState);
		const outcomes: Record<string, unknown> = {};
		config.set(METHOD_KEY, 'saml');
		setSsoConfig(FLAG_SETS['saml login flag']);
		const sources: Record<
			string,
			{ isLicensed: boolean; isSamlEnabled: boolean; licenseState: boolean | 'not set' }
		> = {
			'License.isLicensed only': { isLicensed: true, isSamlEnabled: false, licenseState: false },
			'License.isSamlEnabled only': { isLicensed: false, isSamlEnabled: true, licenseState: false },
			'LicenseState only': { isLicensed: false, isSamlEnabled: false, licenseState: true },
			'License on, LicenseState not set': {
				isLicensed: true,
				isSamlEnabled: true,
				licenseState: 'not set',
			},
		};
		try {
			for (const [name, source] of Object.entries(sources)) {
				vi.spyOn(licenseClass, 'isLicensed').mockImplementation(
					(feature) => feature === 'feat:saml' && source.isLicensed,
				);
				vi.spyOn(licenseClass, 'isSamlEnabled').mockReturnValue(source.isSamlEnabled);
				if (source.licenseState === 'not set') {
					Object.assign(licenseState, { licenseProvider: undefined });
				} else {
					const licensed = source.licenseState;
					licenseState.setLicenseProvider({
						isLicensed: (feature) => feature === 'feat:saml' && licensed,
						getValue: () => undefined,
					});
				}
				outcomes[name] = {
					isSamlLicensed: attempt(() => helpers.isSamlLicensed()),
					isSamlLicensedAndEnabled: attempt(() => helpers.isSamlLicensedAndEnabled()),
				};
			}
			// Without a licence provider, a check that reads the licence throws. This shows the order
			// of the checks.
			Object.assign(licenseState, { licenseProvider: undefined });
			for (const method of METHODS) {
				for (const flagsName of ['no login flags', 'saml login flag'] as const) {
					config.set(METHOD_KEY, method);
					setSsoConfig(FLAG_SETS[flagsName]);
					outcomes[`LicenseState not set | method ${method} | ${flagsName}`] = attempt(() =>
						helpers.isSamlLicensedAndEnabled(),
					);
				}
			}
		} finally {
			vi.restoreAllMocks();
			license.mock(licenseClass);
			license.mockLicenseState(licenseState);
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('setCurrentAuthenticationMethod when the database write fails', async () => {
		const manager = Container.get(SettingsRepository).manager;
		await restoreSettings();
		config.set(METHOD_KEY, 'email');
		await manager.query('ALTER TABLE "settings" RENAME TO "settings_away"');
		let result: unknown;
		try {
			await helpers.setCurrentAuthenticationMethod('saml' as never);
			result = 'resolved';
		} catch (error) {
			result = `throws ${error instanceof Error ? error.constructor.name : typeof error}`;
		} finally {
			await manager.query('ALTER TABLE "settings_away" RENAME TO "settings"');
		}
		expect({ result, method: config.getEnv(METHOD_KEY) }).toMatchSnapshot();
	});

	test('a second change of the method, and a stored method that differs from the config', async () => {
		const outcomes: Record<string, unknown> = {};
		setLicence(LICENCES.all);
		setSsoConfig(FLAG_SETS['no login flags']);

		await restoreSettings();
		config.set(METHOD_KEY, 'email');
		const start = await dumpDb();
		await helpers.setCurrentAuthenticationMethod('saml');
		const afterFirst = await dumpDb();
		await helpers.setCurrentAuthenticationMethod('oidc');
		outcomes['email to saml to oidc'] = {
			first: diffDumps(start, afterFirst),
			second: diffDumps(afterFirst, await dumpDb()),
			config: describeConfig(),
		};

		await restoreSettings();
		await Container.get(SettingsRepository).insert({
			key: METHOD_KEY,
			value: JSON.stringify('saml'),
			loadOnStartup: true,
		});
		config.set(METHOD_KEY, 'email');
		outcomes['row saml, config email'] = readAll();

		await restoreSettings();
		expect(outcomes).toMatchSnapshot();
	});
});
