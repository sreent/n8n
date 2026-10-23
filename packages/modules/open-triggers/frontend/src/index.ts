// The module's only public entry. The shell imports the descriptor from here via
// `modules.manifest.ts`; anything else the shell (or a test) needs must be exported
// here too — deep paths into `src/` are not part of the contract.
export { OpenTriggersModule } from './open-triggers.module';
export { default as OpenTriggerTestUrlNotice } from './components/OpenTriggerTestUrlNotice.vue';
export { OPEN_TRIGGER_FIXES_MODAL_KEY, OPEN_TRIGGERS_MODULE_ID } from './open-triggers.constants';
export { getPublishViolations } from './open-triggers.api';
export {
	openTriggerActions,
	openTriggersModalCloser,
	type OpenTriggerActions,
} from './open-triggers.capabilities';
export {
	createTriggerToken,
	OPEN_TRIGGER_FIX_LABEL_KEYS,
	openTriggerFixFor,
	type OpenTriggerFix,
	type OpenTriggerFixesModalData,
	type OpenTriggerFixItem,
	type OpenTriggerFixResult,
	type OpenTriggerSecret,
} from './open-triggers.fixes';
