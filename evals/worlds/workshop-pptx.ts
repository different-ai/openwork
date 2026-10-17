import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactWitness } from "./workshop-narrative-contract.ts";
const run = promisify(execFile);

function parser() {
  const python = process.env.OPENWORK_WORKSHOP_PYTHON;
  return python ? { command: python, args: [] } : { command: process.env.OPENWORK_WORKSHOP_UVX ?? "uvx", args: ["--from", "python-pptx", "python"] };
}
export async function verifyWorkshopPptxPrerequisite() {
  const selected = parser();
  await run(selected.command, [...selected.args, "-c", "from pptx import Presentation;import zipfile"], { timeout: 60000 });
}
const script = "import json,sys,zipfile;from pptx import Presentation;p=Presentation(sys.argv[1]);texts=[s.text for slide in p.slides for s in slide.shapes if s.has_text_frame];texts += [c.text for slide in p.slides for s in slide.shapes if s.has_table for row in s.table.rows for c in row.cells];texts += [r.target_ref for slide in p.slides for r in slide.part.rels.values() if r.is_external];print(json.dumps({'slides':len(p.slides),'validZip':zipfile.is_zipfile(sys.argv[1]),'text':'\\n'.join(texts)}))";

/** The exact provider file ID is used, not a path compared with a basename. */
export async function inspectWorkshopPptx(options: { origin: string; fileId: string; sessionId: string; directory: string }): Promise<{ artifact: ArtifactWitness; reason: string } | { reason: string }> {
  const response = await fetch(new URL(`/download/${encodeURIComponent(options.fileId)}`, options.origin), { redirect: "error" });
  if (!response.ok) return { reason: `Independent PPTX download failed with HTTP ${response.status}` };
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await mkdir(options.directory, { recursive: true });
  const path = join(options.directory, `${sha256}.pptx`);
  await writeFile(path, bytes);
  const selected = parser();
  try {
    const parsed = await run(selected.command, [...selected.args, "-c", script, path], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    const result: unknown = JSON.parse(parsed.stdout);
    if (!result || typeof result !== "object" || !("slides" in result) || typeof result.slides !== "number" || !("text" in result) || typeof result.text !== "string" || !("validZip" in result) || result.validZip !== true) return { reason: "Independent python-pptx result did not satisfy the parser contract" };
    return { artifact: { fileId: options.fileId, sha256, downloadedSha256: sha256, validZip: true, validPresentation: true, slideCount: result.slides, extractedText: result.text, generatedBySessionId: options.sessionId }, reason: "Actual downloaded bytes opened by python-pptx; no Office UI rendering claim" };
  } catch {
    return { artifact: { fileId: options.fileId, sha256, downloadedSha256: sha256, validZip: false, validPresentation: false, slideCount: 0, extractedText: "", generatedBySessionId: options.sessionId }, reason: "Independent python-pptx did not validate the downloaded presentation; original bytes retained privately by SHA-256" };
  }
}
