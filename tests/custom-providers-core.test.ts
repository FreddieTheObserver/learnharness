import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	customModelsListUrl,
	customProviderEnvVar,
	isCustomProviderEnvVar,
	isValidCustomProviderId,
	parseCustomBaseUrl,
	parseCustomProviderConfig,
	parseModelListIds,
	sanitizeCustomProviders,
	slugifyProviderLabel,
} from "../src/core/custom-providers.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";

const model = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	contextWindow: 128_000,
	maxTokens: 16_384,
	reasoning: false,
	images: false,
	...extra,
});

const valid = {
	label: "KMUTT SIT",
	api: "anthropic-messages",
	baseUrl: "https://nrrai2-model.sit.kmutt.ac.th/api/",
	models: [model("minimax-m3", { reasoning: true, images: true })],
};

describe("custom provider ids and key env vars", () => {
	it("accepts lowercase slugs and rejects everything else", () => {
		for (const id of ["kmutt-sit", "ab", "gw2", "a1-b2-c3"]) assert.equal(isValidCustomProviderId(id), true, id);
		for (const id of ["", "a", "KMUTT", "kmutt_sit", "-sit", "sit-", "a--b", "has space", "x".repeat(33)]) {
			assert.equal(isValidCustomProviderId(id), false, id);
		}
	});

	it("maps an id to one env var name the keys seam recognizes", () => {
		assert.equal(customProviderEnvVar("kmutt-sit"), "LH_CUSTOM_KMUTT_SIT_API_KEY");
		assert.equal(isCustomProviderEnvVar("LH_CUSTOM_KMUTT_SIT_API_KEY"), true);
		assert.equal(isCustomProviderEnvVar("OPENAI_API_KEY"), false);
		assert.equal(isCustomProviderEnvVar("LH_CUSTOM__API_KEY"), false);
	});

	it("suggests an id from a label", () => {
		assert.equal(slugifyProviderLabel("KMUTT SIT"), "kmutt-sit");
		assert.equal(slugifyProviderLabel("  My   Gateway (v2)! "), "my-gateway-v2");
		assert.equal(isValidCustomProviderId(slugifyProviderLabel("Ünïcödé Gateway")), true);
	});
});

describe("parseCustomBaseUrl: where keys may be sent", () => {
	it("accepts https and trims a trailing slash", () => {
		assert.deepEqual(parseCustomBaseUrl(" https://nrrai2-model.sit.kmutt.ac.th/api/ ", "anthropic-messages"), {
			ok: true,
			url: "https://nrrai2-model.sit.kmutt.ac.th/api",
		});
		assert.deepEqual(parseCustomBaseUrl("https://example.com", "openai-completions"), { ok: true, url: "https://example.com" });
	});

	it("allows plain http only on loopback", () => {
		assert.equal(parseCustomBaseUrl("http://localhost:11434/v1", "openai-completions").ok, true);
		assert.equal(parseCustomBaseUrl("http://127.0.0.1:8080", "anthropic-messages").ok, true);
		assert.equal(parseCustomBaseUrl("http://[::1]:8080/v1", "openai-completions").ok, true);
		const remote = parseCustomBaseUrl("http://nrrai2-model.sit.kmutt.ac.th/api", "anthropic-messages");
		assert.equal(remote.ok, false);
		assert.match((remote as { error: string }).error, /https/);
	});

	it("rejects other schemes, embedded credentials, queries and fragments", () => {
		for (const raw of ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "example.com/api", ""]) {
			assert.equal(parseCustomBaseUrl(raw, "anthropic-messages").ok, false, raw);
		}
		assert.match((parseCustomBaseUrl("https://user:pw@example.com", "anthropic-messages") as { error: string }).error, /username or password/);
		assert.equal(parseCustomBaseUrl("https://example.com/api?key=abc", "anthropic-messages").ok, false);
		assert.equal(parseCustomBaseUrl("https://example.com/api?", "anthropic-messages").ok, false);
		assert.equal(parseCustomBaseUrl("https://example.com/api#x", "anthropic-messages").ok, false);
	});

	it("rejects a URL that already includes the request path, naming the fix", () => {
		const messages = parseCustomBaseUrl("https://example.com/api/v1/messages", "anthropic-messages");
		assert.equal(messages.ok, false);
		assert.match((messages as { error: string }).error, /before "\/v1\/messages".*appends \/v1\/messages/);
		const completions = parseCustomBaseUrl("https://example.com/v1/chat/completions/", "openai-completions");
		assert.match((completions as { error: string }).error, /appends \/chat\/completions/);
		assert.equal(parseCustomBaseUrl("https://example.com/v1/models", "openai-completions").ok, false);
	});
});

