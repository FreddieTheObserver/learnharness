/**
 * User-defined model endpoints (custom providers): any server that speaks the
 * Anthropic Messages or OpenAI Chat Completions protocol at a base URL the
 * user supplies. Pure and browser-safe: the settings shape, the id/env-var
 * mapping, URL validation, and the strict write-side parser. The engine side
 * lives in src/agent/custom-providers.ts, the server seam in
 * src/server/custom-providers.ts.
 *
 * The config is non-secret and lives in settings.json (`customProviders`,
 * keyed by provider id). The key lives in auth.json under the env var
 * customProviderEnvVar(id), so it rides the same env-reflecting keys seam
 * as every built-in provider.
 */

export const CUSTOM_PROVIDER_APIS = ["anthropic-messages", "openai-completions"] as const;
export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

export const CUSTOM_PROVIDER_API_LABELS: Readonly<Record<CustomProviderApi, string>> = {
	"anthropic-messages": "Anthropic Messages",
	"openai-completions": "OpenAI Chat Completions",
};

/** What each protocol appends to the base URL, for form hints and docs. */
export const CUSTOM_PROVIDER_API_PATHS: Readonly<Record<CustomProviderApi, { request: string; models: string }>> = {
	"anthropic-messages": { request: "/v1/messages", models: "/v1/models" },
	"openai-completions": { request: "/chat/completions", models: "/models" },
};

export interface CustomProviderModel {
	id: string;
	contextWindow: number;
	maxTokens: number;
	/** Sends the protocol's thinking/reasoning parameter when a level is set. */
	reasoning: boolean;
	/** Accepts image input (qualifies the model for the vision slot). */
	images: boolean;
}

export interface CustomProviderConfig {
	label: string;
	api: CustomProviderApi;
	baseUrl: string;
	models: CustomProviderModel[];
}

/** The settings.json section, keyed by provider id. */
export type CustomProvidersSettings = Record<string, CustomProviderConfig>;

/** Discovery endpoints report ids only, so new rows start from these. */
export const CUSTOM_MODEL_DEFAULTS: Readonly<Omit<CustomProviderModel, "id">> = {
	contextWindow: 128_000,
	maxTokens: 16_384,
	reasoning: false,
	images: false,
};

export const CUSTOM_CONTEXT_WINDOW_MIN = 1_024;
export const CUSTOM_CONTEXT_WINDOW_MAX = 10_000_000;
export const CUSTOM_MAX_TOKENS_MIN = 256;
const MAX_MODELS = 200;
const MAX_LABEL = 60;
const MAX_MODEL_ID = 200;

const PROVIDER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_VAR = /^LH_CUSTOM_[A-Z0-9]+(?:_[A-Z0-9]+)*_API_KEY$/;

export function isValidCustomProviderId(id: string): boolean {
	return id.length >= 2 && id.length <= 32 && PROVIDER_ID.test(id);
}

