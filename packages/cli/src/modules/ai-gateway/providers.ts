/**
 * The providers that the gateway serves, keyed by the credential type of their nodes. The gateway
 * changes the URL field of a credential, so a credential type needs a base URL field. See
 * `README.md`, "Providers".
 */

/** The request and answer format of a provider API. */
export type AiGatewayApiFormat = 'openai' | 'anthropic' | 'gemini' | 'ollama';

/** Where the node sends the API key, and where the proxy puts the key of the admin. */
export type AiGatewayAuthStyle = 'bearer' | 'x-api-key' | 'google';

/** Another service that serves the API of a provider. See `backends.ts`. */
export type AiGatewayBackendKind = 'azure-openai' | 'vertex-ai';

export interface AiGatewayBackend {
	kind: AiGatewayBackendKind;
	/** The credential type of the admin's credential for this backend. */
	credentialType: string;
	displayName: string;
	/** The operations of the app nodes that work with this backend, when they differ. */
	supportedActions?: Record<string, Record<string, string[]>>;
}

export interface AiGatewayProvider {
	/** The provider in the gateway path and in the usage, for example `openai`. */
	slug: string;
	credentialType: string;
	displayName: string;
	/** The path that the URL field of the node gets, after the base URL of the gateway. */
	gatewayPath: string;
	urlField: string;
	apiKeyField: string;
	/** The base URL when the credential of the admin has none. */
	defaultBaseUrl: string;
	format: AiGatewayApiFormat;
	auth: AiGatewayAuthStyle;
	/** The node types that can use the gateway with this credential type. */
	nodes: string[];
	/** The resources and operations of app nodes that the gateway can price. */
	supportedActions?: Record<string, Record<string, string[]>>;
	minNodeTypeVersion?: Record<string, number>;
	/** Node parameters that must stay unset, because they change the URL of the calls. */
	hiddenNodeProperties?: Record<string, string[]>;
	/** Self-hosted models: the price is 0 unless the admin sets one. */
	freeByDefault?: boolean;
	/** The other services that can serve the calls, with a credential of another type. */
	backends?: AiGatewayBackend[];
}

const lc = (name: string) => `@n8n/n8n-nodes-langchain.${name}`;

const openAiCompatible = (
	provider: Omit<
		AiGatewayProvider,
		'urlField' | 'apiKeyField' | 'format' | 'auth' | 'gatewayPath'
	> & { gatewayPath?: string },
): AiGatewayProvider => ({
	urlField: 'url',
	apiKeyField: 'apiKey',
	format: 'openai',
	auth: 'bearer',
	gatewayPath: `/v1/gateway/${provider.slug}`,
	...provider,
});

