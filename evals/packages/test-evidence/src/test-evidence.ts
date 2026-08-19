import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScreenshotArtifact } from "./screenshot.ts";
import { judgeVision } from "./validate.ts";
import type { ValidateOptions, VisualEvidenceResult, VisualExpectationResult } from "./validate.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

export type EvidenceJudgmentState = "passed" | "failed" | "pending";

export interface EvidenceJudgment {
  expectation: string;
  state: EvidenceJudgmentState;
  reasoning: string;
}

export interface TestArtifact {
  caption: string;
  fileName: string;
  hash: string;
  route: string;
  at: string;
  description: string;
  model: string;
  ok: boolean | null;
  results: VisualExpectationResult[];
  judgments: EvidenceJudgment[];
}

export interface TestRunSummary {
  ok: boolean;
  totalArtifacts: number;
  passedArtifacts: number;
  failedArtifacts: number;
  unvalidatedArtifacts: number;
  pendingArtifacts: number;
  passedExpectations: number;
  failedExpectations: number;
  pendingJudgments: number;
}

export interface TestRunRecord {
  name: string;
  dir: string;
  createdAt: string;
  closedAt: string;
  gitSha?: string;
  branch?: string;
  summary: TestRunSummary;
  artifacts: TestArtifact[];
}

interface StoredTestArtifact extends TestArtifact {
  sequence: number;
  png: Buffer | null;
  validationKey: string | null;
}

