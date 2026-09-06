/**
 * Documents in the conversation: what a coworker's document tool calls mean
 * for the person reading the thread. Pure, so the card a bubble ends with and
 * the fold a long reply gets are unit-tested and the transcript only renders
 * what these return.
 */
export type DocumentStatus = "active" | "aside" | "archived";
export type DocumentAuthor = "coworker" | "person";

/** One document as the store lists it (no body). */
export type CoworkerDocumentSummary = {
  id: string;
  title: string;
  summary: string;
  highlights: string[];
  status: DocumentStatus;
  createdAt: number;
  updatedAt: number;
  updatedBy: DocumentAuthor;
  revision: number;
  words: number;
};

/** A document with its Markdown body. */
export type CoworkerDocument = Omit<CoworkerDocumentSummary, "words"> & { body: string };

/** An earlier revision, as kept in history. */
export type DocumentRevision = CoworkerDocument;

/** What the card at the end of a bubble shows for one document touched in that turn. */
export type DocumentCardData = {
  id: string;
  title: string;
  summary: string;
  highlights: string[];
  action: "created" | "updated";
  /** The `##` section an update replaced or added, when it was a section patch. */
  section: string;
  revision: number | null;
};

/** A reply longer than this with no document behind it folds to its first paragraph. */
export const LONG_REPLY_FOLD_CHARS = 1200;
/** The reply length the coworker's contract aims for, in words; shown nowhere, used by tests and copy. */
export const REPLY_TARGET_WORDS = 120;

const DOCUMENT_TOOLS = new Set(["documents_list", "document_create", "document_update", "document_read", "context_set", "document_archive"]);
const DOCUMENT_WRITE_TOOLS = new Set(["document_create", "document_update"]);

/** `coworker_document_create` → `document_create`; anything else → "". */
export function documentToolName(tool: string): string {
  const lower = tool.toLowerCase();
  if (DOCUMENT_TOOLS.has(lower)) return lower;
  for (const name of DOCUMENT_TOOLS) {
    if (lower.endsWith(`_${name}`)) return name;
  }
  return "";
}

export function isDocumentTool(tool: string): boolean {
  return documentToolName(tool) !== "";
}

/** Whether the turn wrote or refreshed a document (the calls that earn a card and lift the fold). */
export function wroteDocument(calls: ReadonlyArray<{ tool: string; status: string }>): boolean {
  return calls.some((call) => DOCUMENT_WRITE_TOOLS.has(documentToolName(call.tool)) && isDone(call.status));
}

function isDone(status: string): boolean {
  return status === "completed" || status === "success";
}

/** `launch-plan` → `Launch plan`, for when only an id is known. */
export function humanizeDocumentId(id: string): string {
  const stem = id.replace(/-+/g, " ").trim();
  return stem ? stem.charAt(0).toUpperCase() + stem.slice(1) : "Document";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function lines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean);
  if (typeof value === "string") return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The MCP result a tool call kept: the engine's plugin preserves it under the
 * call's metadata (`openworkMcpResult`, then `openworkMcpApp`); a raw result
 * object in `output` counts too. Same reading as the App host, kept here so
 * this module stays free of the App client.
 */
export function keptResult(call: { output: unknown; metadata: Record<string, unknown> }): { content: unknown[]; structuredContent: Record<string, unknown> | null } | null {
  for (const candidate of [call.metadata.openworkMcpResult, call.metadata.openworkMcpApp, call.output]) {
    if (!isRecord(candidate) || !Array.isArray(candidate.content)) continue;
    return { content: candidate.content, structuredContent: isRecord(candidate.structuredContent) ? candidate.structuredContent : null };
  }
  return null;
}

/** The `structuredContent.document` a document tool returned, when the transcript kept it. */
export function structuredDocument(call: { output: unknown; metadata: Record<string, unknown> }): Record<string, unknown> | null {
  const structured = keptResult(call)?.structuredContent;
  if (!structured || !isRecord(structured.document)) return null;
  return structured.document;
}

/** Titles of documents a `context_set` call changed, keyed by id, when the transcript kept them. */
export function structuredContextChanges(call: { output: unknown; metadata: Record<string, unknown> }): Array<{ id: string; title: string; status: string }> {
  const changed = keptResult(call)?.structuredContent?.changed;
  if (!Array.isArray(changed)) return [];
  return changed.flatMap((entry) => (isRecord(entry) && typeof entry.id === "string"
    ? [{ id: entry.id, title: text(entry.title) || humanizeDocumentId(entry.id), status: text(entry.status) }]
    : []));
}

