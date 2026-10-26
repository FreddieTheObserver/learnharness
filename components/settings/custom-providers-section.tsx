"use client";
/**
 * The Custom endpoints group of the Providers section: user-defined
 * Anthropic- or OpenAI-compatible servers. Rows fold like the key table;
 * a row unfolds into an editor for name, protocol, base URL, key and
 * models, with model discovery and a one-request connection test.
 *
 * API: GET /api/custom-providers, PUT/DELETE /api/custom-providers/:id,
 * POST .../:id/models (discovery), POST .../:id/test. The key is
 * write-only: the server returns its masked tail, never the value.
 */

import { useEffect, useState } from "react";
import {
	CUSTOM_MODEL_DEFAULTS,
	CUSTOM_PROVIDER_API_LABELS,
	CUSTOM_PROVIDER_API_PATHS,
	CUSTOM_PROVIDER_APIS,
	isValidCustomProviderId,
	parseCustomBaseUrl,
	slugifyProviderLabel,
	type CustomProviderApi,
	type CustomProviderConfig,
} from "@/src/core";
import { Toggle, ThinSelect } from "./controls.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";

/** The deep-link row that opens the add form (the setup dialog uses it). */
export const CUSTOM_ENDPOINT_NEW_ROW = "custom-endpoint:new";

export interface CustomProviderView extends CustomProviderConfig {
	id: string;
	envVar: string;
	key: { present: boolean; masked: string | null; source: "env" | "file" | "none" };
}

interface ModelDraft {
	id: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	images: boolean;
}

export interface EndpointDraft {
	id: string;
	label: string;
	api: CustomProviderApi;
	baseUrl: string;
	apiKey: string;
	models: ModelDraft[];
}

const INPUT =
	"h-7 min-w-0 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50 disabled:opacity-40";
const LINK = "shrink-0 text-xs underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";

function modelDraft(id: string, from?: { contextWindow?: number | string; maxTokens?: number | string; reasoning?: boolean; images?: boolean }): ModelDraft {
	return {
		id,
		contextWindow: String(from?.contextWindow ?? CUSTOM_MODEL_DEFAULTS.contextWindow),
		maxTokens: String(from?.maxTokens ?? CUSTOM_MODEL_DEFAULTS.maxTokens),
		reasoning: from?.reasoning ?? CUSTOM_MODEL_DEFAULTS.reasoning,
		images: from?.images ?? CUSTOM_MODEL_DEFAULTS.images,
	};
}

export function draftFromView(view: CustomProviderView | null): EndpointDraft {
	if (!view) return { id: "", label: "", api: "anthropic-messages", baseUrl: "", apiKey: "", models: [] };
	return {
		id: view.id,
		label: view.label,
		api: view.api,
		baseUrl: view.baseUrl,
		apiKey: "",
		models: view.models.map((m) => modelDraft(m.id, m)),
	};
}

/** Adds discovered ids that are not listed yet, keeping existing rows as edited. */
export function mergeDiscovered(models: readonly ModelDraft[], ids: readonly string[]): ModelDraft[] {
	const known = new Set(models.map((m) => m.id));
	return [...models, ...ids.filter((id) => !known.has(id)).map((id) => modelDraft(id))];
}

/** The first problem that blocks Save, or null. Pure, so tests pin the copy.
 *  A missing key on create is the server's call: an environment variable
 *  may already supply it. */
export function draftProblem(draft: EndpointDraft, isNew: boolean): string | null {
	if (!draft.label.trim()) return "Name is required";
	if (isNew && !isValidCustomProviderId(draft.id)) return "ID must be 2-32 lowercase letters, digits or single hyphens";
	const url = parseCustomBaseUrl(draft.baseUrl, draft.api);
	if (!url.ok) return url.error;
	if (draft.apiKey.trim() && (draft.apiKey.trim().length < 12 || /\s/.test(draft.apiKey.trim()))) {
		return "API key must be at least 12 characters with no spaces";
	}
	return null;
}

