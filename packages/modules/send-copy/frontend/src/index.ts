// The module's only public entry. The shell imports the descriptor from here via
// `modules.manifest.ts`; anything else the shell (or a test) needs must be exported
// here too — deep paths into `src/` are not part of the contract.
export { SendCopyModule } from './send-copy.module';
export { useSendCopyAction } from './useSendCopyAction';
export { sendCopyModalCloser } from './send-copy.capabilities';
export { SEND_COPY_ACTION_ID, SEND_COPY_MODAL_KEY } from './send-copy.constants';
