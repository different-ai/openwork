import { z } from "zod"
import { SlackApiError, type SlackCall } from "./protocol.js"
import { excerpt, markdownToMrkdwn, markdownToPlainText, slackSafeText, splitSlackText, withoutSlackBroadcasts } from "./slack-text.js"

export const SLACK_LIMITS = {
  blocks: 50,
  headerText: 150,
  sectionText: 3_000,
  fieldText: 2_000,
  fieldsPerSection: 10,
  contextElements: 10,
  contextText: 3_000,
  markdownText: 12_000,
  tableRows: 100,
  tableColumns: 20,
  tableCharacters: 10_000,
  imageUrl: 3_000,
  imageAlt: 2_000,
  imageTitle: 2_000,
  actionsElements: 25,
  buttonText: 75,
  buttonUrl: 3_000,
  buttonValue: 2_000,
  actionId: 255,
  blockId: 255,
  fallbackText: 4_000,
} as const

const MARKDOWN_BUDGET = 11_000
const TABLE_BUDGET = 9_000
const TABLE_CELL_BUDGET = 400
const FALLBACK_BUDGET = 3_900

export const SLACK_CHOICE_PREFIX = "openwork_choice:"
export const SLACK_LINK_PREFIX = "openwork_link:"
export const OPENWORK_PLACES = ["automations", "connections"] as const
export type OpenWorkPlace = (typeof OPENWORK_PLACES)[number]

const plainText = z.object({ type: z.literal("plain_text"), text: z.string().min(1), emoji: z.boolean().optional() }).strict()
const mrkdwnText = (max: number) => z.object({ type: z.literal("mrkdwn"), text: z.string().min(1).max(max) }).strict()
const linkButton = z
  .object({
    type: z.literal("button"),
    action_id: z.string().min(1).max(SLACK_LIMITS.actionId),
    text: plainText.extend({ text: z.string().min(1).max(SLACK_LIMITS.buttonText) }),
    url: z.string().min(1).max(SLACK_LIMITS.buttonUrl).optional(),
    value: z.string().min(1).max(SLACK_LIMITS.buttonValue).optional(),
  })
  .strict()
const tableCell = z.union([
  z.object({ type: z.literal("raw_text"), text: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("rich_text"),
      elements: z
        .array(
          z
            .object({
              type: z.literal("rich_text_section"),
              elements: z.array(z.object({ type: z.literal("link"), url: z.string().min(1), text: z.string().min(1) }).strict()).length(1),
            })
            .strict(),
        )
        .length(1),
    })
    .strict(),
])

export const slackBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("header"), text: plainText.extend({ text: z.string().min(1).max(SLACK_LIMITS.headerText) }) }).strict(),
  z.object({ type: z.literal("markdown"), text: z.string().min(1).max(SLACK_LIMITS.markdownText) }).strict(),
  z
    .object({
      type: z.literal("section"),
      text: mrkdwnText(SLACK_LIMITS.sectionText).optional(),
      fields: z.array(mrkdwnText(SLACK_LIMITS.fieldText)).min(1).max(SLACK_LIMITS.fieldsPerSection).optional(),
    })
    .strict(),
  z.object({ type: z.literal("divider") }).strict(),
  z.object({ type: z.literal("context"), elements: z.array(mrkdwnText(SLACK_LIMITS.contextText)).min(1).max(SLACK_LIMITS.contextElements) }).strict(),
  z
    .object({
      type: z.literal("table"),
      rows: z.array(z.array(tableCell).min(1).max(SLACK_LIMITS.tableColumns)).min(1).max(SLACK_LIMITS.tableRows),
      column_settings: z
        .array(z.object({ align: z.enum(["left", "center", "right"]).optional(), is_wrapped: z.boolean().optional() }).strict())
        .max(SLACK_LIMITS.tableColumns)
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      image_url: z.string().min(1).max(SLACK_LIMITS.imageUrl),
      alt_text: z.string().min(1).max(SLACK_LIMITS.imageAlt),
      title: plainText.extend({ text: z.string().min(1).max(SLACK_LIMITS.imageTitle) }).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("actions"),
      block_id: z.string().min(1).max(SLACK_LIMITS.blockId),
      elements: z.array(linkButton).min(1).max(SLACK_LIMITS.actionsElements),
    })
    .strict(),
])
export type SlackBlock = z.infer<typeof slackBlockSchema>

