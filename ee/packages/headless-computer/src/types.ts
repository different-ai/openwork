/**
 * What the computer needs from the runner that hosts it, as plain shapes: the runner's own types match them, so
 * neither package imports the other.
 */

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> }
export type ToolImage = { mediaType: string; data: string }
export type ToolDocument = { mediaType: "application/pdf"; data: string; name: string }
export type ToolResult = { output: string; isError: boolean; images?: ToolImage[]; documents?: ToolDocument[] }

/** A file kept for the person (an upload, or something the agent handed back). */
export type ComputerFile = { id: string; name: string; size: number; source: "user" | "agent"; updatedAt: number }

/** The conversation's kept files: uploads are copied in, files in /workspace/out are handed back. */
export interface ComputerFiles {
  /** The largest file the conversation may keep; bigger outputs are left on the computer. */
  readonly maxFileBytes: number
  /** Newest first. */
  list(sessionId: string): ComputerFile[]
  read(sessionId: string, id: string): Promise<{ file: ComputerFile; bytes: Uint8Array<ArrayBuffer> } | null>
  /** Throws, with a message for the model, when the file doesn't fit the conversation's limits. */
  add(sessionId: string, input: { name: string; bytes: Uint8Array<ArrayBuffer>; source: "agent" }): Promise<ComputerFile>
  /** A new version of a file already handed back (same id); null when it no longer exists. Throws like `add`. */
  replace(sessionId: string, id: string, input: { bytes: Uint8Array<ArrayBuffer> }): Promise<ComputerFile | null>
  /** Page images of a slide deck, document or PDF, for previews. */
  putPreview(sessionId: string, id: string, pages: Array<Uint8Array<ArrayBuffer>>, size: { width: number; height: number }): Promise<boolean>
}

/**
 * Turns a file into what the model can see: an image or PDF as model input, text as text, or a note. `counts`
 * caps images and PDFs per result across the files of one call.
 */
export type FileReader = (
  file: { name: string; bytes: Uint8Array },
  counts: { images: number; documents: number },
) => Promise<{ text: string; image?: ToolImage; document?: ToolDocument }>
