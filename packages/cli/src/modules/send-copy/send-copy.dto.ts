import { Z } from '@n8n/api-types';
import { z } from 'zod';

import {
	SEND_COPY_MAX_RECIPIENTS,
	SEND_COPY_RECIPIENTS_DEFAULT_LIMIT,
	SEND_COPY_RECIPIENTS_MAX_LIMIT,
	SEND_COPY_SEARCH_MAX_LENGTH,
} from './send-copy.constants';

export class ListCopyRecipientsQueryDto extends Z.class({
	search: z.string().trim().max(SEND_COPY_SEARCH_MAX_LENGTH).optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(SEND_COPY_RECIPIENTS_MAX_LIMIT)
		.default(SEND_COPY_RECIPIENTS_DEFAULT_LIMIT),
}) {}

export class SendWorkflowCopyDto extends Z.class({
	recipientIds: z.array(z.string().uuid()).min(1).max(SEND_COPY_MAX_RECIPIENTS),
}) {}
