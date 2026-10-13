// Fork code (not in upstream n8n): a word for a test case that runs, for example "Baking…". It
// changes from time to time while the case runs. See `../FORK.md`.
import type { BaseTextKey } from '@n8n/i18n';
import { useI18n } from '@n8n/i18n';
import { computed, onScopeDispose, ref } from 'vue';

export const PROGRESS_VERB_KEYS: BaseTextKey[] = [
	'evaluation.runDetail.testCase.progress.accomplishing',
	'evaluation.runDetail.testCase.progress.actioning',
	'evaluation.runDetail.testCase.progress.actualizing',
	'evaluation.runDetail.testCase.progress.architecting',
	'evaluation.runDetail.testCase.progress.baking',
	'evaluation.runDetail.testCase.progress.beaming',
	'evaluation.runDetail.testCase.progress.beboppin',
	'evaluation.runDetail.testCase.progress.befuddling',
	'evaluation.runDetail.testCase.progress.billowing',
	'evaluation.runDetail.testCase.progress.blanching',
	'evaluation.runDetail.testCase.progress.bloviating',
	'evaluation.runDetail.testCase.progress.boogieing',
	'evaluation.runDetail.testCase.progress.boondoggling',
	'evaluation.runDetail.testCase.progress.booping',
	'evaluation.runDetail.testCase.progress.bootstrapping',
	'evaluation.runDetail.testCase.progress.brewing',
	'evaluation.runDetail.testCase.progress.bunning',
	'evaluation.runDetail.testCase.progress.burrowing',
	'evaluation.runDetail.testCase.progress.calculating',
	'evaluation.runDetail.testCase.progress.canoodling',
	'evaluation.runDetail.testCase.progress.caramelizing',
	'evaluation.runDetail.testCase.progress.cascading',
	'evaluation.runDetail.testCase.progress.catapulting',
	'evaluation.runDetail.testCase.progress.cerebrating',
	'evaluation.runDetail.testCase.progress.channeling',
	'evaluation.runDetail.testCase.progress.choreographing',
	'evaluation.runDetail.testCase.progress.churning',
	'evaluation.runDetail.testCase.progress.clauding',
	'evaluation.runDetail.testCase.progress.coalescing',
	'evaluation.runDetail.testCase.progress.cogitating',
	'evaluation.runDetail.testCase.progress.combobulating',
	'evaluation.runDetail.testCase.progress.composing',
	'evaluation.runDetail.testCase.progress.computing',
	'evaluation.runDetail.testCase.progress.concocting',
	'evaluation.runDetail.testCase.progress.considering',
	'evaluation.runDetail.testCase.progress.contemplating',
	'evaluation.runDetail.testCase.progress.cooking',
	'evaluation.runDetail.testCase.progress.crafting',
	'evaluation.runDetail.testCase.progress.creating',
	'evaluation.runDetail.testCase.progress.crunching',
	'evaluation.runDetail.testCase.progress.crystallizing',
	'evaluation.runDetail.testCase.progress.cultivating',
	'evaluation.runDetail.testCase.progress.deciphering',
	'evaluation.runDetail.testCase.progress.deliberating',
	'evaluation.runDetail.testCase.progress.determining',
	'evaluation.runDetail.testCase.progress.dillyDallying',
	'evaluation.runDetail.testCase.progress.discombobulating',
	'evaluation.runDetail.testCase.progress.doing',
	'evaluation.runDetail.testCase.progress.doodling',
];

const CHANGE_INTERVAL_MS = 3000;

const randomKey = () => PROGRESS_VERB_KEYS[Math.floor(Math.random() * PROGRESS_VERB_KEYS.length)];

export function useCyclingVerb() {
	const i18n = useI18n();
	const key = ref(randomKey());
	const timer = setInterval(() => {
		key.value = randomKey();
	}, CHANGE_INTERVAL_MS);
	onScopeDispose(() => clearInterval(timer));

	return computed(() => i18n.baseText(key.value));
}
