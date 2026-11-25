import { Worker } from "node:worker_threads"
import { getResolvedPDFJS } from "unpdf"

export type PdfTextResult =
  | { kind: "text"; text: string; truncated: boolean; pageCount: number }
  | { kind: "no_text"; pageCount: number }
  | { kind: "unreadable" }
  | { kind: "timed_out" }
  | { kind: "out_of_memory" }

export type PdfTextWorkerInput = { buffer: ArrayBuffer; byteOffset: number; byteLength: number; maxCharacters: number }

const WORKER_HEAP_LIMIT_MB = 512
const MAX_CONCURRENT_EXTRACTIONS = 2
let running = 0
const waiting: (() => void)[] = []

async function withExtractionSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_EXTRACTIONS) await new Promise<void>((resolve) => waiting.push(resolve))
  running += 1
  try {
    return await work()
  } finally {
    running -= 1
    waiting.shift()?.()
  }
}

function isPdfTextResult(value: unknown): value is PdfTextResult {
  return typeof value === "object" && value !== null && "kind" in value
    && (value.kind === "text" || value.kind === "no_text" || value.kind === "unreadable")
}

export async function extractPdfText(
  bytes: Uint8Array,
  options: { maxCharacters: number; timeoutMs: number },
): Promise<PdfTextResult> {
  return withExtractionSlot(() => new Promise<PdfTextResult>((resolve) => {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
    const input: PdfTextWorkerInput = bytes.buffer instanceof ArrayBuffer
      ? { buffer: bytes.buffer, byteOffset: bytes.byteOffset, byteLength: bytes.byteLength, maxCharacters: options.maxCharacters }
      : { buffer: new Uint8Array(bytes).buffer, byteOffset: 0, byteLength: bytes.byteLength, maxCharacters: options.maxCharacters }
    let worker: Worker
    try {
      worker = new Worker(new URL(`./pdf-text-worker.${extension}`, import.meta.url), {
        workerData: input,
        transferList: [input.buffer],
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_LIMIT_MB },
      })
    } catch {
      return resolve({ kind: "unreadable" })
    }
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: PdfTextResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
      void worker.terminate()
    }
    timer = setTimeout(() => finish({ kind: "timed_out" }), options.timeoutMs)
    worker.once("message", (message: unknown) => finish(isPdfTextResult(message) ? message : { kind: "unreadable" }))
    worker.once("error", (error: Error & { code?: string }) => finish(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? { kind: "out_of_memory" } : { kind: "unreadable" }))
    worker.once("exit", () => finish({ kind: "unreadable" }))
  }))
}

export async function extractPdfTextInThisThread(bytes: Uint8Array, maxCharacters: number): Promise<PdfTextResult> {
  const { getDocument } = await getResolvedPDFJS()
  const loadingTask = getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  try {
    const document = await loadingTask.promise
    const pageCount = document.numPages
    const pages: string[] = []
    let length = 0
    let pagesRead = 0
    while (pagesRead < pageCount && length <= maxCharacters) {
      pagesRead += 1
      const page = await document.getPage(pagesRead)
      const content = await page.getTextContent()
      page.cleanup()
      const text = content.items
        .map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : "")
        .join("")
        .trim()
      if (!text) continue
      pages.push(text)
      length += text.length + 2
    }

    const joined = pages.join("\n\n")
    if (!joined) return { kind: "no_text", pageCount }
    const truncated = pagesRead < pageCount || joined.length > maxCharacters
    return { kind: "text", text: joined.slice(0, maxCharacters), truncated, pageCount }
  } catch {
    return { kind: "unreadable" }
  } finally {
    await loadingTask.destroy().catch(() => {})
  }
}
