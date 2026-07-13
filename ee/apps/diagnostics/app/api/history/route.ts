import { clearWireHistory, listWireHistory } from "../../../src/history-store"

export const dynamic = "force-dynamic"

export async function GET(): Promise<Response> {
  return Response.json({ exchanges: await listWireHistory() }, { headers: { "cache-control": "no-store" } })
}

export async function DELETE(): Promise<Response> {
  await clearWireHistory()
  return new Response(null, { status: 204 })
}
