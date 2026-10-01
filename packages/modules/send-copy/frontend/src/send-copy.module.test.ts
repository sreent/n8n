import { SEND_COPY_MODAL_KEY } from './send-copy.constants';
import { SendCopyModule } from './send-copy.module';

describe('SendCopyModule', () => {
	it('uses the backend module id', () => {
		expect(SendCopyModule.id).toBe('send-copy');
	});

	it('registers the modal as closed, with a lazy component', () => {
		const modal = SendCopyModule.modals?.find((item) => item.key === SEND_COPY_MODAL_KEY);

		expect(modal).toBeDefined();
		expect(modal?.initialState?.open).toBe(false);
		expect(typeof modal?.component).toBe('function');
	});
});
