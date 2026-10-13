import { LLM_JUDGE_PROVIDERS, type LlmJudgeProvider } from '@n8n/api-types';
import { Service } from '@n8n/di';

/**
 * Fork code (not in upstream n8n): the chat model nodes that an LLM judge metric can use, and the
 * credential types that select them. The list is `LLM_JUDGE_PROVIDERS` of `@n8n/api-types`, so
 * the validation of a config and the compiled run use the same providers. See `FORK.md` in this
 * folder.
 */
@Service()
export class LlmJudgeProviderRegistry {
	private readonly byNodeType = new Map<string, LlmJudgeProvider>(
		LLM_JUDGE_PROVIDERS.map((provider) => [provider.nodeType, provider]),
	);

	private readonly byCredentialType = new Map<string, LlmJudgeProvider>(
		LLM_JUDGE_PROVIDERS.flatMap((provider) =>
			provider.credentialTypes.map((credentialType): [string, LlmJudgeProvider] => [
				credentialType.name,
				provider,
			]),
		),
	);

	/** All providers, in the order of the list. */
	listProviders(): LlmJudgeProvider[] {
		return LLM_JUDGE_PROVIDERS;
	}

	/** The provider of a chat model node type, or `undefined`. */
	get(nodeType: string): LlmJudgeProvider | undefined {
		return this.byNodeType.get(nodeType);
	}

	/** The provider that a credential type selects, or `undefined`. */
	getByCredentialType(credentialType: string): LlmJudgeProvider | undefined {
		return this.byCredentialType.get(credentialType);
	}
}
