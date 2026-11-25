import { z } from "zod"

export const CELL_IDS_LIMIT = 2_000

const bodySchema = z.object({ names: z.array(z.string().min(1).max(220)).max(CELL_IDS_LIMIT) }).strict()

export async function cellIdsResponse(request: Request, cell: { valid(name: string): boolean; id(name: string): string }): Promise<Response> {
  const headers = { "Cache-Control": "no-store" }
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers })
  }
  const body = bodySchema.safeParse(raw)
  if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400, headers })
  const ids: Record<string, string> = {}
  for (const name of body.data.names) if (cell.valid(name)) ids[name] = cell.id(name)
  return Response.json({ ids }, { headers })
}