export function draftBody(draft: EndpointDraft) {
	return {
		label: draft.label.trim(),
		api: draft.api,
		baseUrl: draft.baseUrl.trim(),
		models: draft.models.map((m) => ({
			id: m.id.trim(),
			contextWindow: Number(m.contextWindow),
			maxTokens: Number(m.maxTokens),
			reasoning: m.reasoning,
			images: m.images,
		})),
		...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
	};
}

export function endpointStatusLine(view: CustomProviderView): string {
	const host = (() => {
		try {
			return new URL(view.baseUrl).host;
		} catch {
			return view.baseUrl;
		}
	})();
	const models = `${view.models.length} model${view.models.length === 1 ? "" : "s"}`;
	const key = view.key.present ? (view.key.masked ?? "key set").replace(/ \((\d+) chars\)$/, "") : "no key";
	return `${host} · ${models} · ${key}`;
}

async function errorOf(res: Response | null, fallback: string): Promise<string> {
	if (!res) return `${fallback}. Check your connection and try again.`;
	const body = (await res.json().catch(() => ({}))) as { error?: string };
	return body.error ?? `${fallback} (${res.status})`;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<label className="flex flex-col gap-1">
			<span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
			{children}
			{hint && <span className="text-[11px] text-muted-foreground/70">{hint}</span>}
		</label>
	);
}

