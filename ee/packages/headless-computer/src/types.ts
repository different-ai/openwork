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
  readonly maxFileBytes: number
  list(sessionId: string): ComputerFile[]
  read(sessionId: string, id: string): Promise<{ file: ComputerFile; bytes: Uint8Array<ArrayBuffer> } | null>
  add(sessionId: string, input: { name: string; bytes: Uint8Array<ArrayBuffer>; source: "agent" }): Promise<ComputerFile>
  replace(sessionId: string, id: string, input: { bytes: Uint8Array<ArrayBuffer> }): Promise<ComputerFile | null>
  putPreview(sessionId: string, id: string, pages: Array<Uint8Array<ArrayBuffer>>, size: { width: number; height: number }): Promise<boolean>
  downloadUrl?(sessionId: string, id: string, expiresSeconds: number): Promise<string | null>
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
