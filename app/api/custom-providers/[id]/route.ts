/**
 * PUT /api/custom-providers/:id: create or replace one endpoint.
 * Body {label, api, baseUrl, models, apiKey?}; an absent apiKey keeps the
 * stored key unless the endpoint moved to a new origin.
 * DELETE: remove the endpoint and its stored key.
 */
import { deleteCustomProvider, saveCustomProvider } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Params) {
	const { id } = await params;
	const body = await req.json().catch(() => null);
	const result = saveCustomProvider(id, body);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ provider: result.provider, keyCleared: result.keyCleared });
}

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	const result = deleteCustomProvider(id);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ ok: true });
}