describe("model discovery helpers", () => {
	it("builds the list URL per protocol", () => {
		assert.equal(customModelsListUrl("anthropic-messages", "https://x.test/api"), "https://x.test/api/v1/models");
		assert.equal(customModelsListUrl("openai-completions", "https://x.test/v1"), "https://x.test/v1/models");
	});

	it("reads ids from the shared {data:[{id}]} shape, sorted and deduped", () => {
		const body = {
			data: [{ id: "minimax-m3" }, { id: "minimax-m2.7" }, { id: "minimax-m3" }, { id: "has space" }, { name: "no id" }, null],
			object: "list",
		};
		assert.deepEqual(parseModelListIds(body), ["minimax-m2.7", "minimax-m3"]);
		assert.deepEqual(parseModelListIds({ models: [] }), []);
		assert.deepEqual(parseModelListIds("nope"), []);
	});
});

describe("parseCustomProviderConfig: the strict write side", () => {
	it("normalizes a valid config", () => {
		const parsed = parseCustomProviderConfig({ ...valid, label: "  KMUTT SIT  ", apiKey: "ignored-here" });
		assert.deepEqual(parsed, {
			ok: true,
			config: {
				label: "KMUTT SIT",
				api: "anthropic-messages",
				baseUrl: "https://nrrai2-model.sit.kmutt.ac.th/api",
				models: [model("minimax-m3", { reasoning: true, images: true })],
			},
		});
	});

	it("allows an endpoint with no models yet", () => {
		assert.equal(parseCustomProviderConfig({ ...valid, models: [] }).ok, true);
	});

	const reject = (patch: Record<string, unknown>, pattern: RegExp) => {
		const parsed = parseCustomProviderConfig({ ...valid, ...patch });
		assert.equal(parsed.ok, false, JSON.stringify(patch));
		assert.match((parsed as { error: string }).error, pattern);
	};

	it("names the bad field", () => {
		reject({ label: "   " }, /Name is required/);
		reject({ label: "x".repeat(61) }, /at most 60/);
		reject({ api: "google-generative-ai" }, /Protocol must be one of/);
		reject({ baseUrl: 42 }, /Base URL is required/);
		reject({ baseUrl: "http://example.com" }, /https/);
		reject({ models: "minimax-m3" }, /models must be a list/);
		reject({ models: [model("a"), model("a")] }, /listed twice/);
		reject({ models: [model("with space")] }, /no spaces/);
		reject({ models: [model("m", { contextWindow: 100 })] }, /context window/);
		reject({ models: [model("m", { contextWindow: 1.5e3 + 0.5 })] }, /context window/);
		reject({ models: [model("m", { maxTokens: 200_000 })] }, /max output/);
		reject({ models: [model("m", { reasoning: "yes" })] }, /true or false/);
	});
});

describe("settings.json carries customProviders through the sanitizer", () => {
	it("keeps valid entries, drops invalid ids and configs, never throws", () => {
		const record = sanitizeUserSettings({
			version: 1,
			customProviders: {
				"kmutt-sit": valid,
				"Bad_ID": valid,
				broken: { ...valid, baseUrl: "http://evil.example" },
			},
		});
		assert.deepEqual(Object.keys(record?.customProviders ?? {}), ["kmutt-sit"]);
		assert.equal(record?.customProviders?.["kmutt-sit"]?.baseUrl, "https://nrrai2-model.sit.kmutt.ac.th/api");
		assert.deepEqual(sanitizeCustomProviders("nope"), undefined);
		// A malformed section resolves to empty instead of riding along verbatim.
		assert.deepEqual(sanitizeUserSettings({ version: 1, customProviders: [] })?.customProviders, {});
		assert.deepEqual(sanitizeUserSettings({ version: 1, customProviders: "abc" })?.customProviders, {});
		assert.equal("customProviders" in (sanitizeUserSettings({ version: 1 }) ?? {}), false);
	});
});
