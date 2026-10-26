import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	draftBody,
	draftFromView,
	draftProblem,
	endpointStatusLine,
	mergeDiscovered,
	type CustomProviderView,
	type EndpointDraft,
} from "../components/settings/custom-providers-section.tsx";
import { classifyKeys } from "../components/settings/keys-section.tsx";
import { SetupKeysBody } from "../components/setup-dialog.tsx";
import type { AuthKeyStatus } from "../src/core/auth-keys.ts";

const view: CustomProviderView = {
	id: "kmutt-sit",
	label: "KMUTT SIT",
	api: "anthropic-messages",
	baseUrl: "https://nrrai2-model.sit.kmutt.ac.th/api",
	models: [{ id: "minimax-m3", contextWindow: 128_000, maxTokens: 16_384, reasoning: true, images: true }],
	envVar: "LH_CUSTOM_KMUTT_SIT_API_KEY",
	key: { present: true, masked: "…ab12 (59 chars)", source: "file" },
};

const fresh = (patch: Partial<EndpointDraft> = {}): EndpointDraft => ({
	...draftFromView(null),
	id: "kmutt-sit",
	label: "KMUTT SIT",
	baseUrl: "https://nrrai2-model.sit.kmutt.ac.th/api",
	apiKey: "sk-0123456789abcdef",
	...patch,
});

describe("the endpoint form's pure rules", () => {
	it("a complete new endpoint has no problem; each bad piece names itself", () => {
		assert.equal(draftProblem(fresh(), true), null);
		assert.equal(draftProblem(fresh({ label: " " }), true), "Name is required");
		assert.match(draftProblem(fresh({ id: "Bad_Id" }), true) ?? "", /lowercase/);
		assert.match(draftProblem(fresh({ baseUrl: "http://example.com" }), true) ?? "", /https/);
		assert.match(draftProblem(fresh({ apiKey: "short" }), true) ?? "", /at least 12/);
	});

	it("an empty key never blocks the form; the server decides (an env var may supply it)", () => {
		assert.equal(draftProblem(fresh({ apiKey: "" }), true), null);
	});

	it("editing a saved endpoint needs no key and ignores the locked id", () => {
		const draft = draftFromView(view);
		assert.equal(draft.apiKey, "");
		assert.equal(draftProblem({ ...draft, id: "ignored_on_edit" }, false), null);
	});

	it("the body converts number fields and sends a key only when typed", () => {
		const draft = draftFromView(view);
		assert.deepEqual(draftBody(draft), {
			label: "KMUTT SIT",
			api: "anthropic-messages",
			baseUrl: "https://nrrai2-model.sit.kmutt.ac.th/api",
			models: [{ id: "minimax-m3", contextWindow: 128_000, maxTokens: 16_384, reasoning: true, images: true }],
		});
		assert.equal(draftBody({ ...draft, apiKey: "  sk-new-key-123456  " }).apiKey, "sk-new-key-123456");
	});

	it("discovery adds new ids with defaults and keeps edited rows", () => {
		const draft = draftFromView(view);
		const merged = mergeDiscovered(draft.models, ["minimax-m2.7", "minimax-m3"]);
		assert.deepEqual(
			merged.map((m) => [m.id, m.contextWindow, m.reasoning, m.images]),
			[
				["minimax-m3", "128000", true, true],
				["minimax-m2.7", "128000", false, false],
			],
		);
	});

	it("the folded row shows host, model count and the masked key only", () => {
		assert.equal(endpointStatusLine(view), "nrrai2-model.sit.kmutt.ac.th · 1 model · …ab12");
		assert.equal(endpointStatusLine({ ...view, models: [], key: { present: false, masked: null, source: "none" } }), "nrrai2-model.sit.kmutt.ac.th · 0 models · no key");
	});
});

describe("custom endpoint keys stay out of the generic key table", () => {
	const status = (id: string): AuthKeyStatus => ({ id, info: null, present: true, masked: "…ab12 (59 chars)", source: "file", shadowedByEnv: false });
	it("neither a provider row nor an unknown row", () => {
		const { providerRows, unknownRows } = classifyKeys([status("LH_CUSTOM_KMUTT_SIT_API_KEY"), status("FUTURE_TOKEN")], []);
		assert.deepEqual(providerRows, []);
		assert.deepEqual(unknownRows.map((s) => s.id), ["FUTURE_TOKEN"]);
	});
});

describe("first-run setup points at custom endpoints", () => {
	const props = {
		providers: [],
		provider: null,
		value: "",
		saving: false,
		error: null,
		menuOpen: false,
		onToggleMenu: () => {},
		onPick: () => {},
		onValue: () => {},
		onSave: () => {},
		menuAnchor: createRef<HTMLDivElement>(),
	};
	it("renders the link only when wired", () => {
		assert.match(renderToStaticMarkup(createElement(SetupKeysBody, { ...props, onCustomEndpoint: () => {} })), /data-testid="setup-custom-endpoint"[^>]*>Add a custom endpoint</);
		assert.doesNotMatch(renderToStaticMarkup(createElement(SetupKeysBody, props)), /setup-custom-endpoint/);
	});
});