function EndpointEditor({
	view,
	takenIds,
	onSaved,
	onCancel,
	onDeleted,
}: {
	view: CustomProviderView | null;
	takenIds: ReadonlySet<string>;
	onSaved: (notice: string | null) => Promise<void>;
	onCancel: () => void;
	onDeleted: () => Promise<void>;
}) {
	const isNew = view === null;
	const [draft, setDraft] = useState<EndpointDraft>(() => draftFromView(view));
	const [idTouched, setIdTouched] = useState(false);
	const [newModel, setNewModel] = useState("");
	const [busy, setBusy] = useState<null | "save" | "fetch" | "test" | "delete">(null);
	const [error, setError] = useState<string | null>(null);
	const [discovery, setDiscovery] = useState<string | null>(null);
	const [testModel, setTestModel] = useState(view?.models[0]?.id ?? "");
	const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const set = (patch: Partial<EndpointDraft>) => setDraft((d) => ({ ...d, ...patch }));
	const setModel = (index: number, patch: Partial<ModelDraft>) =>
		setDraft((d) => ({ ...d, models: d.models.map((m, i) => (i === index ? { ...m, ...patch } : m)) }));

	const problem = draftProblem(draft, isNew) ?? (isNew && takenIds.has(draft.id) ? `ID "${draft.id}" is already used` : null);
	const url = draft.baseUrl.trim() ? parseCustomBaseUrl(draft.baseUrl, draft.api) : null;
	const discoveryId = isNew ? draft.id || "draft" : view.id;

	async function save() {
		if (problem || busy) return;
		setBusy("save");
		setError(null);
		const res = await fetch(`/api/custom-providers/${encodeURIComponent(draft.id)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(draftBody(draft)),
		}).catch(() => null);
		setBusy(null);
		if (!res || !res.ok) {
			setError(await errorOf(res, "Save failed"));
			return;
		}
		const body = (await res.json()) as { keyCleared?: boolean };
		notifySettingsSaved("keys");
		await onSaved(body.keyCleared ? "The base URL moved to a new host, so the old key was removed. Paste the key for the new host." : null);
	}

	async function discover() {
		if (!url?.ok || busy) return;
		setBusy("fetch");
		setDiscovery(null);
		const res = await fetch(`/api/custom-providers/${encodeURIComponent(discoveryId)}/models`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ api: draft.api, baseUrl: draft.baseUrl }),
		}).catch(() => null);
		setBusy(null);
		if (!res || !res.ok) {
			setDiscovery(await errorOf(res, "Model list failed"));
			return;
		}
		const { models } = (await res.json()) as { models: string[] };
		const added = models.filter((id) => !draft.models.some((m) => m.id === id)).length;
		set({ models: mergeDiscovered(draft.models, models) });
		setDiscovery(`Found ${models.length} model${models.length === 1 ? "" : "s"}${added ? `, added ${added}` : ", none new"}. Set each model's limits, thinking and images below.`);
	}

	async function test() {
		if (!view || !testModel || busy) return;
		setBusy("test");
		setTestResult(null);
		const res = await fetch(`/api/custom-providers/${encodeURIComponent(view.id)}/test`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: testModel }),
		}).catch(() => null);
		setBusy(null);
		if (!res || !res.ok) {
			setTestResult({ ok: false, text: await errorOf(res, "Test failed") });
			return;
		}
		const body = (await res.json()) as { reply: string; ms: number };
		setTestResult({ ok: true, text: `Connected in ${body.ms} ms. Reply: ${body.reply || "(empty)"}` });
	}

	async function remove() {
		if (!view || busy) return;
		setBusy("delete");
		const res = await fetch(`/api/custom-providers/${encodeURIComponent(view.id)}`, { method: "DELETE" }).catch(() => null);
		setBusy(null);
		if (!res || !res.ok) {
			setError(await errorOf(res, "Delete failed"));
			return;
		}
		notifySettingsSaved("keys");
		await onDeleted();
	}

	function addModel() {
		const id = newModel.trim();
		if (!id || /\s/.test(id) || draft.models.some((m) => m.id === id)) return;
		set({ models: [...draft.models, modelDraft(id)] });
		setNewModel("");
	}

	const paths = CUSTOM_PROVIDER_API_PATHS[draft.api];

	return (
		<div className="flex flex-col gap-3 rounded-sm border border-border/60 p-3" data-testid={`custom-endpoint-${isNew ? "new" : view.id}-editor`}>
			<div className="grid grid-cols-2 gap-3">
				<Field label="Name">
					<input
						type="text"
						value={draft.label}
						autoFocus
						aria-label="Endpoint name"
						data-testid="custom-endpoint-label"
						placeholder="KMUTT SIT"
						onChange={(e) => {
							const label = e.target.value;
							set(isNew && !idTouched ? { label, id: slugifyProviderLabel(label) } : { label });
						}}
						className={INPUT}
					/>
				</Field>
				<Field label="ID" hint={isNew ? "Used in model pins; cannot change later" : undefined}>
					<input
						type="text"
						value={draft.id}
						disabled={!isNew}
						aria-label="Endpoint ID"
						data-testid="custom-endpoint-id"
						placeholder="kmutt-sit"
						onChange={(e) => {
							setIdTouched(true);
							set({ id: e.target.value.toLowerCase() });
						}}
						className={INPUT}
					/>
				</Field>
			</div>
			<Field label="Protocol">
				<ThinSelect
					value={draft.api}
					ariaLabel="Protocol"
					testid="custom-endpoint-api"
					onChange={(next) => set({ api: next as CustomProviderApi })}
				>
					{CUSTOM_PROVIDER_APIS.map((api) => (
						<option key={api} value={api}>
							{CUSTOM_PROVIDER_API_LABELS[api]}
						</option>
					))}
				</ThinSelect>
			</Field>
			<Field label="Base URL" hint={`Everything before ${paths.request}; LearnHarness adds that path.`}>
				<input
					type="url"
					value={draft.baseUrl}
					aria-label="Base URL"
					data-testid="custom-endpoint-url"
					placeholder={draft.api === "anthropic-messages" ? "https://example.com/api" : "https://example.com/v1"}
					onChange={(e) => set({ baseUrl: e.target.value })}
					className={INPUT}
				/>
			</Field>
			{url && !url.ok && (
				<p role="alert" data-testid="custom-endpoint-url-error" className="-mt-2 text-xs text-red-500">
					{url.error}
				</p>
			)}
			<Field
				label="API key"
				hint={
					view?.key.source === "env"
						? `Set by the environment variable ${view.envVar}; a saved key would be shadowed.`
						: view?.key.present
							? `Saved (${(view.key.masked ?? "").replace(/ \((\d+) chars\)$/, "")}). Leave empty to keep it.`
							: undefined
				}
			>
				<input
					type="password"
					autoComplete="off"
					value={draft.apiKey}
					aria-label="API key"
					data-testid="custom-endpoint-key"
					placeholder={view?.key.present ? "Paste a new key to replace it…" : "Paste key…"}
					onChange={(e) => set({ apiKey: e.target.value })}
					className={INPUT}
				/>
			</Field>

			<div className="flex flex-col gap-1.5" data-testid="custom-endpoint-models">
				<div className="flex items-center justify-between">
					<span className="text-[11px] uppercase tracking-wider text-muted-foreground">Models</span>
					<button
						type="button"
						onClick={() => void discover()}
						disabled={!url?.ok || busy !== null}
						data-testid="custom-endpoint-fetch"
						className={`${LINK} text-muted-foreground hover:text-foreground`}
					>
						{busy === "fetch" ? "Fetching…" : `Fetch from ${paths.models}`}
					</button>
				</div>
				{discovery && (
					<p data-testid="custom-endpoint-discovery" className="text-[11px] text-muted-foreground">
						{discovery}
					</p>
				)}
				{draft.models.length > 0 && (
					<div className="grid grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_auto_auto_auto] items-center gap-x-2 gap-y-1">
						<span className="text-[10px] text-muted-foreground/70">ID</span>
						<span className="text-[10px] text-muted-foreground/70">Context</span>
						<span className="text-[10px] text-muted-foreground/70">Max output</span>
						<span className="text-[10px] text-muted-foreground/70">Thinking</span>
						<span className="text-[10px] text-muted-foreground/70">Images</span>
						<span />
						{draft.models.map((m, i) => (
							<div key={m.id} className="contents" data-testid={`custom-model-${m.id}`}>
								<span className="truncate font-mono text-xs text-foreground" title={m.id}>
									{m.id}
								</span>
								<input
									type="number"
									value={m.contextWindow}
									aria-label={`${m.id} context window`}
									onChange={(e) => setModel(i, { contextWindow: e.target.value })}
									className={INPUT}
								/>
								<input
									type="number"
									value={m.maxTokens}
									aria-label={`${m.id} max output tokens`}
									onChange={(e) => setModel(i, { maxTokens: e.target.value })}
									className={INPUT}
								/>
								<Toggle checked={m.reasoning} label={`${m.id} thinking`} onChange={(next) => setModel(i, { reasoning: next })} />
								<Toggle checked={m.images} label={`${m.id} images`} onChange={(next) => setModel(i, { images: next })} />
								<button
									type="button"
									aria-label={`Remove ${m.id}`}
									onClick={() => set({ models: draft.models.filter((_, j) => j !== i) })}
									className="text-xs text-muted-foreground/70 hover:text-red-500"
								>
									✕
								</button>
							</div>
						))}
					</div>
				)}
				<div className="flex items-center gap-2">
					<input
						type="text"
						value={newModel}
						aria-label="Model ID to add"
						data-testid="custom-endpoint-new-model"
						placeholder="Add a model ID, e.g. minimax-m3"
						onChange={(e) => setNewModel(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								addModel();
							}
						}}
						className={`${INPUT} flex-1`}
					/>
					<button type="button" onClick={addModel} disabled={!newModel.trim()} className={`${LINK} text-foreground`}>
						Add
					</button>
				</div>
			</div>

			{view && view.models.length > 0 && (
				<div className="flex items-center gap-2" data-testid="custom-endpoint-test">
					<span className="text-[11px] uppercase tracking-wider text-muted-foreground">Test</span>
					<ThinSelect value={testModel} ariaLabel="Model to test" onChange={setTestModel}>
						{view.models.map((m) => (
							<option key={m.id} value={m.id}>
								{m.id}
							</option>
						))}
					</ThinSelect>
					<button
						type="button"
						onClick={() => void test()}
						disabled={busy !== null || !view.key.present}
						data-testid="custom-endpoint-test-run"
						className={`${LINK} text-foreground`}
					>
						{busy === "test" ? "Testing…" : "Send a test request"}
					</button>
				</div>
			)}
			{testResult && (
				<p
					role={testResult.ok ? "status" : "alert"}
					data-testid="custom-endpoint-test-result"
					className={`text-xs ${testResult.ok ? "text-muted-foreground" : "text-red-500"}`}
				>
					{testResult.text}
				</p>
			)}

			<div className="flex items-center gap-3 border-t border-border/60 pt-2">
				<button
					type="button"
					onClick={() => void save()}
					disabled={problem !== null || busy !== null}
					title={problem ?? undefined}
					data-testid="custom-endpoint-save"
					className={`${LINK} text-foreground`}
				>
					{busy === "save" ? "Saving…" : "Save"}
				</button>
				<button type="button" onClick={onCancel} disabled={busy !== null} data-testid="custom-endpoint-cancel" className={`${LINK} text-muted-foreground/70 hover:text-foreground`}>
					Cancel
				</button>
				{view && (
					<button
						type="button"
						onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
						disabled={busy !== null}
						data-testid="custom-endpoint-delete"
						className={`${LINK} ml-auto text-muted-foreground/70 hover:text-red-500`}
					>
						{confirmDelete ? "Click again to delete endpoint and key" : "Delete"}
					</button>
				)}
			</div>
			{(error ?? (problem && draft.label.trim() ? problem : null)) && (
				<p role="alert" data-testid="custom-endpoint-error" className="text-xs text-red-500">
					{error ?? problem}
				</p>
			)}
		</div>
	);
}

