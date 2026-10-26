/**
 * The custom-endpoint service behind /api/custom-providers: config writes
 * (settings.json), key writes (auth.json through the keys seam), model
 * discovery, and a one-request connection test. Every write republishes the
 * configs to the agent-layer registry, so engines and the picker see the
 * change without a restart.
 *
 * Credential rule: a stored key only ever travels to the base URL it was
 * saved with. Moving an endpoint to a new origin drops its file-stored key
 * unless a new key arrives in the same save, and discovery attaches the key
 * only when the request names the saved protocol and base URL.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { genericProviderKeyGuard } from "../core/auth-keys.ts";
import {
	customModelsListUrl,
	customProviderEnvVar,
	isValidCustomProviderId,
	parseCustomBaseUrl,
	parseCustomProviderConfig,
	parseModelListIds,
	CUSTOM_PROVIDER_APIS,
	CUSTOM_PROVIDER_API_PATHS,
	type CustomProviderApi,
	type CustomProviderConfig,
	type CustomProvidersSettings,
} from "../core/custom-providers.ts";
import { NATIVE_SUBSCRIPTIONS } from "../core/contracts/subscriptions.ts";
import { builtinProviderIds, piModels } from "../agent/models.ts";
import { customProviderConfigs, setCustomProviderConfigs } from "../agent/custom-providers.ts";
import { settingsStore } from "../store/settings.ts";
import { deleteKey, keyStatuses, keyValue, saveKey } from "./keys.ts";

const DISCOVERY_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 60_000;
const ANTHROPIC_VERSION = "2023-06-01";

export function syncCustomProviders(): void {
	setCustomProviderConfigs(settingsStore.readSettings()?.customProviders ?? {});
}

function reservedProviderIds(): Set<string> {
	return new Set([...builtinProviderIds(), "chatgpt", ...NATIVE_SUBSCRIPTIONS.map((p) => p.logicalId)]);
}

export interface CustomProviderView extends CustomProviderConfig {
	id: string;
	envVar: string;
	key: { present: boolean; masked: string | null; source: "env" | "file" | "none" };
}

function view(id: string, config: CustomProviderConfig): CustomProviderView {
	const envVar = customProviderEnvVar(id);
	const status = keyStatuses().find((s) => s.id === envVar);
	return {
		id,
		...config,
		envVar,
		key: status
			? { present: status.present, masked: status.masked, source: status.source }
			: { present: false, masked: null, source: "none" },
	};
}

export function customProviderViews(): CustomProviderView[] {
	return Object.entries(customProviderConfigs())
		.map(([id, config]) => view(id, config))
		.sort((a, b) => a.label.localeCompare(b.label));
}

export type CustomProviderFailure = { ok: false; status: number; error: string };
export type CustomProviderSave = { ok: true; provider: CustomProviderView; keyCleared: boolean } | CustomProviderFailure;

function readConfigs(): CustomProvidersSettings {
	return settingsStore.readSettings()?.customProviders ?? {};
}

function writeConfigs(configs: CustomProvidersSettings): void {
	const record = settingsStore.readSettings() ?? { version: 1 };
	settingsStore.writeSettings({ ...record, customProviders: configs });
	syncCustomProviders();
}

/** Create or replace one endpoint. `apiKey` is optional on edits: absent keeps the stored key. */
export function saveCustomProvider(id: string, body: unknown): CustomProviderSave {
	if (!isValidCustomProviderId(id)) {
		return { ok: false, status: 400, error: "ID must be 2-32 lowercase letters, digits or single hyphens" };
	}
	const configs = readConfigs();
	const existing = Object.hasOwn(configs, id) ? configs[id] : undefined;
	if (!existing && reservedProviderIds().has(id)) {
		return { ok: false, status: 409, error: `"${id}" is a built-in provider; choose another ID` };
	}
	const parsed = parseCustomProviderConfig(body);
	if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
	const config = parsed.config;

	const rawKey = (body as { apiKey?: unknown }).apiKey;
	if (rawKey !== undefined && typeof rawKey !== "string") {
		return { ok: false, status: 400, error: "API key must be text" };
	}
	const apiKey = rawKey?.trim() ? rawKey.trim() : undefined;
	if (apiKey) {
		const shape = genericProviderKeyGuard("API key", apiKey);
		if (!shape.ok) return { ok: false, status: 400, error: shape.error };
	}

	const envVar = customProviderEnvVar(id);
	if (!existing && !apiKey && keyValue(envVar) === undefined) {
		return { ok: false, status: 400, error: "API key is required" };
	}

	let keyCleared = false;
	const originChanged = existing !== undefined && new URL(existing.baseUrl).origin !== new URL(config.baseUrl).origin;
	if (originChanged && !apiKey && keyStatuses().find((s) => s.id === envVar)?.source === "file") {
		deleteKey(envVar);
		keyCleared = true;
	}

	writeConfigs({ ...configs, [id]: config });
	if (apiKey) {
		const saved = saveKey(envVar, apiKey);
		if (!saved.ok) return { ok: false, status: 400, error: saved.error };
	}
	return { ok: true, provider: view(id, config), keyCleared };
}

