/**
 * GET /api/custom-providers: the user-defined endpoints with masked key
 * status. Plaintext keys never leave the server.
 */
import { customProviderViews } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ providers: customProviderViews() });
}