/** Ids allow no underscores, so the hyphen-to-underscore map is injective. */
export function customProviderEnvVar(id: string): string {
	return `LH_CUSTOM_${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

export function isCustomProviderEnvVar(name: string): boolean {
	return ENV_VAR.test(name);
}

/** A suggested id for a new endpoint's label ("KMUTT SIT" -> "kmutt-sit"). */
export function slugifyProviderLabel(label: string): string {
	return label
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/, "");
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type BaseUrlResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * The endpoint gate. Keys are sent to this URL, so it must be https (plain
 * http only on loopback), carry no embedded credentials, query or fragment,
 * and stop before the protocol's own request path.
 */
export function parseCustomBaseUrl(raw: string, api: CustomProviderApi): BaseUrlResult {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false, error: "Base URL is required" };
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { ok: false, error: "Base URL must be a full URL, e.g. https://example.com/api" };
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
		return { ok: false, error: "Base URL must use https (plain http is allowed only for localhost)" };
	}
	if (url.username || url.password) {
		return { ok: false, error: "Base URL must not contain a username or password; put the key in the API key field" };
	}
	if (url.search || url.hash || trimmed.includes("?") || trimmed.includes("#")) {
		return { ok: false, error: "Base URL must not contain a query string or fragment" };
	}
	const path = url.pathname.replace(/\/+$/, "");
	const requestPath = CUSTOM_PROVIDER_API_PATHS[api].request;
	for (const suffix of ["/v1/messages", "/messages", "/chat/completions", "/completions", "/models"]) {
		if (path.endsWith(suffix)) {
			return {
				ok: false,
				error: `Base URL must stop before "${suffix}"; LearnHarness appends ${requestPath} itself`,
			};
		}
	}
	return { ok: true, url: `${url.origin}${path}` };
}

/** Where a protocol lists models: Anthropic GET {base}/v1/models, OpenAI GET {base}/models. */
export function customModelsListUrl(api: CustomProviderApi, baseUrl: string): string {
	return `${baseUrl}${CUSTOM_PROVIDER_API_PATHS[api].models}`;
}

/** Both protocols answer `{ data: [{ id }] }`; anything else yields no ids. */
export function parseModelListIds(body: unknown): string[] {
	if (!body || typeof body !== "object") return [];
	const data = (body as { data?: unknown }).data;
	if (!Array.isArray(data)) return [];
	const ids = new Set<string>();
	for (const entry of data) {
		const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
		if (typeof id === "string" && isValidModelId(id)) ids.add(id);
	}
	return [...ids].sort((a, b) => a.localeCompare(b));
}

function isValidModelId(id: string): boolean {
	return id.length > 0 && id.length <= MAX_MODEL_ID && !/\s/.test(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isApi(value: unknown): value is CustomProviderApi {
	return typeof value === "string" && (CUSTOM_PROVIDER_APIS as readonly string[]).includes(value);
}

function isIntIn(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export type CustomProviderParse = { ok: true; config: CustomProviderConfig } | { ok: false; error: string };

/** The strict write-side parser: every bad field is a 400 naming the field. */
export function parseCustomProviderConfig(raw: unknown): CustomProviderParse {
	if (!isRecord(raw)) return { ok: false, error: "Invalid JSON body" };
	const label = typeof raw.label === "string" ? raw.label.trim() : "";
	if (!label) return { ok: false, error: "Name is required" };
	if (label.length > MAX_LABEL) return { ok: false, error: `Name must be at most ${MAX_LABEL} characters` };
	if (!isApi(raw.api)) {
		return { ok: false, error: `Protocol must be one of: ${CUSTOM_PROVIDER_APIS.join(", ")}` };
	}
	if (typeof raw.baseUrl !== "string") return { ok: false, error: "Base URL is required" };
	const baseUrl = parseCustomBaseUrl(raw.baseUrl, raw.api);
	if (!baseUrl.ok) return baseUrl;
	if (!Array.isArray(raw.models)) return { ok: false, error: "models must be a list" };
	if (raw.models.length > MAX_MODELS) return { ok: false, error: `At most ${MAX_MODELS} models per endpoint` };
	const models: CustomProviderModel[] = [];
	const seen = new Set<string>();
	for (const entry of raw.models) {
		if (!isRecord(entry)) return { ok: false, error: "Each model must be an object" };
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		if (!isValidModelId(id)) return { ok: false, error: "Model ids must be non-empty with no spaces" };
		if (seen.has(id)) return { ok: false, error: `Model "${id}" is listed twice` };
		seen.add(id);
		if (!isIntIn(entry.contextWindow, CUSTOM_CONTEXT_WINDOW_MIN, CUSTOM_CONTEXT_WINDOW_MAX)) {
			return {
				ok: false,
				error: `${id}: context window must be a whole number from ${CUSTOM_CONTEXT_WINDOW_MIN} to ${CUSTOM_CONTEXT_WINDOW_MAX}`,
			};
		}
		if (!isIntIn(entry.maxTokens, CUSTOM_MAX_TOKENS_MIN, entry.contextWindow)) {
			return {
				ok: false,
				error: `${id}: max output must be a whole number from ${CUSTOM_MAX_TOKENS_MIN} up to the context window`,
			};
		}
		if (typeof entry.reasoning !== "boolean" || typeof entry.images !== "boolean") {
			return { ok: false, error: `${id}: thinking and images must be true or false` };
		}
		models.push({
			id,
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens,
			reasoning: entry.reasoning,
			images: entry.images,
		});
	}
	return { ok: true, config: { label, api: raw.api, baseUrl: baseUrl.url, models } };
}

/** The lenient read side (disk records): invalid entries drop, never throw. */
export function sanitizeCustomProviders(raw: unknown): CustomProvidersSettings | undefined {
	if (!isRecord(raw)) return undefined;
	const out: CustomProvidersSettings = {};
	for (const [id, value] of Object.entries(raw)) {
		if (!isValidCustomProviderId(id)) continue;
		const parsed = parseCustomProviderConfig(value);
		if (parsed.ok) out[id] = parsed.config;
	}
	return out;
}