export function deleteCustomProvider(id: string): { ok: true } | CustomProviderFailure {
	const configs = readConfigs();
	if (!Object.hasOwn(configs, id)) return { ok: false, status: 404, error: `No custom endpoint "${id}"` };
	const rest = { ...configs };
	delete rest[id];
	writeConfigs(rest);
	deleteKey(customProviderEnvVar(id));
	return { ok: true };
}

function redact(text: string, secret: string | undefined): string {
	return secret && secret.length >= 8 ? text.split(secret).join("[redacted]") : text;
}

/** SDK errors arrive as `401 {"error":{"message":...}}`; keep the status and the message. */
export function describeProviderError(raw: string): string {
	const match = /^(\d{3})\s+(\{[\s\S]*\})\s*$/.exec(raw.trim());
	if (!match?.[1] || !match[2]) return raw;
	let message: unknown;
	try {
		const body = JSON.parse(match[2]) as { error?: { message?: unknown } | string; message?: unknown };
		message = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message);
	} catch {
		return raw;
	}
	if (typeof message !== "string" || !message) return raw;
	const status = Number(match[1]);
	const hint =
		status === 401 || status === 403
			? " (check the API key)"
			: status === 404
				? " (check the base URL and model ID)"
				: status === 429
					? " (rate limited; try again later)"
					: "";
	return `HTTP ${status}: ${message}${hint}`;
}

function authHeaders(api: CustomProviderApi, key: string | undefined): Record<string, string> {
	if (api === "anthropic-messages") {
		return { "anthropic-version": ANTHROPIC_VERSION, ...(key ? { "x-api-key": key } : {}) };
	}
	return key ? { authorization: `Bearer ${key}` } : {};
}

function networkReason(error: unknown): string {
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return `no answer within ${DISCOVERY_TIMEOUT_MS / 1000}s`;
	}
	const cause = error instanceof Error ? (error.cause as { code?: string; message?: string } | undefined) : undefined;
	return cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
}

export type CustomModelDiscovery = { ok: true; models: string[]; authenticated: boolean } | CustomProviderFailure;

/**
 * Lists the endpoint's model ids. Works before the endpoint is saved (many
 * gateways list models without a key); the stored key is attached only when
 * the request names the saved protocol and base URL, and then redirects are
 * refused so the key cannot be forwarded elsewhere.
 */