function cellCharacters(cell: z.infer<typeof tableCell>) {
  return cell.type === "raw_text" ? cell.text.length : cell.elements.reduce((sum, section) => sum + section.elements.reduce((inner, link) => inner + link.text.length, 0), 0)
}

function tableCharacters(block: Extract<SlackBlock, { type: "table" }>) {
  return block.rows.reduce((sum, row) => sum + row.reduce((inner, cell) => inner + cellCharacters(cell), 0), 0)
}

export function slackBlockProblems(blocks: readonly unknown[]): string[] {
  const problems: string[] = []
  if (blocks.length === 0) problems.push("no blocks")
  if (blocks.length > SLACK_LIMITS.blocks) problems.push(`${blocks.length} blocks, Slack allows ${SLACK_LIMITS.blocks}`)
  let markdown = 0
  let cells = 0
  for (const [index, raw] of blocks.entries()) {
    const parsed = slackBlockSchema.safeParse(raw)
    if (!parsed.success) {
      problems.push(`block ${index}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`)
      continue
    }
    const block = parsed.data
    if (block.type === "markdown") markdown += block.text.length
    if (block.type === "table") cells += tableCharacters(block)
    if (block.type === "section" && Boolean(block.text) === Boolean(block.fields)) problems.push(`block ${index}: a section needs text or fields, not both`)
    if (block.type === "actions") {
      const ids = block.elements.map((element) => element.action_id)
      if (new Set(ids).size !== ids.length) problems.push(`block ${index}: action ids repeat`)
    }
  }
  if (markdown > SLACK_LIMITS.markdownText) problems.push(`${markdown} Markdown characters, Slack allows ${SLACK_LIMITS.markdownText}`)
  if (cells > SLACK_LIMITS.tableCharacters) problems.push(`${cells} table characters, Slack allows ${SLACK_LIMITS.tableCharacters}`)
  return problems
}

function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null
  } catch {
    return null
  }
}

const short = (max: number) => z.string().trim().min(1).max(max)
const safeUrl = z.string().trim().max(2_000).refine((value) => httpsUrl(value) !== null, "Use an https:// URL without credentials.")

const componentButtonSchema = z.union([
  z.object({ text: short(40), url: safeUrl }).strict(),
  z.object({ text: short(40), open: z.enum(OPENWORK_PLACES) }).strict(),
])

export const slackComponentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("header"), text: short(150) }).strict().describe("A bold title line, plain text."),
  z.object({ type: z.literal("text"), text: short(3_000) }).strict().describe("A paragraph or list in standard Markdown."),
  z.object({ type: z.literal("divider") }).strict().describe("A thin line between two parts."),
  z.object({ type: z.literal("context"), text: short(300) }).strict().describe("A small grey line: where the data came from and when it was read."),
  z
    .object({ type: z.literal("fields"), fields: z.array(z.object({ label: short(60), value: short(300) }).strict()).min(1).max(10) })
    .strict()
    .describe("Up to ten short label and value pairs about one thing, shown in two columns."),
  z
    .object({
      type: z.literal("table"),
      columns: z.array(short(60)).min(2).max(12),
      rows: z.array(z.array(z.string().trim().max(300)).min(2).max(12)).min(1).max(50),
      align: z.array(z.enum(["left", "center", "right"])).max(12).optional(),
    })
    .strict()
    .describe("A real table: columns is the header row and every row has one cell per column. A cell that is only a Markdown link, [label](https://…), shows as a link. One table per message."),
  z
    .object({ type: z.literal("image"), url: safeUrl, alt: short(300), title: short(150).optional() })
    .strict()
    .describe("A picture with a sentence saying what it shows. Shown only when OpenWork hosts it; any other address becomes a link."),
  z
    .object({ type: z.literal("buttons"), buttons: z.array(componentButtonSchema).min(1).max(5) })
    .strict()
    .describe('Up to five link buttons. url opens that page; open names a place in OpenWork instead: "automations" or "connections".'),
  z
    .object({ type: z.literal("choices"), prompt: short(300).optional(), options: z.array(short(40)).min(2).max(5) })
    .strict()
    .describe("One question with two to five buttons that only the person the message is for can press. What they press reaches OpenWork in Slack as their next message there, so name each option by what it does. Must be last."),
])
export type SlackComponent = z.infer<typeof slackComponentSchema>

