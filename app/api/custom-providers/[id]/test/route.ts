/**
 * POST /api/custom-providers/:id/test: send one tiny request to a saved
 * endpoint's model through the chat engine. Body {model}.
 */
import { testCustomProvider } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
	const { id } = await params;
	const body = await req.json().catch(() => null);
	const result = await testCustomProvider(id, body);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ reply: result.reply, ms: result.ms });
}
