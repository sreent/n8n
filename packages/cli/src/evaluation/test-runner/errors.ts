import type { TestCaseExecutionErrorCode, TestRunErrorCode } from '@n8n/db';
import type { IDataObject } from 'n8n-workflow';
import { UnexpectedError } from 'n8n-workflow';

/**
 * Fork code (not in upstream n8n): an error that ends a test run. The run keeps `code` as its
 * `errorCode` and `extra` as its `errorDetails`. See `../FORK.md`.
 */
export class TestRunError extends UnexpectedError {
	constructor(
		readonly code: TestRunErrorCode,
		readonly extra: IDataObject = {},
	) {
		super('Test run failed', { extra });
	}
}

/**
 * Fork code (not in upstream n8n): an error that ends one case of a test run. The case keeps
 * `code` as its `errorCode` and `extra` as its `errorDetails`. See `../FORK.md`.
 */
export class TestCaseExecutionError extends UnexpectedError {
	constructor(
		readonly code: TestCaseExecutionErrorCode,
		readonly extra: IDataObject = {},
	) {
		super('Test case execution failed', { extra });
	}
}
