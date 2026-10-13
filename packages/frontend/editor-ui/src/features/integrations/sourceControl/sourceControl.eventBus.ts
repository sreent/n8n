// Fork code (not in upstream n8n): the event bus of source control. Ordinary pages listen to it for
// the end of a pull. See `FORK.md` in this folder.
import { createEventBus } from '@n8n/utils/event-bus';

export const sourceControlEventBus = createEventBus();
