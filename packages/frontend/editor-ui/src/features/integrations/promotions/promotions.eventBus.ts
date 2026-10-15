// Fork code (not in upstream n8n): the event bus of Git connections. An apply sends `applied`, and
// `projectRemoved` when the apply removed the project of the page. Ordinary pages listen to it and
// load their lists again. See `FORK.md` in this folder.
import { createEventBus } from '@n8n/utils/event-bus';

import type { Project } from '@/features/collaboration/projects/projects.types';

export interface PromotionEvents {
	applied: { projectId: string; project?: Project } | undefined;
	projectRemoved: { projectId: string };
}

export const promotionEventBus = createEventBus<PromotionEvents>();