/** "Wrote "Launch plan" (id launch-plan, revision 1)" → id and revision, when only the text survived. */
function idFromText(output: unknown): { id: string; revision: number | null } {
  const content = keptResult({ output, metadata: {} })?.content.find((item) => isRecord(item) && typeof item.text === "string");
  const source = isRecord(content) && typeof content.text === "string" ? content.text : typeof output === "string" ? output : "";
  const match = /\(id ([a-z0-9-]+)(?:, revision (\d+))?\)/.exec(source) ?? /to revision (\d+)/.exec(source);
  if (!match) return { id: "", revision: null };
  if (match[0].startsWith("(id")) return { id: match[1] ?? "", revision: match[2] ? Number(match[2]) : null };
  return { id: "", revision: match[1] ? Number(match[1]) : null };
}

/**
 * The cards a reply ends with: one per document the turn created or updated,
 * built from the tool calls (input first, the kept result when there is one),
 * so no Markdown syntax from the model is needed. A document both created and
 * updated in one turn reads as created, with the latest fields.
 */
export function documentCardsFromCalls(
  calls: ReadonlyArray<{ tool: string; status: string; input: Record<string, unknown>; output: unknown; metadata: Record<string, unknown> }>,
): DocumentCardData[] {
  const cards = new Map<string, DocumentCardData>();
  for (const call of calls) {
    const name = documentToolName(call.tool);
    if (!DOCUMENT_WRITE_TOOLS.has(name) || !isDone(call.status)) continue;
    const structured = structuredDocument(call);
    if (structured && text(structured.action) === "unchanged") continue;
    const fromText = idFromText(call.output);
    const id = text(structured?.id) || text(call.input.id) || fromText.id || (name === "document_create" ? documentIdGuess(text(call.input.title)) : "");
    if (!id) continue;
    const previous = cards.get(id);
    const patch = isRecord(call.input.patch) ? call.input.patch : null;
    const revision = typeof structured?.revision === "number" ? structured.revision : fromText.revision;
    const action = previous?.action === "created" || name === "document_create" ? "created" : "updated";
    const next: DocumentCardData = {
      id,
      title: text(structured?.title) || text(call.input.title) || previous?.title || humanizeDocumentId(id),
      summary: text(structured?.summary) || text(call.input.summary) || previous?.summary || "",
      highlights: (lines(structured?.highlights).length > 0 ? lines(structured?.highlights) : lines(call.input.highlights).length > 0 ? lines(call.input.highlights) : previous?.highlights ?? []).slice(0, 3),
      action,
      section: action === "updated" ? text(structured?.section) || text(patch?.heading) : "",
      revision: revision ?? previous?.revision ?? null,
    };
    cards.set(id, next);
  }
  return [...cards.values()];
}

/** The store's id rule, mirrored for the moment before a result arrives. */
function documentIdGuess(title: string): string {
  const stem = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return stem || "document";
}

/** "Updated · Timeline section" or "Updated · revision 3"; empty for a new document. */
export function cardSubline(card: DocumentCardData): string {
  if (card.action === "created") return "";
  if (card.section) return `Updated · ${card.section} section`;
  return card.revision ? `Updated · revision ${card.revision}` : "Updated";
}

/**
 * A finished reply that runs long with no document behind it folds to its first
 * paragraph behind "Show the rest". Nothing is ever cut: the fold only hides.
 */
export function shouldFoldReply(textValue: string, calls: ReadonlyArray<{ tool: string; status: string }>): boolean {
  return textValue.length > LONG_REPLY_FOLD_CHARS && !wroteDocument(calls);
}

/** The lead a folded reply keeps visible, and the rest it hides. A tiny first block takes the next one along. */
export function splitReplyLead(textValue: string): { lead: string; rest: string } {
  const blocks = textValue.replace(/\s+$/, "").split(/\n[ \t]*\n/);
  let count = 1;
  if ((blocks[0] ?? "").trim().length < 80 && blocks.length > 1) count = 2;
  const lead = blocks.slice(0, count).join("\n\n").trimEnd();
  const rest = blocks.slice(count).join("\n\n").trim();
  return { lead, rest };
}

/** The small dot on the Activity icon, its Documents row, and the summary line: something changed since the person last opened Documents. */
export function documentsChangedSince(documents: ReadonlyArray<Pick<CoworkerDocumentSummary, "updatedAt" | "updatedBy">>, lastOpenedAt: number): number {
  return documents.filter((document) => document.updatedBy === "coworker" && document.updatedAt > lastOpenedAt).length;
}

/** Documents as the view groups them: active by last update, put aside, archived. */
export function groupDocuments<T extends Pick<CoworkerDocumentSummary, "status" | "updatedAt">>(documents: ReadonlyArray<T>): { active: T[]; aside: T[]; archived: T[] } {
  const byUpdate = (a: T, b: T) => b.updatedAt - a.updatedAt;
  return {
    active: documents.filter((document) => document.status === "active").sort(byUpdate),
    aside: documents.filter((document) => document.status === "aside").sort(byUpdate),
    archived: documents.filter((document) => document.status === "archived").sort(byUpdate),
  };
}

/** The message dropped into the composer by "Ask <name> to update". */
export function askToUpdatePrompt(title: string): string {
  return `Update "${title}" with `;
}
