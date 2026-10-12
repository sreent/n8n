import type {
	EvaluationApiError as EvaluationApiErrorBody,
	EvaluationErrorCode,
} from '@n8n/api-types';

/**
 * Fork code (not in upstream n8n): an error of the evaluation configs with a typed code. The REST
 * API answers with `toResponse()` as the body. See `FORK.md` in this folder.
 */
export class EvaluationApiError extends Error {
	constructor(
		readonly code: EvaluationErrorCode,
		message: string,
		readonly details?: EvaluationApiErrorBody['details'],
	) {
		super(message);
		this.name = 'EvaluationApiError';
	}

	toResponse(): EvaluationApiErrorBody {
		return {
			code: this.code,
			message: this.message,
			...(this.details ? { details: this.details } : {}),
		};
	}
}
