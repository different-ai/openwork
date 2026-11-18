import { z } from "zod"

/**
 * A cell is known to the cell host by an id derived from its name, and a node's state report lists the cells it has
 * in memory by that id alone. Den knows conversations by name, so it asks here which id each name has, to say whose
 * each cell in memory is on its admin page.
 *
 * Answered by the router from the names alone: deriving an id touches no cell, so none is woken or kept awake.
 */
export const CELL_IDS_LIMIT = 2_000

const bodySchema = z.object({ names: z.array(z.string().min(1).max(220)).max(CELL_IDS_LIMIT) }).strict()

/** `POST /v1/cells/ids` `{ names }` -> `{ ids: { [name]: id } }`. Names that are not cell names are left out. */
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
