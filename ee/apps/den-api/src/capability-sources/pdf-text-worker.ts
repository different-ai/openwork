import { parentPort, workerData } from "node:worker_threads"
import { extractPdfTextInThisThread, type PdfTextWorkerInput } from "./pdf-text.js"

if (!parentPort) throw new Error("PDF text extraction must run in a worker thread.")

function isInput(value: unknown): value is PdfTextWorkerInput {
  return typeof value === "object" && value !== null
    && "buffer" in value && value.buffer instanceof ArrayBuffer
    && "byteOffset" in value && typeof value.byteOffset === "number"
    && "byteLength" in value && typeof value.byteLength === "number"
    && "maxCharacters" in value && typeof value.maxCharacters === "number"
}

const input: unknown = workerData
if (!isInput(input)) throw new Error("PDF text extraction received invalid input.")
parentPort.postMessage(await extractPdfTextInThisThread(new Uint8Array(input.buffer, input.byteOffset, input.byteLength), input.maxCharacters))
