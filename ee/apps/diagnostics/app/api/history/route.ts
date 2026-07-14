import { clearWireHistory, listWireHistory } from "../../../src/history-store"
import { egressDiagnosticRunSchema } from "@openwork/types/den/egress-diagnostics"

export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  const suppliedRunId = new URL(request.url).searchParams.get("runId") ?? ""
  const parsedRunId = egressDiagnosticRunSchema.shape.runId.safeParse(suppliedRunId)
  if (suppliedRunId && !parsedRunId.success) {
    return Response.json({ error: "invalid_run_id" }, { headers: { "cache-control": "no-store" }, status: 400 })
  }
  return Response.json(
    { exchanges: await listWireHistory(parsedRunId.success ? parsedRunId.data : undefined) },
    { headers: { "cache-control": "no-store" } },
  )
}

export async function DELETE(): Promise<Response> {
  await clearWireHistory()
  return new Response(null, { status: 204 })
}
