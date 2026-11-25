import { appendFileSync, writeFileSync } from "node:fs"
import { api, apiText } from "../api.ts"
import { noArgs, openSession, withRecentSignIn, type Context } from "../context.ts"
import { parseAuditPage } from "../den.ts"
import { CliError } from "../io.ts"
import { emit, table } from "../output.ts"

const EXPORT_PAGE_LIMIT = 100
const MOST_EXPORT_PAGES = 10_000

function filters(context: Context): URLSearchParams {
  const query = new URLSearchParams()
  const wanted: [string, string | undefined][] = [
    ["from", context.flags.from],
    ["to", context.flags.to],
    ["action", context.flags.action],
    ["actorId", context.flags.actor],
    ["outcome", context.flags.outcome],
  ]
  for (const [name, value] of wanted) if (value) query.set(name, value)
  return query
}

export async function list(context: Context): Promise<void> {
  noArgs(context)
  const session = await openSession(context)
  const query = filters(context)
  if (context.flags.limit) query.set("limit", context.flags.limit)
  if (context.flags.cursor) query.set("cursor", context.flags.cursor)
  const path = query.size ? `/v1/audit/operations?${query}` : "/v1/audit/operations"
  const page = parseAuditPage(await withRecentSignIn(context, session, (current) => api(context.io, current, "GET", path)))
  emit(context.io, context.json, page, [
    page.operations.length
      ? table(["STARTED", "ACTION", "OUTCOME", "ORIGIN", "ACTOR", "EVENTS", "ID"],
        page.operations.map((operation) => [operation.startedAt.replace("T", " ").slice(0, 19), operation.action, operation.outcome, operation.origin, operation.actorId, operation.events, operation.id]))
      : "No audit operations match.",
    ...(page.nextCursor ? [`More: add --cursor ${page.nextCursor}`] : []),
  ].join("\n"))
}

function withoutCsvHeader(page: string): string {
  const firstRowEnd = page.indexOf("\r\n")
  return firstRowEnd === -1 ? "" : page.slice(firstRowEnd + 2)
}

/**
 * Download every event of one audit snapshot. The API serves it a page at a
 * time and names the next page in a response header; each CSV page repeats the
 * column header, which is kept once.
 */
export async function exportEvents(context: Context): Promise<void> {
  noArgs(context)
  const format = context.flags.format ?? "ndjson"
  if (format !== "ndjson" && format !== "csv") throw new CliError("usage", "--format is ndjson or csv.")
  const session = await openSession(context)
  const out = context.flags.out
  if (out) writeFileSync(out, "")
  let cursor: string | null = null
  let pages = 0
  let events = 0
  do {
    const query = filters(context)
    query.set("format", format)
    query.set("limit", String(EXPORT_PAGE_LIMIT))
    if (cursor) query.set("cursor", cursor)
    const page = await withRecentSignIn(context, session, (current) => apiText(context.io, current, `/v1/audit/export?${query}`))
    const text = format === "csv" && pages > 0 ? withoutCsvHeader(page.text) : page.text
    events += page.text.split("\n").filter((line) => line.trim() !== "").length - (format === "csv" ? 1 : 0)
    if (out) appendFileSync(out, text)
    else if (text) context.io.out(text.replace(/\r?\n$/, ""))
    cursor = page.headers.get("x-audit-next-cursor")
    pages += 1
  } while (cursor && pages < MOST_EXPORT_PAGES)
  if (cursor) throw new CliError("export_too_large", `Stopped after ${pages} pages. Narrow the export with --from and --to.`)
  if (out) emit(context.io, context.json, { file: out, format, events }, `Saved ${events} audit events to ${out}.`)
}
