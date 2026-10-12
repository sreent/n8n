// Fork test (not in upstream n8n): a golden test of `LlmJudgeProviderRegistry`. It records the
// answer of each method for every node type and credential type of the provider list, and for
// unknown ones. The snapshot was recorded against the enterprise file, and the fork file gives the
// same snapshot. See `packages/cli/src/evaluation/FORK.md`.
import { LLM_JUDGE_PROVIDERS } from '@n8n/api-types';

import { LlmJudgeProviderRegistry } from '@/evaluation/llm-judge-provider-registry';

test('the LLM judge providers', () => {
	const registry = new LlmJudgeProviderRegistry();
	const record: Record<string, unknown> = { listProviders: registry.listProviders() };
	for (const provider of LLM_JUDGE_PROVIDERS) {
		record[`get ${provider.nodeType}`] = registry.get(provider.nodeType) ?? '<undefined>';
		for (const credentialType of provider.credentialTypes) {
			record[`getByCredentialType ${credentialType.name}`] =
				registry.getByCredentialType(credentialType.name)?.nodeType ?? '<undefined>';
		}
	}
	for (const unknown of ['', 'httpBasicAuth', '@n8n/n8n-nodes-langchain.lmChatUnknown']) {
		record[`get "${unknown}"`] = registry.get(unknown) ?? '<undefined>';
		record[`getByCredentialType "${unknown}"`] =
			registry.getByCredentialType(unknown) ?? '<undefined>';
	}
	expect(record).toMatchSnapshot();
});