export const SLACK_COMPONENTS_MAX = 20

export const slackComponentsSchema = z
  .array(slackComponentSchema)
  .min(1)
  .max(SLACK_COMPONENTS_MAX)
  .superRefine((components, context) => {
    const count = (type: SlackComponent["type"]) => components.filter((component) => component.type === type).length
    if (count("table") > 1) context.addIssue({ code: "custom", message: "Send at most one table per message." })
    if (count("image") > 3) context.addIssue({ code: "custom", message: "Send at most three images per message." })
    if (count("choices") > 1) context.addIssue({ code: "custom", message: "Ask at most one question with choices per message." })
    if (count("choices") === 1 && components.at(-1)?.type !== "choices") context.addIssue({ code: "custom", message: "Put choices last." })
    for (const [index, component] of components.entries()) {
      if (component.type === "table") {
        if (component.rows.some((row) => row.length !== component.columns.length))
          context.addIssue({ code: "custom", path: [index, "rows"], message: "Every row needs one cell per column." })
        const characters = [component.columns, ...component.rows].flat().reduce((sum, cell) => sum + cell.length, 0)
        if (characters > 8_000) context.addIssue({ code: "custom", path: [index], message: "The table is too large for one Slack message (8,000 characters across cells). Send fewer rows." })
      }
      if (component.type === "choices" && new Set(component.options.map((option) => option.toLowerCase())).size !== component.options.length)
        context.addIssue({ code: "custom", path: [index, "options"], message: "Give each option a different name." })
    }
  })

export type SlackPart = SlackComponent | { type: "mrkdwn"; text: string }

export type SlackComposeOptions = {
  choiceFor?: string | null
  link?: (url: string) => string | null
  imageUrl?: (url: string) => string | null
  places?: Partial<Record<OpenWorkPlace, string>>
  reservedBlocks?: number
}

type SectionBlock = { type: "section"; text: { type: "mrkdwn"; text: string } }

export type SlackOutgoingMessage = {
  text: string
  blocks: SlackBlock[]
  plain: { text: string; blocks: SectionBlock[] }
  choice: boolean
}

function clean(text: string) {
  return withoutSlackBroadcasts(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""))
}

