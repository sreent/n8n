import {
	ListCopyRecipientsQueryDto,
	SEND_COPY_MAX_RECIPIENTS,
	SEND_COPY_RECIPIENTS_DEFAULT_LIMIT,
	SEND_COPY_RECIPIENTS_MAX_LIMIT,
	SendWorkflowCopyDto,
} from '../send-copy.dto';

const RECIPIENT_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('ListCopyRecipientsQueryDto', () => {
	test('uses the default limit when the query has none', () => {
		const result = ListCopyRecipientsQueryDto.safeParse({ search: '  ada  ' });

		expect(result.success).toBe(true);
		expect(result.data).toEqual({ search: 'ada', limit: SEND_COPY_RECIPIENTS_DEFAULT_LIMIT });
	});

	test('reads the limit from a query string', () => {
		const result = ListCopyRecipientsQueryDto.safeParse({ limit: '5' });

		expect(result.success).toBe(true);
		expect(result.data?.limit).toBe(5);
	});

	test.each([
		{ name: 'a limit of 0', request: { limit: '0' } },
		{
			name: 'a limit above the maximum',
			request: { limit: String(SEND_COPY_RECIPIENTS_MAX_LIMIT + 1) },
		},
		{ name: 'a limit that is not a whole number', request: { limit: '1.5' } },
		{ name: 'a search text that is too long', request: { search: 'a'.repeat(101) } },
	])('rejects $name', ({ request }) => {
		expect(ListCopyRecipientsQueryDto.safeParse(request).success).toBe(false);
	});
});

describe('SendWorkflowCopyDto', () => {
	test('accepts a list of user ids', () => {
		const result = SendWorkflowCopyDto.safeParse({ recipientIds: [RECIPIENT_ID] });

		expect(result.success).toBe(true);
	});

	test.each([
		{ name: 'an empty list', request: { recipientIds: [] } },
		{ name: 'an id that is not a UUID', request: { recipientIds: ['user-1'] } },
		{
			name: 'too many recipients',
			request: { recipientIds: Array(SEND_COPY_MAX_RECIPIENTS + 1).fill(RECIPIENT_ID) },
		},
	])('rejects $name', ({ request }) => {
		expect(SendWorkflowCopyDto.safeParse(request).success).toBe(false);
	});
});
