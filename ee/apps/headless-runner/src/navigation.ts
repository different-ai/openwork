import { workbotDocumentNavigationSchema } from "@openwork/types/workbot-context"
import type { ToolResult, ToolSpec } from "./types.js"

/** The host follows this receipt; it never grants provider access or edits a document. */
export const DOCUMENT_NAVIGATION_TOOL: ToolSpec = {
  name: "open_document",
  description: "Open a Google Drive document beside this conversation. Use only when the person explicitly asks to open or show a document; otherwise offer its link. This only requests opening: their page checks their access, and their next message's view context shows what actually opened, so never say it opened.",
  inputSchema: {
    type: "object",
    properties: { fileId: { type: "string", description: "Google Drive file id from a connected-app lookup or the person's view context." } },
    required: ["fileId"],
    additionalProperties: false,
  },
}

export function openDocument(input: Record<string, unknown>): ToolResult {
  const parsed = workbotDocumentNavigationSchema.safeParse(input)
  return parsed.success
    ? { output: JSON.stringify({ fileId: parsed.data.fileId, status: "requested" }), isError: false }
    : { output: "Choose a valid Google Drive file id.", isError: true }
}
