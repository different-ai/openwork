import { NextRequest } from "next/server";
import {
  clearStoredConnection,
  readStoredConnection,
  resolveConnectionState,
  validateAndStoreConnection,
} from "../../../../lib/openwork-lab-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const connection = await readStoredConnection();
  return Response.json(await resolveConnectionState(connection));
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    return Response.json(
      await validateAndStoreConnection({
        baseUrl: typeof body?.baseUrl === "string" ? body.baseUrl : "",
        token: typeof body?.token === "string" ? body.token : "",
        hostToken: typeof body?.hostToken === "string" ? body.hostToken : "",
        workspaceId: typeof body?.workspaceId === "string" ? body.workspaceId : "",
      }),
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function DELETE() {
  await clearStoredConnection();
  return Response.json({ ok: true });
}
