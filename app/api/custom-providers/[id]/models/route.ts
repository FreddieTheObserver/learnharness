/**
 * POST /api/custom-providers/:id/models: list the endpoint's model ids.
 * Body {api, baseUrl}; the stored key is attached only when both match the
 * saved endpoint.
 */
import { discoverCustomModels } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
	const { id } = await params;
	const body = await req.json().catch(() => null);
	const result = await discoverCustomModels(id, body);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ models: result.models, authenticated: result.authenticated });
}
