/**
 * Custom endpoints end to end, with every HTTP call mocked: settings and
 * key storage, registration into the pi-ai collection, the picker catalog,
 * the request each protocol actually sends, discovery, and error handling.
 * LH_DATA_DIR and LH_AUTH_FILE point at a fresh tmp dir before any import
 * (both seams bind at module load). All keys are throwaway strings.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";

for (const name of Object.keys(process.env)) if (name.startsWith("LH_CUSTOM_")) delete process.env[name];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-providers-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const server = await import("../src/server/custom-providers.ts");
const { keyStatuses, isWritableAuthKey, providerKeyPresent } = await import("../src/server/keys.ts");
const { catalogProviders, modelCatalog, validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { authStore } = await import("../src/store/auth.ts");

const KEY = "sk-test-custom-endpoint-0001";
const OTHER_KEY = "sk-test-custom-endpoint-0002";
const BASE = "https://gateway.example.test/api";
const ENV_VAR = "LH_CUSTOM_TEST_GW_API_KEY";

const model = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	contextWindow: 128_000,
	maxTokens: 16_384,
	reasoning: false,
	images: false,
	...extra,
});
const config = (extra: Record<string, unknown> = {}) => ({
	label: "Test Gateway",
	api: "anthropic-messages",
	baseUrl: BASE,
	models: [model("model-a", { reasoning: true, images: true }), model("model-b")],
	...extra,
});

// ─── fetch mock ──────────────────────────────────────────────────────────────

interface Call {
	url: string;
	method: string;
	headers: Headers;
	body: unknown;
	redirect: RequestRedirect | undefined;
}
let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response> = () => new Response("unmocked", { status: 500 });
const realFetch = globalThis.fetch;

beforeEach(() => {
	calls = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : undefined;
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const rawBody = init?.body ?? (request ? await request.clone().text() : undefined);
		const call: Call = {
			url,
			method: init?.method ?? request?.method ?? "GET",
			headers: new Headers(init?.headers ?? request?.headers),
			body: typeof rawBody === "string" && rawBody ? JSON.parse(rawBody) : undefined,
			redirect: init?.redirect,
		};
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function sse(events: readonly unknown[], named: boolean): Response {
	const text = events
		.map((event) => {
			const data = typeof event === "string" ? event : JSON.stringify(event);
			const name = named && typeof event === "object" ? `event: ${(event as { type: string }).type}\n` : "";
			return `${name}data: ${data}\n\n`;
		})
		.join("");
	return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const anthropicOk = () =>
	sse(
		[
			{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "model-a", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		],
		true,
	);

const openAIOk = () =>
	sse(
		[
			{ id: "c1", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
			{ id: "c1", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
			"[DONE]",
		],
		false,
	);

function saveOk(body: Record<string, unknown>, id = "test-gw") {
	const result = server.saveCustomProvider(id, body);
	assert.equal(result.ok, true, result.ok ? "" : result.error);
	return result as Extract<typeof result, { ok: true }>;
}

const readSettingsFile = () => fs.readFileSync(path.join(TMP, "settings.json"), "utf-8");

// ─── tests ───────────────────────────────────────────────────────────────────

describe("saving an endpoint", () => {
	it("stores the config in settings.json and the key only in auth.json", () => {
		const { provider, keyCleared } = saveOk({ ...config(), apiKey: KEY });
		assert.equal(keyCleared, false);
		assert.equal(provider.envVar, ENV_VAR);
		assert.deepEqual(provider.key, { present: true, masked: "…0001 (28 chars)", source: "file" });
		assert.equal(authStore.authVars()[ENV_VAR], KEY);
		const settings = readSettingsFile();
		assert.ok(!settings.includes(KEY), "settings.json must never hold the key");
		assert.equal(JSON.parse(settings).customProviders["test-gw"].baseUrl, BASE);
		assert.ok(!JSON.stringify(server.customProviderViews()).includes(KEY), "views carry the masked tail only");
	});

	it("registers the provider and its models with pi-ai", () => {
		const registered = piModels().getModel("test-gw", "model-a");
		assert.ok(registered);
		assert.equal(registered.api, "anthropic-messages");
		assert.equal(registered.baseUrl, BASE);
		assert.equal(registered.reasoning, true);
		assert.deepEqual(registered.input, ["text", "image"]);
		assert.equal(registered.contextWindow, 128_000);
		assert.deepEqual(piModels().getModel("test-gw", "model-b")?.input, ["text"]);
	});

	it("federates into the picker and passes slot validation", () => {
		assert.deepEqual(catalogProviders().find((p) => p.id === "test-gw"), { id: "test-gw", envVar: ENV_VAR, keyPresent: true });
		const ids = modelCatalog().models.filter((m) => m.provider === "test-gw").map((m) => m.id);
		assert.deepEqual(ids, ["model-a", "model-b"]);
		assert.deepEqual(validateModelsSettings({ strong: { model: { provider: "test-gw", id: "model-a" } } }), { ok: true });
		assert.equal(validateModelsSettings({ strong: { model: { provider: "test-gw", id: "missing" } } }).ok, false);
		assert.equal(providerKeyPresent("test-gw"), true);
	});

	it("keeps the stored key when an edit sends no key", () => {
		saveOk(config({ label: "Renamed Gateway" }));
		assert.equal(authStore.authVars()[ENV_VAR], KEY);
		assert.equal(piModels().getProvider("test-gw")?.name, "Renamed Gateway");
	});

	it("drops a file-stored key when the endpoint moves to a new origin", () => {
		const moved = saveOk(config({ baseUrl: "https://elsewhere.example.test/api" }));
		assert.equal(moved.keyCleared, true);
		assert.equal(authStore.authVars()[ENV_VAR], undefined);
		assert.equal(process.env[ENV_VAR], undefined);
		assert.equal(providerKeyPresent("test-gw"), false);
		const back = saveOk({ ...config(), apiKey: KEY });
		assert.equal(back.keyCleared, false, "a new key in the same save is kept");
		assert.equal(authStore.authVars()[ENV_VAR], KEY);
	});

	it("rejects bad ids, built-in ids, bad URLs and keyless creates", () => {
		const fail = (id: string, body: unknown, status: number, pattern: RegExp) => {
			const result = server.saveCustomProvider(id, body);
			assert.equal(result.ok, false, id);
			assert.equal((result as { status: number }).status, status);
			assert.match((result as { error: string }).error, pattern);
		};
		fail("Bad_Id", { ...config(), apiKey: KEY }, 400, /lowercase/);
		fail("openai", { ...config(), apiKey: KEY }, 409, /built-in/);
		fail("chatgpt", { ...config(), apiKey: KEY }, 409, /built-in/);
		fail("new-gw", config(), 400, /API key is required/);
		fail("new-gw", { ...config(), apiKey: "short" }, 400, /at least 12/);
		fail("new-gw", { ...config(), apiKey: 42 }, 400, /must be text/);
		fail("new-gw", { ...config({ baseUrl: "http://gateway.example.test" }), apiKey: KEY }, 400, /https/);
		assert.equal(piModels().getProvider("new-gw"), undefined);
	});
});

describe("the keys seam knows custom endpoint keys", () => {
	it("custom env vars are writable and surface as status rows", () => {
		assert.equal(isWritableAuthKey(ENV_VAR), true);
		assert.equal(isWritableAuthKey("LH_CUSTOM_whatever"), false);
		assert.ok(keyStatuses().some((s) => s.id === ENV_VAR && s.present));
	});
});

describe("the request each protocol sends", () => {
	it("Anthropic Messages: POST {base}/v1/messages with x-api-key and the model id", async () => {
		respond = () => anthropicOk();
		const result = await server.testCustomProvider("test-gw", { model: "model-a" });
		assert.equal(result.ok, true, result.ok ? "" : result.error);
		assert.equal((result as { reply: string }).reply, "ok");
		assert.equal(calls.length, 1);
		const [call] = calls;
		// pi-ai's Anthropic client calls the beta flavor (?beta=true); SIT accepts it.
		const url = new URL(call!.url);
		assert.equal(`${url.origin}${url.pathname}`, `${BASE}/v1/messages`);
		assert.equal(call!.method, "POST");
		assert.equal(call!.headers.get("x-api-key"), KEY);
		assert.equal(call!.headers.get("authorization"), null);
		assert.equal((call!.body as { model: string }).model, "model-a");
	});

	it("a thinking level on a reasoning model sends the thinking parameter", async () => {
		respond = () => anthropicOk();
		const engine = piEngineForSpec({ provider: "test-gw", id: "model-a", thinkingLevel: "low" });
		const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
		const stream = engine.streamFn(engine.model, context, {});
		for await (const _event of stream) void _event;
		const body = calls[0]?.body as { thinking?: { type: string } };
		assert.equal(body.thinking?.type, "enabled");
	});

	it("OpenAI Chat Completions: POST {base}/chat/completions with a Bearer key", async () => {
		saveOk({ ...config({ api: "openai-completions", baseUrl: "https://oai.example.test/v1" }), apiKey: OTHER_KEY }, "oai-gw");
		respond = () => openAIOk();
		const result = await server.testCustomProvider("oai-gw", { model: "model-a" });
		assert.equal(result.ok, true, result.ok ? "" : result.error);
		const [call] = calls;
		assert.equal(call!.url, "https://oai.example.test/v1/chat/completions");
		assert.equal(call!.headers.get("authorization"), `Bearer ${OTHER_KEY}`);
		assert.equal(call!.headers.get("x-api-key"), null);
		assert.equal((call!.body as { model: string }).model, "model-a");
	});
});

describe("errors reach the user readable and key-free", () => {
	it("invalid credentials", async () => {
		respond = () => json(401, { type: "error", error: { type: "authentication_error", message: "invalid api key" } });
		const result = await server.testCustomProvider("test-gw", { model: "model-a" });
		assert.deepEqual(result, { ok: false, status: 502, error: "HTTP 401: invalid api key (check the API key)" });
	});

	it("an unsupported model", async () => {
		respond = () => json(404, { type: "error", error: { type: "not_found_error", message: "model model-a is not available" } });
		const result = await server.testCustomProvider("test-gw", { model: "model-a" });
		assert.equal(result.ok, false);
		assert.match((result as { error: string }).error, /^HTTP 404: model model-a is not available \(check the base URL and model ID\)$/);
	});

	it("a network failure", async () => {
		respond = () => {
			throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
		};
		const result = await server.testCustomProvider("test-gw", { model: "model-a" });
		assert.equal(result.ok, false);
		assert.ok(!(result as { error: string }).error.includes(KEY));
	});

	it("an error that echoes the key is redacted", async () => {
		respond = () => json(400, { error: { message: `bad key ${KEY}` } });
		const result = await server.testCustomProvider("test-gw", { model: "model-a" });
		assert.equal(result.ok, false);
		assert.ok(!(result as { error: string }).error.includes(KEY));
		assert.match((result as { error: string }).error, /\[redacted\]/);
	});

	it("test refuses unknown endpoints and models before any request", async () => {
		assert.equal((await server.testCustomProvider("nope", { model: "model-a" })).ok, false);
		assert.equal((await server.testCustomProvider("test-gw", { model: "model-z" })).ok, false);
		assert.equal(calls.length, 0);
	});

	it("describeProviderError leaves unrecognized text alone", () => {
		assert.equal(server.describeProviderError("Connection error."), "Connection error.");
		assert.equal(server.describeProviderError('429 {"error":{"message":"slow down"}}'), "HTTP 429: slow down (rate limited; try again later)");
	});
});

describe("model discovery", () => {
	const list = { data: [{ id: "model-b" }, { id: "model-a" }], object: "list" };

	it("an unsaved endpoint is queried without credentials", async () => {
		respond = () => json(200, list);
		const result = await server.discoverCustomModels("draft", { api: "anthropic-messages", baseUrl: "https://new.example.test/api/" });
		assert.deepEqual(result, { ok: true, models: ["model-a", "model-b"], authenticated: false });
		assert.equal(calls[0]!.url, "https://new.example.test/api/v1/models");
		assert.equal(calls[0]!.headers.get("x-api-key"), null);
		assert.equal(calls[0]!.headers.get("anthropic-version"), "2023-06-01");
	});

	it("the saved key is attached only for the saved URL, and redirects are refused", async () => {
		respond = () => json(200, list);
		const saved = await server.discoverCustomModels("test-gw", { api: "anthropic-messages", baseUrl: BASE });
		assert.equal(saved.ok && saved.authenticated, true);
		assert.equal(calls[0]!.headers.get("x-api-key"), KEY);
		assert.equal(calls[0]!.redirect, "error");

		const elsewhere = await server.discoverCustomModels("test-gw", { api: "anthropic-messages", baseUrl: "https://attacker.example.test/api" });
		assert.equal(elsewhere.ok && elsewhere.authenticated, false);
		assert.equal(calls[1]!.headers.get("x-api-key"), null);
		const otherProtocol = await server.discoverCustomModels("test-gw", { api: "openai-completions", baseUrl: BASE });
		assert.equal(otherProtocol.ok && otherProtocol.authenticated, false);
		assert.equal(calls[2]!.headers.get("authorization"), null);
	});

	it("OpenAI endpoints list at {base}/models with a Bearer key", async () => {
		respond = () => json(200, list);
		await server.discoverCustomModels("oai-gw", { api: "openai-completions", baseUrl: "https://oai.example.test/v1" });
		assert.equal(calls[0]!.url, "https://oai.example.test/v1/models");
		assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${OTHER_KEY}`);
	});

	it("maps failures to actionable messages", async () => {
		const expect = async (response: () => Response, pattern: RegExp, id = "draft") => {
			respond = response;
			const result = await server.discoverCustomModels(id, { api: "anthropic-messages", baseUrl: BASE });
			assert.equal(result.ok, false);
			assert.match((result as { error: string }).error, pattern);
			assert.ok(!(result as { error: string }).error.includes(KEY));
		};
		await expect(() => json(401, {}), /needs an API key/);
		await expect(() => json(401, {}), /rejected the saved API key/, "test-gw");
		await expect(() => json(404, {}), /No model list at \/v1\/models.*by hand/);
		await expect(() => json(500, {}), /HTTP 500/);
		await expect(() => json(200, { data: [] }), /listed no models/);
		await expect(() => {
			throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
		}, /Could not reach gateway\.example\.test: ENOTFOUND/);
	});

	it("rejects bad protocol and URL input without a request", async () => {
		assert.equal((await server.discoverCustomModels("draft", { api: "nope", baseUrl: BASE })).ok, false);
		assert.equal((await server.discoverCustomModels("draft", { api: "anthropic-messages", baseUrl: "http://x.example.test" })).ok, false);
		assert.equal(calls.length, 0);
	});
});

describe("deleting an endpoint", () => {
	it("removes config, key and provider together", () => {
		assert.deepEqual(server.deleteCustomProvider("test-gw"), { ok: true });
		assert.equal(authStore.authVars()[ENV_VAR], undefined);
		assert.equal(process.env[ENV_VAR], undefined);
		assert.equal(piModels().getProvider("test-gw"), undefined);
		assert.equal(JSON.parse(readSettingsFile()).customProviders["test-gw"], undefined);
		assert.equal(catalogProviders().some((p) => p.id === "test-gw"), false);
		assert.equal(server.deleteCustomProvider("test-gw").ok, false);
	});

	it("leaves built-in providers untouched throughout", () => {
		assert.ok(piModels().getProvider("anthropic"));
		assert.ok(piModels().getProvider("openrouter"));
	});
});
