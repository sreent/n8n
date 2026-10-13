import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { mock } from 'vitest-mock-extended';
import type { IUser } from 'n8n-workflow';
import { UserError } from 'n8n-workflow';

import {
	AiWorkflowBuilderService,
	ParseValidateHandler,
	WorkflowCodeParseError,
	createPassthroughSsrfGuard,
	getWarningKey,
	isLangchainMessagesArray,
	stripImportStatements,
} from '../index';

describe('stripImportStatements', () => {
	it('removes the import lines and keeps the code', () => {
		const code =
			"import { workflow } from '@n8n/workflow-sdk';\n\nexport default workflow('a', 'b');";
		expect(stripImportStatements(code)).toBe("export default workflow('a', 'b');");
	});

	it('keeps an import in a comment or a string', () => {
		const code = "// import { a } from 'b';\nconst text = \"import x from 'y'\";";
		expect(stripImportStatements(code)).toBe(code);
	});
});

describe('getWarningKey', () => {
	it('uses the code, the node name and the parameter path', () => {
		expect(getWarningKey({ code: 'A', message: 'x', nodeName: 'N', parameterPath: 'p' })).toBe(
			'A|N|p',
		);
		expect(getWarningKey({ code: 'A', message: 'x' })).toBe('A||');
	});
});

describe('ParseValidateHandler', () => {
	const handler = new ParseValidateHandler({ generatePinData: false });

	it('parses workflow code into workflow JSON with stable node IDs', async () => {
		const code = `
const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Start' } });
const end = node({ type: 'n8n-nodes-base.noOp', version: 1, config: { name: 'End' } });
export default workflow('wf-1', 'Test').add(start).to(end);`;
		const first = await handler.parseAndValidate(code);
		const second = await handler.parseAndValidate(code);

		expect(first.workflow.nodes.map((node) => node.name)).toEqual(['Start', 'End']);
		expect(first.workflow.nodes.map((node) => node.id)).toEqual(
			second.workflow.nodes.map((node) => node.id),
		);
		expect(first.workflow.connections.Start.main[0]?.[0]?.node).toBe('End');
		expect(first.warnings).toEqual([]);
	});

	it('gives a WorkflowCodeParseError for code that does not parse', async () => {
		const error = await handler.parseAndValidate('export default workflow(').catch((e) => e);

		expect(error).toBeInstanceOf(WorkflowCodeParseError);
		expect(error.name).toBe('WorkflowCodeParseError');
		expect(error.message).toMatch(/^Failed to parse generated workflow code: /);
	});

	it('gives the warnings of a workflow, without the parameter path', () => {
		const warnings = handler.validateJSON({
			name: 'Test',
			nodes: [
				{
					id: 'n1',
					name: 'Only',
					type: 'n8n-nodes-base.noOp',
					typeVersion: 1,
					position: [0, 0],
					parameters: {},
				},
			],
			connections: {},
		});

		expect(warnings.map((warning) => warning.code)).toEqual([
			'MISSING_TRIGGER',
			'DISCONNECTED_NODE',
		]);
		expect(Object.keys(warnings[1])).toEqual(['code', 'message', 'nodeName']);
	});

	it('gives no warnings for a workflow without nodes', () => {
		expect(handler.validateJSON({ name: 'Empty', nodes: [], connections: {} })).toEqual([]);
	});
});

describe('isLangchainMessagesArray', () => {
	it('is true only for a list of messages', () => {
		expect(isLangchainMessagesArray([])).toBe(true);
		expect(isLangchainMessagesArray([new HumanMessage('hi'), new AIMessage('hello')])).toBe(true);
		expect(isLangchainMessagesArray([{ type: 'human', content: 'hi' }])).toBe(false);
		expect(isLangchainMessagesArray('hi')).toBe(false);
	});
});

describe('createPassthroughSsrfGuard', () => {
	it('allows each address', async () => {
		const guard = createPassthroughSsrfGuard();

		await expect(guard.validateUrl('http://127.0.0.1/')).resolves.toEqual({
			ok: true,
			result: undefined,
		});
		expect(() => guard.validateRedirectSync('http://10.0.0.1/')).not.toThrow();
		expect(typeof guard.createSecureLookup()).toBe('function');
	});
});

describe('AiWorkflowBuilderService', () => {
	const service = new AiWorkflowBuilderService([]);
	const user = mock<IUser>();

	it('fails each chat with a clear message', async () => {
		const chat = service.chat({ id: '1', message: 'hello' }, user);

		await expect(chat.next()).rejects.toThrow(UserError);
		await expect(service.getBuilderInstanceCredits(user)).rejects.toThrow(
			'The AI workflow builder chat is not available in this n8n.',
		);
	});

	it('has no sessions to show or to change', async () => {
		await expect(service.getSessions('wf-1', user)).resolves.toEqual({ sessions: [] });
		await expect(service.clearSession('wf-1', user)).resolves.toBeUndefined();
		await expect(service.truncateMessagesAfter('wf-1', user, 'm1')).resolves.toBe(false);
	});
});
