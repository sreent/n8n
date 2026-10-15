import { UserError } from 'n8n-workflow';

/** The system resolver belongs to n8n: nobody may create a second one, change or delete it. */
export class SystemResolverModificationError extends UserError {
	constructor(action: 'create' | 'update' | 'delete') {
		super(`Cannot ${action} the system credential resolver.`);
	}
}
