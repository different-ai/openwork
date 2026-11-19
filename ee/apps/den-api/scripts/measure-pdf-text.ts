/**
 * Measures memory and time for extracting text from large generated PDFs, the
 * way the Drive read capability does. Nothing is stored: each PDF is built in
 * memory. Each case runs in its own process so peak RSS is not shared.
 *
 *   node --conditions=development --import tsx scripts/measure-pdf-text.ts [sizeMb...]
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { extractPdfText } from "../src/capability-sources/pdf-text.js"
import { buildPdf } from "../test/fixtures/pdf.js"

type Shape = "text_and_images" | "scan" | "broken_xref"
const MB = 1024 * 1024

function generate(shape: Shape, sizeMb: number): Uint8Array {
  const pageCount = 200
  const imageBytesPerPage = Math.floor((sizeMb * MB) / pageCount)
  const lines = (page: number) => shape === "scan" ? [] : Array.from({ length: 40 }, (_, line) => `Page ${page + 1} line ${line + 1}: phase, owner, start and end dates for the work breakdown.`)
  const pdf = buildPdf(Array.from({ length: pageCount }, (_, page) => lines(page)), { imageBytesPerPage })
  if (shape !== "broken_xref") return pdf
  // A wrong startxref makes pdf.js scan every object in the file: the slowest way to open it.
  const tail = Buffer.from(pdf.subarray(pdf.byteLength - 64)).toString("latin1").replace(/startxref\n\d+/, "startxref\n1")
  const broken = new Uint8Array(pdf.byteLength - 64 + Buffer.byteLength(tail, "latin1"))
  broken.set(pdf.subarray(0, pdf.byteLength - 64))
  broken.set(Buffer.from(tail, "latin1"), pdf.byteLength - 64)
  return broken
}

async function measureOne(shape: Shape, sizeMb: number) {
  const pdf = generate(shape, sizeMb)
  const fileMb = pdf.byteLength / MB
  global.gc?.()
  const baselineMb = process.memoryUsage().rss / MB
  let peakMb = baselineMb
  const sampler = setInterval(() => { peakMb = Math.max(peakMb, process.memoryUsage().rss / MB) }, 5)
  // The longest gap between 1 ms ticks: how long other requests on this server would wait.
  let lastTick = performance.now()
  let maxBlockMs = 0
  const ticker = setInterval(() => { const now = performance.now(); maxBlockMs = Math.max(maxBlockMs, now - lastTick); lastTick = now }, 1)
  const started = performance.now()
  const result = await extractPdfText(pdf, { maxCharacters: 200_000, timeoutMs: 60_000 })
  const elapsedMs = performance.now() - started
  clearInterval(ticker)
  maxBlockMs = Math.max(maxBlockMs, performance.now() - lastTick)
  clearInterval(sampler)
  peakMb = Math.max(peakMb, process.memoryUsage().rss / MB)
  console.log(JSON.stringify({
    shape,
    fileMb: Number(fileMb.toFixed(1)),
    result: result.kind,
    characters: result.kind === "text" ? result.text.length : 0,
    elapsedMs: Math.round(elapsedMs),
    maxEventLoopBlockMs: Math.round(maxBlockMs),
    // RSS while extracting, above the process with the PDF already in memory.
    extractionRssMb: Math.round(peakMb - baselineMb),
    // Whole-process peak: Node, the generated PDF and the extraction.
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  }))
}

const [shapeArgument, sizeArgument] = process.argv.slice(2)
if (shapeArgument === "--one" && sizeArgument) {
  const [shape, size] = sizeArgument.split(":")
  if (shape !== "text_and_images" && shape !== "scan" && shape !== "broken_xref") throw new Error(`unknown shape ${shape}`)
  await measureOne(shape, Number(size))
} else {
  const sizes = process.argv.slice(2).map(Number).filter((size) => size > 0)
  for (const size of sizes.length ? sizes : [10, 25, 50]) {
    for (const shape of ["text_and_images", "scan", "broken_xref"] satisfies Shape[]) {
      const child = spawnSync(process.execPath, [
        "--expose-gc", "--conditions=development", "--import", "tsx", fileURLToPath(import.meta.url), "--one", `${shape}:${size}`,
      ], { encoding: "utf8" })
      process.stdout.write(child.stdout || child.stderr)
    }
  }
}