function plain(text: string, limit: number) {
  const value = clean(markdownToPlainText(text)).replace(/\s*\n\s*/g, " ").trim()
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`
}

function inline(text: string, limit: number) {
  const value = markdownToMrkdwn(clean(text))
  return value.length <= limit ? value : excerpt(value, limit - 1)
}

function section(text: string): SectionBlock {
  return { type: "section", text: { type: "mrkdwn", text } }
}

const NUMBER_CELL = /^[$€£¥+\-–(]*\d[\d\s.,]*[%)kKmMbB]*$/
const SINGLE_LINK = /^\[([^\]\n]+)\]\((https:\/\/[^\s()<>]+)\)$/

function linkOf(component: Extract<SlackComponent, { type: "buttons" }>["buttons"][number], options: SlackComposeOptions) {
  if ("open" in component) return options.places?.[component.open] ?? null
  return (options.link ?? httpsUrl)(component.url)
}

function partMrkdwn(part: SlackPart, options: SlackComposeOptions): string {
  switch (part.type) {
    case "mrkdwn":
      return clean(part.text)
    case "header":
      return `*${slackSafeText(plain(part.text, SLACK_LIMITS.headerText))}*`
    case "text":
      return markdownToMrkdwn(clean(part.text))
    case "divider":
      return ""
    case "context":
      return inline(part.text, SLACK_LIMITS.contextText)
    case "fields":
      return part.fields.map((field) => `*${slackSafeText(plain(field.label, 80))}:* ${inline(field.value, 1_000)}`).join("\n")
    case "table": {
      const row = (cells: readonly string[]) => cells.map((cell) => slackSafeText(plain(cell, TABLE_CELL_BUDGET)) || "–").join(" · ")
      return [`*${row(part.columns)}*`, ...part.rows.map((cells) => `• ${row(cells)}`)].join("\n")
    }
    case "image": {
      const url = (options.link ?? httpsUrl)(part.url)
      const label = slackSafeText(plain(part.title ?? part.alt, 150))
      return url ? `<${url.replaceAll("|", "%7C")}|${label}>` : label
    }
    case "buttons":
      return part.buttons
        .flatMap((button) => {
          const url = linkOf(button, options)
          return url ? [`<${url.replaceAll("|", "%7C")}|${slackSafeText(plain(button.text, 40))}>`] : []
        })
        .join(" · ")
    case "choices": {
      const names = part.options.map((option) => `"${slackSafeText(plain(option, 40))}"`).join(" or ")
      return `${part.prompt ? `${inline(part.prompt, 600)}\n` : ""}Reply with ${names}.`
    }
  }
}

function fallbackText(parts: readonly SlackPart[], options: SlackComposeOptions) {
  const text = parts
    .map((part) => partMrkdwn(part, options))
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text.length <= FALLBACK_BUDGET ? text : excerpt(text, FALLBACK_BUDGET)
}

function plainVersion(parts: readonly SlackPart[], options: SlackComposeOptions): SlackOutgoingMessage["plain"] {
  const full = parts
    .map((part) => partMrkdwn(part, options))
    .filter(Boolean)
    .join("\n\n")
    .trim()
  const pieces = splitSlackText(full || "…", SLACK_LIMITS.sectionText)
  const shown = pieces.length > SLACK_LIMITS.blocks ? [...pieces.slice(0, SLACK_LIMITS.blocks - 1), "_The rest didn't fit in one Slack message._"] : pieces
  return { text: fallbackText(parts, options), blocks: shown.map(section) }
}

function tableBlock(part: Extract<SlackComponent, { type: "table" }>): Extract<SlackBlock, { type: "table" }> {
  const cell = (value: string) => {
    const link = SINGLE_LINK.exec(value.trim())
    const url = link?.[2] ? httpsUrl(link[2]) : null
    const label = plain(link?.[1] ?? "", TABLE_CELL_BUDGET)
    if (url && label) return { type: "rich_text" as const, elements: [{ type: "rich_text_section" as const, elements: [{ type: "link" as const, url, text: label }] }] }
    return { type: "raw_text" as const, text: plain(value, TABLE_CELL_BUDGET) || "–" }
  }
  const values = (column: number) => part.rows.map((row) => (row[column] ?? "").trim()).map((value) => SINGLE_LINK.exec(value)?.[1] ?? value).filter(Boolean)
  const numeric = (column: number) => values(column).length > 0 && values(column).every((value) => NUMBER_CELL.test(value))
  const settings = part.columns.map((_, column) => ({
    align: part.align?.[column] ?? (numeric(column) ? ("right" as const) : ("left" as const)),
    ...(values(column).some((value) => value.length > 40) ? { is_wrapped: true } : {}),
  }))
  const styled = settings.some((setting) => setting.align !== "left" || setting.is_wrapped)
  return {
    type: "table",
    rows: [part.columns, ...part.rows].map((row) => part.columns.map((_, column) => cell(row[column] ?? ""))),
    ...(styled ? { column_settings: settings } : {}),
  }
}

function tableChunks(part: Extract<SlackComponent, { type: "table" }>) {
  const size = (cells: readonly string[]) => cells.reduce((sum, value) => sum + Math.min(value.length, TABLE_CELL_BUDGET) + 1, 0)
  const header = size(part.columns)
  const chunks: (typeof part)[] = []
  let rows: string[][] = []
  let used = header
  for (const row of part.rows) {
    const cost = size(row)
    if (rows.length > 0 && (used + cost > TABLE_BUDGET || rows.length + 1 >= SLACK_LIMITS.tableRows)) {
      chunks.push({ ...part, rows })
      rows = []
      used = header
    }
    rows.push(row)
    used += cost
  }
  if (rows.length > 0) chunks.push({ ...part, rows })
  return chunks
}

type Unit = { part: SlackPart; block: SlackBlock; markdown: number; table: boolean }

function unitsOf(part: SlackPart, options: SlackComposeOptions): Unit[] {
  const unit = (block: SlackBlock, source: SlackPart = part): Unit => ({ part: source, block, markdown: block.type === "markdown" ? block.text.length : 0, table: block.type === "table" })
  switch (part.type) {
    case "mrkdwn":
      return splitSlackText(clean(part.text), SLACK_LIMITS.sectionText).map((text) => unit(section(text), { type: "mrkdwn", text }))
    case "header": {
      const text = plain(part.text, SLACK_LIMITS.headerText)
      return text ? [unit({ type: "header", text: { type: "plain_text", text, emoji: true } })] : []
    }
    case "text":
      return splitSlackText(clean(part.text), MARKDOWN_BUDGET).map((text) => unit({ type: "markdown", text }, { type: "text", text }))
    case "divider":
      return [unit({ type: "divider" })]
    case "context": {
      const text = inline(part.text, SLACK_LIMITS.contextText)
      return text ? [unit({ type: "context", elements: [{ type: "mrkdwn", text }] })] : []
    }
    case "fields": {
      const units: Unit[] = []
      for (let offset = 0; offset < part.fields.length; offset += SLACK_LIMITS.fieldsPerSection) {
        const fields = part.fields.slice(offset, offset + SLACK_LIMITS.fieldsPerSection)
        units.push(
          unit(
            { type: "section", fields: fields.map((field) => ({ type: "mrkdwn" as const, text: `*${slackSafeText(plain(field.label, 80))}*\n${inline(field.value, 1_800) || "–"}` })) },
            { type: "fields", fields },
          ),
        )
      }
      return units
    }
    case "table":
      return tableChunks(part).map((chunk) => unit(tableBlock(chunk), chunk))
    case "image": {
      const url = options.imageUrl?.(part.url) ?? null
      const alt = plain(part.alt, SLACK_LIMITS.imageAlt)
      if (!url || !alt) {
        const text = partMrkdwn(part, options)
        return text ? [unit(section(text))] : []
      }
      const title = part.title ? plain(part.title, SLACK_LIMITS.imageTitle) : ""
      return [unit({ type: "image", image_url: url, alt_text: alt, ...(title ? { title: { type: "plain_text" as const, text: title, emoji: true } } : {}) })]
    }
    case "buttons": {
      const elements = part.buttons.flatMap((button, index) => {
        const url = linkOf(button, options)
        const text = plain(button.text, SLACK_LIMITS.buttonText)
        return url && text && url.length <= SLACK_LIMITS.buttonUrl
          ? [{ type: "button" as const, action_id: `${SLACK_LINK_PREFIX}${index}`, text: { type: "plain_text" as const, text, emoji: true }, url }]
          : []
      })
      return elements.length ? [unit({ type: "actions", block_id: `${SLACK_LINK_PREFIX}${elements.length}`, elements })] : []
    }
    case "choices":
      return []
  }
}

function outgoing(blocks: SlackBlock[], parts: readonly SlackPart[], options: SlackComposeOptions, choice: boolean): SlackOutgoingMessage {
  const fallback = plainVersion(parts, options)
  const valid = slackBlockProblems(blocks).length === 0
  return { text: fallback.text, blocks: valid ? blocks : fallback.blocks, plain: fallback, choice: choice && valid }
}

function choiceMessage(part: Extract<SlackComponent, { type: "choices" }>, slackUserId: string, options: SlackComposeOptions): SlackOutgoingMessage {
  const prompt = part.prompt ? inline(part.prompt, SLACK_LIMITS.sectionText) : ""
  const names = [...new Set(part.options.map((option) => plain(option, SLACK_LIMITS.buttonText)).filter(Boolean))]
  return outgoing(
    [
      ...(prompt ? [section(prompt)] : []),
      {
        type: "actions",
        block_id: `${SLACK_CHOICE_PREFIX}${slackUserId}`,
        elements: names.map((text, index) => ({
          type: "button" as const,
          action_id: `${SLACK_CHOICE_PREFIX}${index}`,
          text: { type: "plain_text" as const, text, emoji: true },
          value: text,
        })),
      },
    ],
    [part],
    options,
    true,
  )
}

export function composeSlackMessages(parts: readonly SlackPart[], options: SlackComposeOptions = {}): SlackOutgoingMessage[] {
  const maxBlocks = Math.max(1, SLACK_LIMITS.blocks - (options.reservedBlocks ?? 0))
  const messages: SlackOutgoingMessage[] = []
  let units: Unit[] = []
  const flush = () => {
    while (units[0]?.block.type === "divider") units.shift()
    while (units.at(-1)?.block.type === "divider") units.pop()
    if (units.length === 0) return
    messages.push(outgoing(units.map((unit) => unit.block), units.map((unit) => unit.part), options, false))
    units = []
  }
  for (const part of parts) {
    if (part.type === "choices") {
      const addressed = options.choiceFor && /^[UW][A-Z0-9]{2,}$/.test(options.choiceFor) ? options.choiceFor : null
      if (!addressed) {
        units.push({ part, block: section(partMrkdwn(part, options)), markdown: 0, table: false })
        continue
      }
      flush()
      messages.push(choiceMessage(part, addressed, options))
      continue
    }
    for (const unit of unitsOf(part, options)) {
      const markdown = units.reduce((sum, entry) => sum + entry.markdown, 0)
      if (units.length + 1 > maxBlocks || markdown + unit.markdown > MARKDOWN_BUDGET || (unit.table && units.some((entry) => entry.table))) flush()
      units.push(unit)
    }
  }
  flush()
  return messages
}

const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const IMAGE_LINE = /^\s*!\[([^\]\n]*)\]\(\s*(https:\/\/[^\s()<>]+)(?:\s+"([^"\n]*)")?\s*\)\s*$/

function tableCells(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll("\\|", "|"))
}

function markdownTable(lines: readonly string[]): Extract<SlackComponent, { type: "table" }> | null {
  const columns = tableCells(lines[0] ?? "")
  const marks = tableCells(lines[1] ?? "")
  const rows = lines.slice(2).map((line) => {
    const cells = tableCells(line)
    return columns.map((_, index) => cells[index] ?? "")
  })
  const widest = Math.max(0, ...rows.map((row) => row.reduce((sum, cell) => sum + Math.min(cell.length, TABLE_CELL_BUDGET) + 1, 0)))
  const header = columns.reduce((sum, cell) => sum + cell.length + 1, 0)
  if (columns.length < 2 || columns.length > SLACK_LIMITS.tableColumns || rows.length === 0 || columns.some((cell) => !cell.trim())) return null
  if ([columns, ...rows].flat().some((cell) => cell.length > TABLE_CELL_BUDGET && !SINGLE_LINK.test(cell)) || header + widest > TABLE_BUDGET) return null
  const align = columns.map((_, index) => {
    const mark = marks[index] ?? ""
    return mark.startsWith(":") && mark.endsWith(":") ? ("center" as const) : mark.endsWith(":") ? ("right" as const) : null
  })
  return { type: "table", columns, rows, ...(align.some(Boolean) ? { align: align.map((value) => value ?? ("left" as const)) } : {}) }
}

function fencedComponents(body: string): SlackComponent[] | null {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return null
  }
  const parsed = slackComponentsSchema.safeParse(Array.isArray(json) ? json : [json])
  return parsed.success ? parsed.data : null
}

export function markdownToSlackParts(markdown: string, options: { directives?: boolean } = {}): { parts: SlackPart[]; invalidDirectives: number } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const parts: SlackPart[] = []
  let text: string[] = []
  let invalidDirectives = 0
  const flush = () => {
    const body = text.join("\n").trim()
    if (body) parts.push({ type: "text", text: body })
    text = []
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(line)
    if (fence) {
      const marker = fence[1] ?? "```"
      let end = index + 1
      while (end < lines.length && !new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[end] ?? "")) end++
      const body = lines.slice(index + 1, end).join("\n")
      const components = options.directives && fence[2]?.toLowerCase() === "slack" && end < lines.length ? fencedComponents(body) : null
      if (components) {
        flush()
        parts.push(...components)
      } else {
        if (options.directives && fence[2]?.toLowerCase() === "slack") invalidDirectives += 1
        text.push(...lines.slice(index, end + 1))
      }
      index = end
      continue
    }
    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(lines[index + 1] ?? "")) {
      let end = index + 2
      while (end < lines.length && TABLE_ROW.test(lines[end] ?? "")) end++
      const table = markdownTable(lines.slice(index, end))
      if (table) {
        flush()
        parts.push(table)
      } else text.push(...lines.slice(index, end))
      index = end - 1
      continue
    }
    const heading = /^\s{0,3}(#{1,2})\s+(.*?)(?:\s+#+)?\s*$/.exec(line)
    const title = heading ? markdownToPlainText(heading[2] ?? "").trim() : ""
    if (heading && title && title.length <= SLACK_LIMITS.headerText && !/\]\(|https?:\/\//.test(heading[2] ?? "")) {
      flush()
      parts.push({ type: "header", text: title })
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) && (text.at(-1) ?? "").trim() === "") {
      flush()
      parts.push({ type: "divider" })
      continue
    }
    const image = IMAGE_LINE.exec(line)
    if (image?.[2] && (image[1] ?? "").trim()) {
      flush()
      parts.push({ type: "image", url: image[2], alt: (image[1] ?? "").trim().slice(0, 300), ...(image[3]?.trim() ? { title: image[3].trim().slice(0, 150) } : {}) })
      continue
    }
    text.push(line)
  }
  flush()
  return { parts, invalidDirectives }
}

