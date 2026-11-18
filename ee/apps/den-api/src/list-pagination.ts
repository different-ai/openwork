import { and, eq, lt, or, type SQL } from "@openwork-ee/den-db/drizzle"
import { z } from "zod"

// Keyset pagination for lists ordered by (timestamp desc, id desc); see
// docs/api-style.md#pagination. The cursor is the sort key of the last row on
// the page, base64url-encoded so clients treat it as opaque. Never offset-based.

export type KeysetCursor = { at: Date; id: string }

type KeysetColumn = Parameters<typeof lt>[0]

const cursorPayloadSchema = z.object({
  at: z.number().int().safe(),
  id: z.string().min(1).max(160),
})

export function encodeKeysetCursor(key: KeysetCursor): string {
  return Buffer.from(JSON.stringify({ at: key.at.getTime(), id: key.id }), "utf8").toString("base64url")
}

export function decodeKeysetCursor(cursor: string): KeysetCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    return null
  }
  const parsed = cursorPayloadSchema.safeParse(payload)
  return parsed.success ? { at: new Date(parsed.data.at), id: parsed.data.id } : null
}

/** Optional `cursor` query parameter; an undecodable value is a 400 `invalid_request`. */
export const keysetCursorQuerySchema = z.string().min(1).max(200)
  .transform((value, ctx) => {
    const decoded = decodeKeysetCursor(value)
    if (decoded) return decoded
    ctx.addIssue({ code: "custom", message: "Invalid cursor." })
    return z.NEVER
  })
  .meta({ description: "Opaque cursor returned as nextCursor by the previous page. Omit for the first page." })

export const nextCursorSchema = z.string().nullable()
  .meta({ description: "Pass as cursor to fetch the next page; null on the last page." })

/** WHERE fragment selecting rows strictly after `cursor` in (at desc, id desc) order. */
export function keysetAfter(columns: { at: KeysetColumn; id: KeysetColumn }, cursor: KeysetCursor): SQL | undefined {
  return or(lt(columns.at, cursor.at), and(eq(columns.at, cursor.at), lt(columns.id, cursor.id)))
}

/** Slice a `limit + 1` result into one page and the cursor for the next one. */
export function keysetPage<Row>(
  rows: Row[],
  limit: number,
  key: (row: Row) => KeysetCursor,
): { items: Row[]; nextCursor: string | null } {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return { items, nextCursor: rows.length > limit && last ? encodeKeysetCursor(key(last)) : null }
}