export const AI_GATEWAY_PROVIDERS: readonly AiGatewayProvider[] = [
	{
		slug: 'openai',
		credentialType: 'openAiApi',
		displayName: 'OpenAI',
		// The OpenAI chat model node splits the last path segment off as the API version.
		gatewayPath: '/v1/gateway/openai/v1',
		urlField: 'url',
		apiKeyField: 'apiKey',
		defaultBaseUrl: 'https://api.openai.com/v1',
		format: 'openai',
		auth: 'bearer',
		nodes: [lc('lmChatOpenAi'), lc('lmOpenAi'), lc('embeddingsOpenAi'), lc('openAi')],
		supportedActions: {
			[lc('openAi')]: { text: ['response', 'classify'], image: ['analyze'] },
		},
		minNodeTypeVersion: { [lc('openAi')]: 2 },
		hiddenNodeProperties: {
			[lc('lmChatOpenAi')]: ['baseURL'],
			[lc('lmOpenAi')]: ['baseURL'],
			[lc('embeddingsOpenAi')]: ['baseURL'],
		},
		backends: [
			{ kind: 'azure-openai', credentialType: 'azureOpenAiApi', displayName: 'Azure OpenAI' },
		],
	},
	{
		slug: 'anthropic',
		credentialType: 'anthropicApi',
		displayName: 'Anthropic',
		gatewayPath: '/v1/gateway/anthropic',
		urlField: 'url',
		apiKeyField: 'apiKey',
		defaultBaseUrl: 'https://api.anthropic.com',
		format: 'anthropic',
		auth: 'x-api-key',
		nodes: [lc('lmChatAnthropic'), lc('anthropic')],
		supportedActions: {
			[lc('anthropic')]: { text: ['message'], document: ['analyze'], image: ['analyze'] },
		},
	},
	{
		slug: 'google',
		credentialType: 'googlePalmApi',
		displayName: 'Google Gemini',
		gatewayPath: '/v1/gateway/google',
		urlField: 'host',
		apiKeyField: 'apiKey',
		defaultBaseUrl: 'https://generativelanguage.googleapis.com',
		format: 'gemini',
		auth: 'google',
		nodes: [lc('lmChatGoogleGemini'), lc('embeddingsGoogleGemini'), lc('googleGemini')],
		supportedActions: {
			[lc('googleGemini')]: { text: ['message'], document: ['analyze'], image: ['analyze'] },
		},
		backends: [
			{
				kind: 'vertex-ai',
				credentialType: 'googleApi',
				displayName: 'Vertex AI',
				// Vertex AI has no File API, which the analysis of documents and images uses.
				supportedActions: { [lc('googleGemini')]: { text: ['message'] } },
			},
		],
	},
	openAiCompatible({
		slug: 'xai',
		credentialType: 'xAiApi',
		displayName: 'xAI Grok',
		defaultBaseUrl: 'https://api.x.ai/v1',
		nodes: [lc('lmChatXAiGrok')],
	}),
	openAiCompatible({
		slug: 'deepseek',
		credentialType: 'deepSeekApi',
		displayName: 'DeepSeek',
		defaultBaseUrl: 'https://api.deepseek.com',
		nodes: [lc('lmChatDeepSeek')],
	}),
	openAiCompatible({
		slug: 'openrouter',
		credentialType: 'openRouterApi',
		displayName: 'OpenRouter',
		defaultBaseUrl: 'https://openrouter.ai/api/v1',
		nodes: [lc('lmChatOpenRouter')],
	}),
	openAiCompatible({
		slug: 'moonshot',
		credentialType: 'moonshotApi',
		displayName: 'Moonshot Kimi',
		defaultBaseUrl: 'https://api.moonshot.ai/v1',
		nodes: [lc('lmChatMoonshot'), lc('moonshot')],
		supportedActions: { [lc('moonshot')]: { text: ['message'], image: ['analyze'] } },
	}),
	openAiCompatible({
		slug: 'minimax',
		credentialType: 'minimaxApi',
		displayName: 'MiniMax',
		defaultBaseUrl: 'https://api.minimax.io/v1',
		nodes: [lc('lmChatMinimax'), lc('minimax')],
		supportedActions: { [lc('minimax')]: { text: ['message'] } },
	}),
	openAiCompatible({
		slug: 'qwen',
		credentialType: 'alibabaCloudApi',
		displayName: 'Qwen (Alibaba Cloud)',
		defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com',
		nodes: [lc('lmChatAlibabaCloud'), lc('alibabaCloud')],
		supportedActions: { [lc('alibabaCloud')]: { text: ['message'], image: ['analyze'] } },
	}),
	openAiCompatible({
		slug: 'nvidia',
		credentialType: 'nvidiaApi',
		displayName: 'NVIDIA',
		defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
		nodes: [lc('lmChatNvidia'), lc('embeddingsNvidia')],
	}),
	openAiCompatible({
		slug: 'vercel',
		credentialType: 'vercelAiGatewayApi',
		displayName: 'Vercel AI Gateway',
		defaultBaseUrl: 'https://ai-gateway.vercel.sh/v1',
		nodes: [lc('lmChatVercelAiGateway')],
	}),
	{
		slug: 'ollama',
		credentialType: 'ollamaApi',
		displayName: 'Ollama',
		gatewayPath: '/v1/gateway/ollama',
		urlField: 'baseUrl',
		apiKeyField: 'apiKey',
		defaultBaseUrl: 'http://localhost:11434',
		format: 'ollama',
		auth: 'bearer',
		nodes: [lc('lmChatOllama'), lc('lmOllama'), lc('embeddingsOllama'), lc('ollama')],
		supportedActions: { [lc('ollama')]: { text: ['message'], image: ['analyze'] } },
		freeByDefault: true,
	},
];

export const providerBySlug = (slug: string) =>
	AI_GATEWAY_PROVIDERS.find((provider) => provider.slug === slug);

export const providerByCredentialType = (credentialType: string) =>
	AI_GATEWAY_PROVIDERS.find((provider) => provider.credentialType === credentialType);

/** The credential types that an admin can pick for a provider: its own, then its backends. */
export const credentialTypesOf = (provider: AiGatewayProvider) => [
	provider.credentialType,
	...(provider.backends ?? []).map((backend) => backend.credentialType),
];

/** The backend of a credential type, or `undefined` for the own credential type of the provider. */
export const backendOf = (provider: AiGatewayProvider, credentialType: string) =>
	provider.backends?.find((backend) => backend.credentialType === credentialType);
