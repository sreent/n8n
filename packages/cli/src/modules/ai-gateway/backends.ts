import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

/**
 * The backends of a provider: another service that serves the API of the provider, with another
 * credential type. Azure OpenAI serves the OpenAI API, and Vertex AI serves the Gemini API. The
 * nodes do not change: they call the gateway as before. See `README.md`, "Backends".
 */

/** A string field of a credential, without spaces at the ends. */
export function stringField(data: ICredentialDataDecryptedObject, field: string) {
	const value = data[field];
	return typeof value === 'string' ? value.trim() : '';
}

// ── Azure OpenAI ─────────────────────────────────────────────────────────────

const AZURE_RESOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/i;

/** The name of an Azure OpenAI deployment, which the calls send as the model. */
export const AZURE_DEPLOYMENT_NAME = /^[\w.-]{1,64}$/;

/** Adds `/openai/v1` to an endpoint of Azure, unless the endpoint has it. */
function withOpenAiV1Path(endpoint: string) {
	const base = endpoint.replace(/\/+$/, '');
	if (/\/openai\/v1$/i.test(base)) return base;
	if (/\/openai$/i.test(base)) return `${base}/v1`;
	return `${base}/openai/v1`;
}

/**
 * The base URL of the v1 API of an Azure OpenAI resource, from a credential of the type
 * `azureOpenAiApi`: the endpoint of the credential, else the resource name. `undefined` when the
 * credential has neither. The v1 API needs no `api-version`.
 */
export function azureOpenAiBaseUrl(data: ICredentialDataDecryptedObject): string | undefined {
	// An Azure AI Foundry credential has only its endpoint: its classic fields can be old values.
	if (stringField(data, 'endpointType') === 'foundry') {
		const foundryEndpoint = stringField(data, 'foundryEndpoint');
		return foundryEndpoint ? withOpenAiV1Path(foundryEndpoint) : undefined;
	}
	const endpoint = stringField(data, 'endpoint');
	if (endpoint) return withOpenAiV1Path(endpoint);
	const resourceName = stringField(data, 'resourceName');
	if (!AZURE_RESOURCE_NAME.test(resourceName)) return undefined;
	return `https://${resourceName}.openai.azure.com/openai/v1`;
}

// ── Vertex AI ────────────────────────────────────────────────────────────────

/** A location of Vertex AI, for example `global`, `us`, `eu` or `europe-west4`. */
export const VERTEX_LOCATION = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

/** A project of Google Cloud: its id, an id with a domain, or its number. */
export const GOOGLE_CLOUD_PROJECT = /^([a-z][a-z0-9.:-]{4,61}[a-z0-9]|\d{1,20})$/;

/** The multi-region locations, which have their own host. */
const MULTI_REGION_LOCATIONS = new Set(['eu', 'us']);

/** The host of the API of Vertex AI in a location. */
export function vertexHost(location: string) {
	if (location === 'global') return 'aiplatform.googleapis.com';
	if (MULTI_REGION_LOCATIONS.has(location)) return `aiplatform.${location}.rep.googleapis.com`;
	return `${location}-aiplatform.googleapis.com`;
}

/** The project of a service account, from its e-mail: `name@<project>.iam.gserviceaccount.com`. */
export function projectOfServiceAccount(email: string) {
	return /@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/i
		.exec(email.trim())?.[1]
		?.toLowerCase();
}

export interface VertexTarget {
	project: string;
	location: string;
}

/**
 * The project and the location of the calls to Vertex AI: the settings of the gateway first, then
 * the e-mail and the region of the `googleApi` credential. `undefined` without a project.
 */
export function vertexTarget(
	settings: { projectId?: string; location?: string },
	data: ICredentialDataDecryptedObject,
): VertexTarget | undefined {
	const project = settings.projectId ?? projectOfServiceAccount(stringField(data, 'email'));
	if (!project || !GOOGLE_CLOUD_PROJECT.test(project)) return undefined;
	const region = stringField(data, 'region');
	const location =
		settings.location ?? (VERTEX_LOCATION.test(region) ? region : undefined) ?? 'global';
	return { project, location };
}

/** A call of the Gemini API to a model: `/v1beta/models/<model>:<action>`. */
const GEMINI_MODEL_CALL = /^\/(?:v1|v1beta|v1alpha)\/models\/([^/:]+):([a-zA-Z]+)$/;

/** The model and the action of a call of the Gemini API, or `undefined` for another path. */
export function geminiModelCall(rest: string) {
	const call = GEMINI_MODEL_CALL.exec(rest);
	return call ? { model: call[1], action: call[2] } : undefined;
}

/** The model of a request for the details of a model: `/v1beta/models/<model>`. */
export function geminiModelInfo(rest: string) {
	return /^\/(?:v1|v1beta|v1alpha)\/models\/([^/:]+)$/.exec(rest)?.[1];
}

/** The path on Vertex AI of an action of a Gemini model. */
export function vertexModelPath(target: VertexTarget, model: string, action: string) {
	return `/v1/projects/${target.project}/locations/${target.location}/publishers/google/models/${model}:${action}`;
}

/**
 * The model list of the Gemini API, made from the models that have a price, because the gateway
 * offers only these. The Gemini nodes read `name` and `supportedGenerationMethods`.
 */
export function geminiModelList(models: string[]) {
	return {
		models: models.map((model) => ({
			name: `models/${model}`,
			baseModelId: model,
			displayName: model,
			description: '',
			supportedGenerationMethods: model.includes('embedding')
				? ['embedContent', 'batchEmbedContents']
				: ['generateContent', 'countTokens'],
		})),
	};
}

/** A model list of the OpenAI API, for the models that the gateway offers. */
export function openAiModelList(models: string[], ownedBy: string) {
	return {
		object: 'list',
		data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: ownedBy })),
	};
}

/**
 * Whether a model id names its publisher, as the open models of Vertex AI do: for example
 * `meta/llama-3.3-70b-instruct-maas`. OpenAI models and Azure deployments have no `/`.
 */
export function isPublisherModel(model: string) {
	return /^[a-z0-9][\w.-]*\/[^/\s]+$/i.test(model);
}

/** The path of the Chat Completions of the OpenAI-compatible endpoint of Vertex AI. */
export function vertexChatCompletionsPath(target: VertexTarget) {
	return `/v1/projects/${target.project}/locations/${target.location}/endpoints/openapi/chat/completions`;
}
