import { timed } from "@openwork/timeline";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { currentTestEvidence } from "./ambient.ts";
import type { ScreenshotArtifact } from "./screenshot.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const CACHE_DIR = join(REPO_ROOT, "evals", "results", ".vision-cache");
// models.dev's checked-in catalog marks both current defaults as accepting
// image input. The provider-specific IDs keep the no-SDK transport portable.
const OPENAI_DEFAULT_MODEL = "gpt-5.6";
const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";

export interface VisualExpectationResult {
  expectation: string;
  passed: boolean;
  evidence: string;
}

export interface VisualEvidenceResult {
  ok: boolean;
  description: string;
  results: VisualExpectationResult[];
  why: string;
  model: string;
  cached: boolean;
  deferred?: boolean;
  pendingExpectations?: string[];
}

export interface VisionRequest {
  prompt: string;
  png: Buffer;
  model: string;
}

export interface ValidateOptions {
  ask?: (req: VisionRequest) => Promise<string>;
  bypassCache?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonResponse(raw: string, label: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} was not valid JSON: ${message}. Response: ${trimmed.slice(0, 300)}`);
  }
}

function parseDescription(raw: string): string {
  const value = parseJsonResponse(raw, "Vision model description response");
  if (!isRecord(value) || typeof value.description !== "string" || !value.description.trim()) {
    throw new Error(`Vision model description response must be {"description":"..."}. Response: ${raw.trim().slice(0, 300)}`);
  }
  return value.description.trim();
}

function parseResults(value: unknown, expectations: string[], label: string): VisualExpectationResult[] {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length !== expectations.length) {
    throw new Error(`${label} must contain exactly ${expectations.length} result entries.`);
  }
  const parsed: VisualExpectationResult[] = [];
  for (let index = 0; index < expectations.length; index += 1) {
    const expectation = expectations[index];
    const entry = value.results[index];
    if (
      !expectation
      || !isRecord(entry)
      || entry.expectation !== expectation
      || typeof entry.passed !== "boolean"
      || typeof entry.evidence !== "string"
      || !entry.evidence.trim()
    ) {
      throw new Error(`${label} result ${index + 1} must preserve the expectation and include boolean passed plus non-empty evidence.`);
    }
    parsed.push({ expectation, passed: entry.passed, evidence: entry.evidence.trim() });
  }
  return parsed;
}

function parseVerdict(raw: string, expectations: string[]): VisualExpectationResult[] {
  return parseResults(parseJsonResponse(raw, "Vision model verdict response"), expectations, "Vision model verdict response");
}

function parseCachedVisualEvidence(value: unknown, expectations: string[], model: string): VisualEvidenceResult {
  if (
    !isRecord(value)
    || typeof value.description !== "string"
    || typeof value.why !== "string"
    || typeof value.ok !== "boolean"
    || value.model !== model
  ) {
    throw new Error("Vision cache entry has an invalid VisualEvidenceResult shape.");
  }
  const results = parseResults(value, expectations, "Vision cache entry");
  const ok = results.every((result) => result.passed);
  if (value.ok !== ok || (ok && value.why !== "")) {
    throw new Error("Vision cache entry has an inconsistent verdict.");
  }
  return {
    ok,
    description: value.description,
    results,
    why: value.why,
    model,
    cached: true,
  };
}

function providerJson(raw: string, provider: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${provider} returned a non-JSON response: ${raw.slice(0, 300)}`);
  }
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error && error.name === "TimeoutError") return true;
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function askOpenAi(req: VisionRequest, key: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    // Unbounded vision calls stalled runs for undici's full 300s header
    // timeout; 120s comfortably covers slow multimodal responses.
    signal: AbortSignal.timeout(120_000),
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: req.model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: req.prompt },
          { type: "image_url", image_url: { url: `data:image/png;base64,${req.png.toString("base64")}` } },
        ],
      }],
      response_format: { type: "json_object" },
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenAI vision request failed with HTTP ${response.status}: ${raw.slice(0, 500)}`);
  const body = providerJson(raw, "OpenAI");
  const choices = isRecord(body) ? body.choices : null;
  const first = Array.isArray(choices) ? choices[0] : null;
  const message = isRecord(first) ? first.message : null;
  const content = isRecord(message) ? message.content : null;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`OpenAI vision response did not contain message content: ${raw.slice(0, 500)}`);
  }
  return content;
}

async function askAnthropic(req: VisionRequest, key: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 2_048,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: req.png.toString("base64") } },
          { type: "text", text: req.prompt },
        ],
      }],
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Anthropic vision request failed with HTTP ${response.status}: ${raw.slice(0, 500)}`);
  const body = providerJson(raw, "Anthropic");
  const content = isRecord(body) ? body.content : null;
  const text = Array.isArray(content)
    ? content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n")
    : "";
  if (!text.trim()) throw new Error(`Anthropic vision response did not contain text content: ${raw.slice(0, 500)}`);
  return text;
}

