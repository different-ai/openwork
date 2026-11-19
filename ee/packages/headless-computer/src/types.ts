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
  /**
   * A link the computer fetches a kept file from; null when there is none to give. This and `receive` exist only
   * with a store that can hand out links: bytes then go between the store and the computer directly and never pass
   * through the runner. A link reaches one file and stops working after `expiresSeconds`. Without them, or when a
   * transfer doesn't arrive, files go through `read`, `add` and `replace`.
   */
  downloadUrl?(sessionId: string, id: string, expiresSeconds: number): Promise<string | null>
  /**
   * A link the computer sends a file to. `finish` checks what arrived and keeps it as a new file, or as the new
   * version of `replaces`; null when nothing arrived. Both throw like `add` when the file doesn't fit.
   */
  receive?(
    sessionId: string,
    input: { name: string; size: number; source: "agent"; replaces?: string; expiresSeconds: number },
  ): Promise<{ url: string; finish(): Promise<ComputerFile | null> } | null>
}

/**
 * Turns a file into what the model can see: an image or PDF as model input, text as text, or a note. `counts`
 * caps images and PDFs per result across the files of one call.
 */
export type FileReader = (
  file: { name: string; bytes: Uint8Array },
  counts: { images: number; documents: number },
) => Promise<{ text: string; image?: ToolImage; document?: ToolDocument }>
