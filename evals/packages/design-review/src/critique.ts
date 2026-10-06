import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LayoutSnapshot } from "./layout.ts";
import { parseDesignNote, type DesignNote } from "./notes.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const CACHE_DIR = join(REPO_ROOT, "evals", "results", ".design-review-cache");
const MAX_FINDINGS = 6;

/** One multimodal request; the caller supplies the provider (see @openwork/test-evidence). */
export interface VisionRequest {
  prompt: string;
  png: Buffer;
  model: string;
}

export type AskVision = (req: VisionRequest) => Promise<string>;

function parseJsonResponse(raw: string, label: string): unknown {
  const trimmed = raw.trim();
  const candidate = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${error instanceof Error ? error.message : String(error)}. Response: ${trimmed.slice(0, 300)}`);
  }
}

export interface DesignRubric {
  /** The prompt section: the OpenWork Design pack plus DESIGN.md. */
  text: string;
  /** Short content hash, recorded with every review and part of the cache key. */
  hash: string;
}

/**
 * The rubric is the packed OpenWork Design rules plus DESIGN.md as it is in
 * this checkout, so a DESIGN.md change applies to the next review.
 */
export async function loadDesignRubric(repoRoot = REPO_ROOT): Promise<DesignRubric> {
  const pack = await readFile(join(repoRoot, "evals", "design-review", "rubric.md"), "utf8");
  const design = await readFile(join(repoRoot, "DESIGN.md"), "utf8");
  const text = `${pack.trim()}\n\n---\n\n${design.trim()}\n`;
  return { text, hash: createHash("sha256").update(text).digest("hex").slice(0, 12) };
}

export interface CritiqueInput {
  png: Buffer;
  hash: string;
  caption: string;
  route: string;
  layout: LayoutSnapshot | null;
  /** Measured findings for this screenshot, so the model aims instead of repeating them. */
  measured: DesignNote[];
}

export function critiquePrompt(input: CritiqueInput, rubric: DesignRubric): string {
  const viewport = input.layout ? `${input.layout.viewport.width}×${input.layout.viewport.height}` : "unknown";
  const images = input.layout?.images.length
    ? input.layout.images.map((rect) => `x ${Math.round(rect.x)}, y ${Math.round(rect.y)}, ${Math.round(rect.width)}×${Math.round(rect.height)}px`).join("; ")
    : "none";
  const measured = input.measured.length
    ? input.measured.map((note) => `- ${note.rule}: ${note.title}. ${note.detail}`).join("\n")
    : "- none";
  return [
    "You are OpenWork's design reviewer. Judge ONE screenshot of a real OpenWork screen against the team's rules below.",
    "Find what is off; do not describe what is fine. Follow the rubric's How to judge section exactly.",
    `Screen: ${JSON.stringify(input.caption)}; route ${JSON.stringify(input.route || "unknown")}; window ${viewport}.`,
    `Images on screen (content; never judge what they depict): ${images}.`,
    "Measured layout findings (exact, from the DOM; do not repeat them):",
    measured,
    `Return only JSON: {"findings":[{"rule":"DESIGN.md or OW-* id","severity":"medium|low","title":"what is wrong, 4-12 words","evidence":"what you see, quoting on-screen text","where":{"x":0.0,"y":0.0,"width":0.0,"height":0.0}}]}`,
    `"where" is the affected area as fractions (0-1) of the screenshot's width and height, or null. At most ${MAX_FINDINGS} findings; [] when nothing is off.`,
    "",
    "RUBRIC",
    rubric.text,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps only well-formed findings; a model that invents `high` is capped at medium. */
export function parseCritique(raw: string): DesignNote[] {
  const value = parseJsonResponse(raw, "Design review response");
  if (!isRecord(value) || !Array.isArray(value.findings)) {
    throw new Error(`Design review response must be {"findings":[...]}. Response: ${raw.trim().slice(0, 300)}`);
  }
  const notes: DesignNote[] = [];
  for (const finding of value.findings.slice(0, MAX_FINDINGS)) {
    if (!isRecord(finding)) continue;
    const note = parseDesignNote({
      rule: finding.rule,
      severity: finding.severity === "high" ? "medium" : finding.severity,
      title: finding.title,
      detail: finding.evidence,
      source: "vision",
      region: finding.where,
    });
    if (note) notes.push(note);
  }
  return notes;
}

export async function critiqueScreenshot(
  input: CritiqueInput,
  rubric: DesignRubric,
  options: { ask: AskVision; model: string; bypassCache?: boolean },
): Promise<DesignNote[]> {
  const prompt = critiquePrompt(input, rubric);
  const key = createHash("sha256").update(`${input.hash}\n${options.model}\n${prompt}`).digest("hex");
  const cachePath = join(CACHE_DIR, `${key}.json`);
  if (!options.bypassCache) {
    const cached = await readFile(cachePath, "utf8").catch(() => null);
    if (cached !== null) return parseCritique(cached);
  }
  const raw = await options.ask({ prompt, png: input.png, model: options.model });
  const notes = parseCritique(raw);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath, `${JSON.stringify({ findings: notes.map((note) => ({ ...note, evidence: note.detail, where: note.region ?? null })) })}\n`, "utf8");
  return notes;
}