const BLOCK_REJECTIONS: ReadonlySet<string> = new Set(["invalid_blocks", "invalid_blocks_format", "msg_blocks_too_long", "msg_blocks_too_many", "invalid_attachments", "block_mismatch"])

export function slackRejectedBlocks(error: unknown): error is SlackApiError {
  return error instanceof SlackApiError && BLOCK_REJECTIONS.has(error.code)
}

export async function postSlackFollowUps(
  slack: SlackCall,
  target: Record<string, unknown>,
  messages: readonly SlackOutgoingMessage[],
  onRejected: (code: string) => void,
): Promise<boolean> {
  for (const message of messages) {
    try {
      await postSlackMessage(slack, target, message, { onRejected })
    } catch (error) {
      onRejected(error instanceof SlackApiError ? error.code : "request_failed")
      return false
    }
  }
  return true
}

export async function postSlackMessage(
  slack: SlackCall,
  target: Record<string, unknown>,
  message: SlackOutgoingMessage,
  options: { before?: readonly Record<string, unknown>[]; after?: readonly Record<string, unknown>[]; textPrefix?: string; onRejected?: (code: string) => void } = {},
) {
  const body = (text: string, blocks: readonly Record<string, unknown>[]) => ({
    ...target,
    text: `${options.textPrefix ?? ""}${text}`,
    blocks: [...(options.before ?? []), ...blocks, ...(options.after ?? [])],
    unfurl_links: false,
    unfurl_media: false,
  })
  try {
    return await slack("chat.postMessage", body(message.text, message.blocks))
  } catch (error) {
    if (!slackRejectedBlocks(error)) throw error
    options.onRejected?.(error.code)
    return slack("chat.postMessage", body(message.plain.text, message.plain.blocks))
  }
}