export async function discoverCustomModels(id: string, body: unknown): Promise<CustomModelDiscovery> {
	const raw = body && typeof body === "object" ? (body as { api?: unknown; baseUrl?: unknown }) : {};
	if (typeof raw.api !== "string" || !(CUSTOM_PROVIDER_APIS as readonly string[]).includes(raw.api)) {
		return { ok: false, status: 400, error: `Protocol must be one of: ${CUSTOM_PROVIDER_APIS.join(", ")}` };
	}
	const api = raw.api as CustomProviderApi;
	const base = parseCustomBaseUrl(typeof raw.baseUrl === "string" ? raw.baseUrl : "", api);
	if (!base.ok) return { ok: false, status: 400, error: base.error };

	const saved = Object.hasOwn(customProviderConfigs(), id) ? customProviderConfigs()[id] : undefined;
	const key = saved && saved.api === api && saved.baseUrl === base.url ? keyValue(customProviderEnvVar(id)) : undefined;
	const url = customModelsListUrl(api, base.url);

	let response: Response;
	try {
		response = await fetch(url, {
			headers: { accept: "application/json", ...authHeaders(api, key) },
			redirect: key ? "error" : "follow",
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
		});
	} catch (error) {
		return { ok: false, status: 502, error: redact(`Could not reach ${new URL(url).host}: ${networkReason(error)}`, key) };
	}
	if (response.status === 401 || response.status === 403) {
		return {
			ok: false,
			status: 502,
			error: key
				? `The endpoint rejected the saved API key (HTTP ${response.status})`
				: `The model list needs an API key (HTTP ${response.status}); save the endpoint with its key, then fetch again`,
		};
	}
	if (response.status === 404 || response.status === 405) {
		return {
			ok: false,
			status: 502,
			error: `No model list at ${CUSTOM_PROVIDER_API_PATHS[api].models} (HTTP ${response.status}); enter model IDs by hand`,
		};
	}
	if (!response.ok) {
		return { ok: false, status: 502, error: `Model list request failed (HTTP ${response.status})` };
	}
	const json = await response.json().catch(() => null);
	const models = parseModelListIds(json);
	if (models.length === 0) {
		return { ok: false, status: 502, error: "The endpoint answered but listed no models; enter model IDs by hand" };
	}
	return { ok: true, models, authenticated: key !== undefined };
}

function replyText(message: AssistantMessage): string {
	return message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("")
		.trim();
}

export type CustomProviderTest = { ok: true; reply: string; ms: number } | CustomProviderFailure;

/** One tiny real request through the same engine path chats use. */
export async function testCustomProvider(id: string, body: unknown): Promise<CustomProviderTest> {
	const configs = customProviderConfigs();
	const config = Object.hasOwn(configs, id) ? configs[id] : undefined;
	if (!config) return { ok: false, status: 404, error: `No custom endpoint "${id}"` };
	const modelId = body && typeof body === "object" ? (body as { model?: unknown }).model : undefined;
	if (typeof modelId !== "string" || !config.models.some((m) => m.id === modelId)) {
		return { ok: false, status: 400, error: "Pick one of the endpoint's models to test" };
	}
	const key = keyValue(customProviderEnvVar(id));
	if (key === undefined) return { ok: false, status: 400, error: "No API key is saved for this endpoint" };
	const model = piModels().getModel(id, modelId);
	if (!model) return { ok: false, status: 500, error: `Model "${modelId}" is not registered` };

	const started = Date.now();
	let message: AssistantMessage;
	try {
		message = await piModels().completeSimple(
			model,
			{ messages: [{ role: "user", content: "Reply with the single word: ok", timestamp: started }] },
			{ maxTokens: Math.min(1_024, model.maxTokens), signal: AbortSignal.timeout(TEST_TIMEOUT_MS) },
		);
	} catch (error) {
		return { ok: false, status: 502, error: redact(error instanceof Error ? error.message : String(error), key) };
	}
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		const detail = message.errorMessage ?? (message.stopReason === "aborted" ? `no answer within ${TEST_TIMEOUT_MS / 1000}s` : "unknown error");
		return { ok: false, status: 502, error: redact(describeProviderError(detail), key) };
	}
	return { ok: true, reply: replyText(message).slice(0, 200), ms: Date.now() - started };
}

syncCustomProviders();
