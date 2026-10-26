import { createProvider, envApiKeyAuth, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
	customProviderEnvVar,
	type CustomProviderConfig,
	type CustomProviderModel,
	type CustomProvidersSettings,
} from "../core/custom-providers.ts";

/**
 * Turns user-defined endpoint configs into pi-ai providers. The agent layer
 * cannot read settings, so the server publishes the configs here
 * (setCustomProviderConfigs) and piModels() applies them on its next call.
 * The registry is globalThis-anchored so every module instance (HMR, route
 * bundles) sees the same configs.
 */

interface Registry {
	revision: number;
	signature: string;
	configs: CustomProvidersSettings;
}

const REGISTRY_KEY = Symbol.for("lh.customProviders");

function registry(): Registry {
	const g = globalThis as Record<symbol, Registry | undefined>;
	if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = { revision: 0, signature: "{}", configs: {} };
	return g[REGISTRY_KEY];
}

export function setCustomProviderConfigs(configs: CustomProvidersSettings): void {
	const state = registry();
	const signature = JSON.stringify(configs);
	if (signature === state.signature) return;
	state.signature = signature;
	state.configs = configs;
	state.revision += 1;
}

export function customProviderConfigs(): CustomProvidersSettings {
	return registry().configs;
}

export function customProviderRevision(): number {
	return registry().revision;
}

function customModel(providerId: string, config: CustomProviderConfig, model: CustomProviderModel): Model<Api> {
	return {
		id: model.id,
		name: model.id,
		api: config.api,
		provider: providerId,
		baseUrl: config.baseUrl,
		reasoning: model.reasoning,
		input: model.images ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

/** The key is read from the env per request, like every built-in provider. */
export function customProvider(id: string, config: CustomProviderConfig): Provider {
	return createProvider({
		id,
		name: config.label,
		baseUrl: config.baseUrl,
		auth: { apiKey: envApiKeyAuth(`${config.label} API key`, [customProviderEnvVar(id)]) },
		models: config.models.map((model) => customModel(id, config, model)),
		api: config.api === "anthropic-messages" ? anthropicMessagesApi() : openAICompletionsApi(),
	});
}
