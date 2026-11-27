import { z } from "zod"

export const csvRowSchema = z.object({
  id: z.string(),
  owner: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
  updated_by: z.string(),
  updated_at: z.string(),
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
})

export type CsvRow = z.infer<typeof csvRowSchema>
type CsvCell = CsvRow["data"][string] | undefined

function csvCell(value: CsvCell): string {
  let text = value == null ? "" : String(value)
  if (typeof value === "string" && (/^[\t\r]/u.test(value) || /^[\s\p{Cc}]*[=+\-@]/u.test(value))) text = `'${text}`
  return /[,"\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function buildMcpAppStorageCsv(fields: readonly string[], rows: readonly CsvRow[]): string {
  const declared = new Set(fields)
  const extra = new Set<string>()
  for (const row of rows) {
    for (const key of Object.keys(row.data)) {
      if (!declared.has(key)) extra.add(key)
    }
  }
  const keys = [...fields, ...[...extra].sort()]
  const metadata = ["created_by", "created_at", "updated_by", "updated_at", "visibility", "owner_member_id"].map((key) => {
    while (declared.has(key) || extra.has(key)) key = `_${key}`
    return key
  })
  const lines = [["id", ...keys, ...metadata].map(csvCell).join(",")]
  for (const row of rows) {
    lines.push([
      row.id, ...keys.map((key) => Object.hasOwn(row.data, key) ? row.data[key] : undefined),
      row.created_by, row.created_at, row.updated_by, row.updated_at,
      row.owner === null ? "shared" : "personal", row.owner,
    ].map(csvCell).join(","))
  }
  return `${lines.join("\r\n")}\r\n`
}
