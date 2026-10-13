// The behaviour of the `EnterpriseEdition` gate: for each set of licence flags, feature list and
// slots, what it renders, and what it gives its slots. The snapshot was recorded against the
// enterprise file. packages/frontend/editor-ui/FORK.md tells how the fork made the snapshot.
import { useSettingsStore } from '@n8n/stores/settings.store';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia, type Pinia } from 'pinia';
import { h, nextTick, type Slot } from 'vue';

import { createComponentRenderer } from '@/__tests__/render';
import type { EnterpriseEditionFeatureValue } from '@/Interface';

// The module under test. To record the snapshot against the original file in a checkout of upstream
// n8n, point this import at `@/app/components/EnterpriseEdition.ee.vue`.
import EnterpriseEdition from '@/app/components/EnterpriseEdition.vue';

const renderComponent = createComponentRenderer(EnterpriseEdition);

let pinia: Pinia;

/** A new store state for each render. */
function newPinia() {
	pinia = createTestingPinia();
	setActivePinia(pinia);
}

const FEATURE_LISTS: Record<string, string[] | undefined> = {
	'no prop': undefined,
	'empty list': [],
	sharing: ['sharing'],
	'sharing and variables': ['sharing', 'variables'],
	'unknown flag': ['notAFlag'],
};

const LICENCES: Record<string, Record<string, boolean> | undefined> = {
	'no enterprise settings': undefined,
	'no flags': {},
	'sharing only': { sharing: true },
	'variables only': { variables: true },
	'sharing and variables': { sharing: true, variables: true },
	'sharing false': { sharing: false, variables: true },
};

/** A slot that shows its name and the props that it gets. */
const slot =
	(name: string): Slot =>
	(props: unknown) => [h('i', { 'data-slot': name }, JSON.stringify(props ?? null))];

const SLOTS: Record<string, Record<string, Slot>> = {
	none: {},
	'default only': { default: slot('default') },
	'fallback only': { fallback: slot('fallback') },
	both: { default: slot('default'), fallback: slot('fallback') },
};

function setLicence(enterprise: Record<string, boolean> | undefined) {
	const settingsStore = useSettingsStore();
	settingsStore.settings = {
		...settingsStore.settings,
		enterprise: enterprise as never,
	};
}

function mountGate(
	features: string[] | undefined,
	slots: Record<string, Slot>,
	attrs: Record<string, unknown> = {},
) {
	return renderComponent({
		pinia,
		props: features === undefined ? {} : { features: features as EnterpriseEditionFeatureValue[] },
		slots,
		attrs,
	});
}

describe('EnterpriseEdition gate', () => {
	beforeEach(() => {
		newPinia();
	});

	test('what it renders', () => {
		const outcomes: Record<string, string> = {};
		for (const [licenceName, licence] of Object.entries(LICENCES)) {
			for (const [featuresName, features] of Object.entries(FEATURE_LISTS)) {
				for (const [slotsName, slots] of Object.entries(SLOTS)) {
					newPinia();
					setLicence(licence);
					const { container, unmount } = mountGate(features, slots);
					outcomes[`${licenceName} | ${featuresName} | slots: ${slotsName}`] = container.innerHTML;
					unmount();
				}
			}
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('attributes of the caller', () => {
		const outcomes: Record<string, string> = {};
		const licences: Record<string, Record<string, boolean>> = {
			'sharing on': { sharing: true },
			'sharing off': {},
		};
		for (const [licenceName, licence] of Object.entries(licences)) {
			for (const [slotsName, slots] of Object.entries(SLOTS)) {
				newPinia();
				setLicence(licence);
				const { container, unmount } = mountGate(['sharing'], slots, {
					class: 'outer',
					'data-test-id': 'gate',
					style: 'color: red;',
				});
				outcomes[`${licenceName} | slots: ${slotsName}`] = container.innerHTML;
				unmount();
			}
		}
		expect(outcomes).toMatchSnapshot();
	});

	test('a licence that changes after the first render', async () => {
		const outcomes: Record<string, string> = {};
		setLicence({});
		const { container } = mountGate(['sharing'], SLOTS.both);
		outcomes.off = container.innerHTML;
		setLicence({ sharing: true });
		await nextTick();
		outcomes['turned on'] = container.innerHTML;
		setLicence({ sharing: false });
		await nextTick();
		outcomes['turned off'] = container.innerHTML;
		expect(outcomes).toMatchSnapshot();
	});
});
