import { CalendarDate } from '@internationalized/date';

import {
	endOfDay,
	formatDay,
	formatTimestamp,
	saveFile,
	startOfDay,
	toEventNameOptions,
} from './audit-log.utils';

describe('toEventNameOptions', () => {
	it('starts each group of two or more events with an option for the full group', () => {
		const options = toEventNameOptions([
			'n8n.audit.workflow.updated',
			'n8n.audit.user.login.success',
			'n8n.audit.package.installed',
			'n8n.audit.user.login.failed',
		]);

		expect(options).toEqual([
			{ value: 'n8n.audit.package.installed', label: 'n8n.audit.package.installed' },
			{ value: 'n8n.audit.user.', label: 'n8n.audit.user.*' },
			{ value: 'n8n.audit.user.login.failed', label: 'n8n.audit.user.login.failed' },
			{ value: 'n8n.audit.user.login.success', label: 'n8n.audit.user.login.success' },
			{ value: 'n8n.audit.workflow.updated', label: 'n8n.audit.workflow.updated' },
		]);
	});

	it('gives each name without a group its own option', () => {
		expect(toEventNameOptions(['n8n.audit.ping', 'other.event'])).toEqual([
			{ value: 'n8n.audit.ping', label: 'n8n.audit.ping' },
			{ value: 'other.event', label: 'other.event' },
		]);
	});
});

describe('day bounds', () => {
	it('gives the first and the last millisecond of a local day', () => {
		const day = new CalendarDate(2026, 10, 25);

		expect(startOfDay(day)).toBe(new Date(2026, 9, 25).toISOString());
		expect(endOfDay(day)).toBe(new Date(new Date(2026, 9, 26).getTime() - 1).toISOString());
	});

	it('goes to the next month and year at the end of a month', () => {
		const day = new CalendarDate(2026, 12, 31);

		expect(endOfDay(day)).toBe(new Date(new Date(2027, 0, 1).getTime() - 1).toISOString());
	});
});

describe('formats', () => {
	it('formats a time with the date and the seconds', () => {
		const text = formatTimestamp('2026-10-01T08:00:05.000Z', 'en-GB');

		expect(text).toContain('2026');
		expect(text).toMatch(/\d{2}:\d{2}:05/);
	});

	it('formats a calendar day', () => {
		expect(formatDay(new CalendarDate(2026, 10, 1), 'en-GB')).toBe('1 Oct 2026');
	});
});

describe('saveFile', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('URL', {
			...URL,
			createObjectURL: vi.fn(() => 'blob:audit-log'),
			revokeObjectURL: vi.fn(),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('downloads the file under its name, and frees it later', () => {
		const clicked: Array<{ href: string; download: string }> = [];
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
			this: HTMLAnchorElement,
		) {
			clicked.push({ href: this.href, download: this.download });
		});

		saveFile(new Blob(['[]']), 'audit-log-2026-10-11.json');

		expect(clicked).toEqual([{ href: 'blob:audit-log', download: 'audit-log-2026-10-11.json' }]);
		expect(document.querySelector('a[download]')).toBeNull();
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();

		vi.advanceTimersByTime(60_000);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audit-log');
	});
});