function failureSummary(results: VisualExpectationResult[]): string {
  const failures = results.filter((result) => !result.passed);
  if (failures.length === 0) return "";
  return `Failed ${failures.length}/${results.length} visual expectations: ${failures
    .map((result) => `${result.expectation} — ${result.evidence}`)
    .join("; ")}`;
}

function visionModel(): string {
  const openAiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  return process.env.OPENWORK_EVAL_VISION_MODEL?.trim()
    || (anthropicKey && !openAiKey ? ANTHROPIC_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL);
}

export async function judgeVision(
  screenshotArtifact: ScreenshotArtifact,
  expectations: string[],
  opts: ValidateOptions = {},
): Promise<VisualEvidenceResult> {
  // Vision latency is the main per-screenshot cost; record it so results show it.
  const openAiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  const model = visionModel();
  let ask = opts.ask;
  if (!ask) {
    if (openAiKey) ask = (req) => askOpenAi(req, openAiKey);
    else if (anthropicKey) ask = (req) => askAnthropic(req, anthropicKey);
    else {
      throw new Error(
        "Vision validation requires OPENAI_API_KEY or ANTHROPIC_API_KEY, unless ValidateOptions.ask is provided.",
      );
    }
  }
  const askOnce = ask;
  ask = async (req) => {
    try {
      return await askOnce(req);
    } catch (error) {
      if (!isTimeoutError(error)) throw error;
      await delay(10_000);
      try {
        return await askOnce(req);
      } catch (retryError) {
        if (!isTimeoutError(retryError)) throw retryError;
        throw new Error("Vision request timed out on both attempts.", { cause: retryError });
      }
    }
  };

  const key = createHash("sha256")
    .update(screenshotArtifact.hash + JSON.stringify(expectations) + model)
    .digest("hex");
  const cachePath = join(CACHE_DIR, `${key}.json`);
  let visualEvidence: VisualEvidenceResult | null = null;
  if (!opts.bypassCache) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8"));
      visualEvidence = parseCachedVisualEvidence(cached, expectations, model);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        // Cache miss: perform the two independent model requests below.
      } else {
        throw error;
      }
    }
  }
  if (!visualEvidence) {
    const description = parseDescription(await ask({
      prompt: [
        "Objectively describe only what is visibly present in this screenshot.",
        "Do not infer hidden state, correctness, intent, or expected behavior.",
        "Return only JSON matching: {\"description\":\"concise visible description\"}",
      ].join("\n"),
      png: screenshotArtifact.png,
      model,
    }));
    const results = parseVerdict(await ask({
      prompt: [
        "Judge each expectation against the screenshot and the expectation-free description below.",
        `Independent description: ${JSON.stringify(description)}`,
        `Expectations: ${JSON.stringify(expectations)}`,
        "Return only JSON matching: {\"results\":[{\"expectation\":\"exact expectation text\",\"passed\":true,\"evidence\":\"short visible quote or observation\"}]}",
        "Return exactly one result per expectation, in the same order. Treat negative expectations literally and do not assume success.",
      ].join("\n"),
      png: screenshotArtifact.png,
      model,
    }), expectations);
    visualEvidence = {
      ok: results.every((result) => result.passed),
      description,
      results,
      why: failureSummary(results),
      model,
      cached: false,
    };
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(visualEvidence, null, 2)}\n`, "utf8");
  }
  return visualEvidence;
}

export async function validate(
  screenshotArtifact: ScreenshotArtifact,
  expectations: string[],
  opts: ValidateOptions = {},
): Promise<VisualEvidenceResult> {
  // A caller-provided ask is a deterministic witness, not an LLM call, so defer never applies to it.
  if (!opts.ask && process.env.OPENWORK_EVAL_VISION?.trim() === "defer") {
    const visualEvidence: VisualEvidenceResult = {
      ok: true,
      description: "",
      results: [],
      why: "vision judgment deferred",
      model: visionModel(),
      cached: false,
      deferred: true,
      pendingExpectations: expectations,
    };
    currentTestEvidence()?.recordVisualValidation(screenshotArtifact.hash, visualEvidence);
    return visualEvidence;
  }

  const visualEvidence = await judgeVision(screenshotArtifact, expectations, opts);
  currentTestEvidence()?.recordVisualValidation(screenshotArtifact.hash, visualEvidence);
  return visualEvidence;
}