export interface TestEvidenceRecorder {
  readonly dir: string;
  recordScreenshot(screenshotArtifact: ScreenshotArtifact): string;
  recordVisualValidation(screenshotHash: string, visualEvidence: VisualEvidenceResult): string;
  recordAssertionEvidence(assertion: string, evidence: string, passed: boolean): void;
  close(): Promise<string>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface JudgeTestRunOptions extends ValidateOptions {
  force?: boolean;
}

export interface JudgeTestRunResult {
  testRunPath: string;
  judgedValidations: number;
  failedValidations: number;
  pendingValidations: number;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "artifact";
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fileName(sequence: number, caption: string): string {
  return `${String(sequence).padStart(2, "0")}-${slug(caption)}.png`;
}

function judgmentsForVisualEvidence(visualEvidence: VisualEvidenceResult): EvidenceJudgment[] {
  if (visualEvidence.deferred) {
    if (!visualEvidence.pendingExpectations) throw new Error("Deferred visual evidence must include pending expectations.");
    return visualEvidence.pendingExpectations.map((expectation) => ({
      expectation,
      state: "pending",
      reasoning: visualEvidence.why,
    }));
  }
  return visualEvidence.results.map((result) => ({
    expectation: result.expectation,
    state: result.passed ? "passed" : "failed",
    reasoning: result.evidence,
  }));
}

function artifactCaption(name: string, sequence: number, visualEvidence?: VisualEvidenceResult): string {
  return visualEvidence?.results[0]?.expectation.trim()
    || visualEvidence?.pendingExpectations?.[0]?.trim()
    || `${name} artifact ${sequence}`;
}

function visualValidationKey(visualEvidence: VisualEvidenceResult): string {
  return JSON.stringify(judgmentsForVisualEvidence(visualEvidence).map((judgment) => judgment.expectation.trim()));
}

function gitValue(args: string[]): string {
  const result = spawnSync("git", ["rev-parse", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 && !result.error ? result.stdout.trim() : "";
}

function testArtifact(artifact: StoredTestArtifact): TestArtifact {
  return {
    caption: artifact.caption,
    fileName: artifact.fileName,
    hash: artifact.hash,
    route: artifact.route,
    at: artifact.at,
    description: artifact.description,
    model: artifact.model,
    ok: artifact.ok,
    results: artifact.results,
    judgments: artifact.judgments,
  };
}

function summarize(artifacts: TestArtifact[]): TestRunSummary {
  const judgments = artifacts.flatMap((artifact) => artifact.judgments);
  const pendingArtifacts = artifacts.filter((artifact) => artifact.judgments.some((judgment) => judgment.state === "pending")).length;
  return {
    ok: artifacts.length > 0 && artifacts.every((artifact) => artifact.ok === true),
    totalArtifacts: artifacts.length,
    passedArtifacts: artifacts.filter((artifact) => artifact.ok === true).length,
    failedArtifacts: artifacts.filter((artifact) => artifact.ok === false).length,
    unvalidatedArtifacts: artifacts.filter((artifact) => artifact.ok === null).length,
    pendingArtifacts,
    passedExpectations: judgments.filter((judgment) => judgment.state === "passed").length,
    failedExpectations: judgments.filter((judgment) => judgment.state === "failed").length,
    pendingJudgments: judgments.filter((judgment) => judgment.state === "pending").length,
  };
}

function renderArtifact(artifact: TestArtifact): string {
  const pending = artifact.judgments.some((judgment) => judgment.state === "pending");
  const stateClass = pending ? "pending" : artifact.ok === true ? "passed" : artifact.ok === false ? "failed" : "unvalidated";
  const description = artifact.description || (pending ? "Visual validation pending." : "Not visually validated.");
  return `
      <article class="artifact ${stateClass}">
        <h2>${html(artifact.caption)}</h2>
        <p class="meta">${html(artifact.route)} · ${html(artifact.at)}${artifact.model ? ` · ${html(artifact.model)}` : ""}</p>
        ${artifact.fileName ? `<img src="${html(artifact.fileName)}" alt="${html(artifact.caption)}">` : ""}
        <p>${html(description)}</p>
        <ul>${artifact.judgments.map((judgment) => `<li class="${judgment.state}"><strong>${judgment.state.toUpperCase()}</strong> ${html(judgment.expectation)} — ${html(judgment.reasoning)}</li>`).join("")}</ul>
      </article>`;
}

function renderIndex(record: TestRunRecord): string {
  const summary = record.summary;
  const validatedArtifacts = record.artifacts.filter((artifact) => artifact.judgments.length > 0).map(renderArtifact).join("");
  const unvalidatedArtifacts = record.artifacts.filter((artifact) => artifact.judgments.length === 0);
  const unvalidatedMarkup = unvalidatedArtifacts.length > 0
    ? `<details class="unvalidated-artifacts unvalidated"><summary>unvalidated artifacts (${unvalidatedArtifacts.length})</summary>${unvalidatedArtifacts.map(renderArtifact).join("")}</details>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(record.name)} test evidence</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;background:#f6f7f9;color:#17191d}header,.artifact,details{background:white;border:1px solid #dfe2e8;border-radius:12px;padding:20px;margin:0 0 24px}.artifact.passed{border-left:6px solid #238636}.artifact.failed{border-left:6px solid #cf222e}.artifact.pending,.artifact.unvalidated,details.unvalidated{border-left:6px solid #9a6700}details .artifact{margin-top:20px}summary{cursor:pointer;font-weight:700}img{display:block;width:100%;height:auto;border:1px solid #dfe2e8;border-radius:8px}.meta{color:#636c76}.passed strong{color:#1a7f37}.failed strong{color:#cf222e}.pending strong{color:#9a6700}li{margin:8px 0}
</style></head><body><header><h1>${html(record.name)}</h1><p>${summary.passedArtifacts}/${summary.totalArtifacts} artifacts passed; ${summary.failedArtifacts} failed; ${summary.pendingArtifacts} pending; ${summary.unvalidatedArtifacts - summary.pendingArtifacts} unvalidated. ${summary.passedExpectations} expectations passed, ${summary.failedExpectations} failed, and ${summary.pendingJudgments} pending.</p></header>${validatedArtifacts}${unvalidatedMarkup}</body></html>
`;
}

async function writeTestRun(record: TestRunRecord, testRunDir: string): Promise<void> {
  await writeFile(join(testRunDir, "test-run.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await writeFile(join(testRunDir, "index.html"), renderIndex(record), "utf8");
}

function parseVisualExpectationResult(value: unknown): VisualExpectationResult | null {
  if (
    !isRecord(value)
    || typeof value.expectation !== "string"
    || typeof value.passed !== "boolean"
    || typeof value.evidence !== "string"
  ) return null;
  return { expectation: value.expectation, passed: value.passed, evidence: value.evidence };
}

function parseJudgment(value: unknown): EvidenceJudgment | null {
  if (
    !isRecord(value)
    || typeof value.expectation !== "string"
    || (value.state !== "passed" && value.state !== "failed" && value.state !== "pending")
    || typeof value.reasoning !== "string"
  ) return null;
  return { expectation: value.expectation, state: value.state, reasoning: value.reasoning };
}

function judgmentForResult(result: VisualExpectationResult): EvidenceJudgment {
  return {
    expectation: result.expectation,
    state: result.passed ? "passed" : "failed",
    reasoning: result.evidence,
  };
}

function parseTestArtifact(value: unknown): TestArtifact | null {
  if (
    !isRecord(value)
    || typeof value.caption !== "string"
    || typeof value.fileName !== "string"
    || typeof value.hash !== "string"
    || typeof value.route !== "string"
    || typeof value.at !== "string"
    || typeof value.description !== "string"
    || typeof value.model !== "string"
    || !Array.isArray(value.results)
  ) return null;
  let ok: boolean | null;
  if (value.ok === null) ok = null;
  else if (typeof value.ok === "boolean") ok = value.ok;
  else return null;
  const results: VisualExpectationResult[] = [];
  for (const result of value.results) {
    const parsed = parseVisualExpectationResult(result);
    if (!parsed) return null;
    results.push(parsed);
  }
  const judgments: EvidenceJudgment[] = [];
  if (Array.isArray(value.judgments)) {
    for (const judgment of value.judgments) {
      const parsed = parseJudgment(judgment);
      if (!parsed) return null;
      judgments.push(parsed);
    }
  } else {
    judgments.push(...results.map(judgmentForResult));
  }
  return {
    caption: value.caption,
    fileName: value.fileName,
    hash: value.hash,
    route: value.route,
    at: value.at,
    description: value.description,
    model: value.model,
    ok,
    results,
    judgments,
  };
}

function parseTestRun(value: unknown): TestRunRecord | null {
  if (
    !isRecord(value)
    || typeof value.name !== "string"
    || typeof value.dir !== "string"
    || typeof value.createdAt !== "string"
    || typeof value.closedAt !== "string"
    || !Array.isArray(value.artifacts)
  ) return null;
  const artifacts: TestArtifact[] = [];
  for (const artifact of value.artifacts) {
    const parsed = parseTestArtifact(artifact);
    if (!parsed) return null;
    artifacts.push(parsed);
  }
  const gitSha = typeof value.gitSha === "string" ? value.gitSha : undefined;
  const branch = typeof value.branch === "string" ? value.branch : undefined;
  return {
    name: value.name,
    dir: value.dir,
    createdAt: value.createdAt,
    closedAt: value.closedAt,
    gitSha,
    branch,
    summary: summarize(artifacts),
    artifacts,
  };
}

function artifactOk(judgments: EvidenceJudgment[]): boolean | null {
  if (judgments.length === 0 || judgments.some((judgment) => judgment.state === "pending")) return null;
  return judgments.every((judgment) => judgment.state === "passed");
}

function resultForJudgment(judgment: EvidenceJudgment): VisualExpectationResult[] {
  if (judgment.state === "pending") return [];
  return [{
    expectation: judgment.expectation,
    passed: judgment.state === "passed",
    evidence: judgment.reasoning,
  }];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function judgeTestRun(testRunDir: string, opts: JudgeTestRunOptions = {}): Promise<JudgeTestRunResult> {
  const testRunPath = join(testRunDir, "test-run.json");
  const value: unknown = JSON.parse(await readFile(testRunPath, "utf8"));
  const record = parseTestRun(value);
  if (!record) throw new Error(`Invalid test run: ${testRunPath}`);
  let touched = false;
  let judgedValidations = 0;
  const errors: string[] = [];

  for (const artifact of record.artifacts) {
    if (!artifact.fileName) continue;
    const targetIndexes = artifact.judgments.flatMap((judgment, index) => (
      opts.force || judgment.state === "pending" ? [index] : []
    ));
    if (targetIndexes.length === 0) continue;
    touched = true;
    const expectations = targetIndexes.map((index) => artifact.judgments[index].expectation);
    try {
      const png = await readFile(join(testRunDir, artifact.fileName));
      const visualEvidence = await judgeVision({
        png,
        hash: artifact.hash,
        route: artifact.route,
        visibleText: "",
        at: artifact.at,
      }, expectations, { ask: opts.ask, bypassCache: opts.force });
      for (const [resultIndex, result] of visualEvidence.results.entries()) {
        const judgmentIndex = targetIndexes[resultIndex];
        artifact.judgments[judgmentIndex] = {
          expectation: result.expectation,
          state: result.passed ? "passed" : "failed",
          reasoning: result.evidence,
        };
      }
      artifact.description = visualEvidence.description;
      artifact.model = visualEvidence.model;
      judgedValidations += targetIndexes.length;
    } catch (error) {
      const message = errorMessage(error);
      errors.push(`${artifact.caption}: ${message}`);
      for (const index of targetIndexes) {
        const judgment = artifact.judgments[index];
        artifact.judgments[index] = { ...judgment, state: "pending", reasoning: `Provider error: ${message}` };
      }
    }
    artifact.results = artifact.judgments.flatMap(resultForJudgment);
    artifact.ok = artifactOk(artifact.judgments);
  }

  record.summary = summarize(record.artifacts);
  if (touched) await writeTestRun(record, testRunDir);
  const visualJudgments = record.artifacts.filter((artifact) => artifact.fileName).flatMap((artifact) => artifact.judgments);
  return {
    testRunPath,
    judgedValidations,
    failedValidations: visualJudgments.filter((judgment) => judgment.state === "failed").length,
    pendingValidations: visualJudgments.filter((judgment) => judgment.state === "pending").length,
    errors,
  };
}

export function createTestEvidence(meta: { name: string; outDir?: string }): TestEvidenceRecorder {
  const { name } = meta;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = meta.outDir ?? join(REPO_ROOT, "evals", "results", "test-runs", `${stamp}-${slug(name)}`);
  const artifacts: StoredTestArtifact[] = [];
  const createdAt = new Date().toISOString();
  const gitSha = gitValue(["HEAD"]);
  const branch = gitValue(["--abbrev-ref", "HEAD"]);
  let nextSequence = 1;
  let closing: Promise<string> | null = null;

  const assertOpen = (): void => {
    if (closing) throw new Error(`Cannot record test evidence after "${name}" is closed.`);
  };

  const close = (): Promise<string> => {
    if (closing) return closing;
    closing = (async () => {
      await mkdir(dir, { recursive: true });
      for (const artifact of artifacts) {
        if (artifact.png) await writeFile(join(dir, artifact.fileName), artifact.png);
      }
      const orderedArtifacts = [
        ...artifacts.filter((artifact) => artifact.validationKey !== null),
        ...artifacts.filter((artifact) => artifact.validationKey === null),
      ].map(testArtifact);
      const record: TestRunRecord = {
        name,
        dir,
        createdAt,
        closedAt: new Date().toISOString(),
        gitSha,
        branch,
        summary: summarize(orderedArtifacts),
        artifacts: orderedArtifacts,
      };
      await writeTestRun(record, dir);
      return join(dir, "index.html");
    })();
    return closing;
  };

  return {
    dir,
    recordScreenshot(screenshotArtifact) {
      assertOpen();
      const sequence = nextSequence;
      nextSequence += 1;
      const caption = artifactCaption(name, sequence);
      const screenshotFileName = fileName(sequence, caption);
      artifacts.push({
        caption,
        fileName: screenshotFileName,
        hash: screenshotArtifact.hash,
        route: screenshotArtifact.route,
        at: screenshotArtifact.at,
        description: "",
        model: "",
        ok: null,
        results: [],
        judgments: [],
        sequence,
        png: screenshotArtifact.png,
        validationKey: null,
      });
      return join(dir, screenshotFileName);
    },
    recordVisualValidation(screenshotHash, visualEvidence) {
      assertOpen();
      const key = visualValidationKey(visualEvidence);
      const judgments = judgmentsForVisualEvidence(visualEvidence);
      const validated = artifacts.find((artifact) => artifact.png !== null && artifact.hash === screenshotHash && artifact.validationKey !== null);
      if (validated) {
        const caption = artifactCaption(name, validated.sequence, visualEvidence);
        if (validated.validationKey !== key) {
          throw new Error(`Screenshot pixels for "${caption}" already back the different visual validation "${validated.caption}".`);
        }
        validated.caption = caption;
        validated.fileName = fileName(validated.sequence, caption);
        validated.description = visualEvidence.description;
        validated.model = visualEvidence.model;
        validated.ok = visualEvidence.deferred ? null : visualEvidence.ok;
        validated.results = visualEvidence.results;
        validated.judgments = judgments;
        return join(dir, validated.fileName);
      }
      const screenshotArtifact = artifacts.find((artifact) => artifact.png !== null && artifact.hash === screenshotHash && artifact.validationKey === null);
      if (!screenshotArtifact) throw new Error(`No recorded screenshot has hash "${screenshotHash}".`);
      const caption = artifactCaption(name, screenshotArtifact.sequence, visualEvidence);
      screenshotArtifact.caption = caption;
      screenshotArtifact.fileName = fileName(screenshotArtifact.sequence, caption);
      screenshotArtifact.description = visualEvidence.description;
      screenshotArtifact.model = visualEvidence.model;
      screenshotArtifact.ok = visualEvidence.deferred ? null : visualEvidence.ok;
      screenshotArtifact.results = visualEvidence.results;
      screenshotArtifact.judgments = judgments;
      screenshotArtifact.validationKey = key;
      return join(dir, screenshotArtifact.fileName);
    },
    recordAssertionEvidence(assertion, evidence, passed) {
      assertOpen();
      const sequence = nextSequence;
      nextSequence += 1;
      const caption = assertion.trim() || `${name} assertion ${sequence}`;
      artifacts.push({
        caption,
        fileName: "",
        hash: "",
        route: "",
        at: new Date().toISOString(),
        description: evidence,
        model: "",
        ok: passed,
        results: [{ expectation: caption, evidence, passed }],
        judgments: [{ expectation: caption, state: passed ? "passed" : "failed", reasoning: evidence }],
        sequence,
        png: null,
        validationKey: JSON.stringify([caption]),
      });
    },
    close,
    async [Symbol.asyncDispose]() {
      await close();
    },
  };
}