export function CustomEndpoints({ initialRow }: { initialRow?: string }) {
	const [providers, setProviders] = useState<CustomProviderView[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [openRow, setOpenRow] = useState<string | null>(initialRow === CUSTOM_ENDPOINT_NEW_ROW ? CUSTOM_ENDPOINT_NEW_ROW : null);
	const [notice, setNotice] = useState<string | null>(null);

	const reload = () =>
		fetch("/api/custom-providers")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
			.then((body: { providers: CustomProviderView[] }) => {
				setProviders(body.providers);
				setFailed(false);
			})
			.catch(() => setFailed(true));

	useEffect(() => {
		void reload();
	}, []);

	useEffect(() => {
		if (initialRow === CUSTOM_ENDPOINT_NEW_ROW) setOpenRow(CUSTOM_ENDPOINT_NEW_ROW);
	}, [initialRow]);

	// Escape folds the open editor without closing the dialog (capture phase,
	// the same claim the key rows make).
	useEffect(() => {
		if (openRow === null) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpenRow(null);
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [openRow]);

	if (failed) return <p className="px-1 text-xs text-red-500">Custom endpoints could not be loaded.</p>;
	if (providers === null) return <p className="px-1 text-xs text-muted-foreground/70">Loading endpoints…</p>;

	const takenIds = new Set(providers.map((p) => p.id));
	const close = () => setOpenRow(null);
	const afterWrite = async (message: string | null) => {
		await reload();
		setNotice(message);
		close();
	};

	return (
		<div className="flex flex-col gap-1" data-testid="custom-endpoints">
			{providers.map((p) =>
				openRow === p.id ? (
					<EndpointEditor key={p.id} view={p} takenIds={takenIds} onSaved={afterWrite} onCancel={close} onDeleted={() => afterWrite(null)} />
				) : (
					<button
						key={p.id}
						type="button"
						aria-expanded={false}
						data-testid={`custom-endpoint-${p.id}-row`}
						onClick={() => {
							setNotice(null);
							setOpenRow(p.id);
						}}
						className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50"
					>
						<span className="font-ui text-xs text-foreground">{p.label}</span>
						<span className="truncate font-mono text-[11px] text-muted-foreground">{endpointStatusLine(p)}</span>
					</button>
				),
			)}
			{openRow === CUSTOM_ENDPOINT_NEW_ROW ? (
				<EndpointEditor view={null} takenIds={takenIds} onSaved={afterWrite} onCancel={close} onDeleted={() => afterWrite(null)} />
			) : (
				<button
					type="button"
					data-testid="add-custom-endpoint"
					onClick={() => {
						setNotice(null);
						setOpenRow(CUSTOM_ENDPOINT_NEW_ROW);
					}}
					className="flex w-full items-center rounded-sm px-1 py-1.5 text-left font-ui text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
				>
					+ Add custom endpoint
				</button>
			)}
			{notice && (
				<p role="status" data-testid="custom-endpoint-notice" className="px-1 text-xs text-muted-foreground">
					{notice}
				</p>
			)}
		</div>
	);
}
