export interface ArtifactExpectationResult {
  expectation: string;
  passed: boolean;
  evidence: string;
}

export type ArtifactJudgmentState = "passed" | "failed" | "pending";

export interface ArtifactJudgment {
  expectation: string;
  state: ArtifactJudgmentState;
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
  results: ArtifactExpectationResult[];
  judgments: ArtifactJudgment[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseResult(value: unknown): ArtifactExpectationResult | null {
  if (
    !isRecord(value)
    || typeof value.expectation !== "string"
    || typeof value.passed !== "boolean"
    || typeof value.evidence !== "string"
  ) return null;
  return {
    expectation: value.expectation,
    passed: value.passed,
    evidence: value.evidence,
  };
}

function parseJudgment(value: unknown): ArtifactJudgment | null {
  if (
    !isRecord(value)
    || typeof value.expectation !== "string"
    || (value.state !== "passed" && value.state !== "failed" && value.state !== "pending")
    || typeof value.reasoning !== "string"
  ) return null;
  return {
    expectation: value.expectation,
    state: value.state,
    reasoning: value.reasoning,
  };
}

function judgmentForResult(result: ArtifactExpectationResult): ArtifactJudgment {
  return {
    expectation: result.expectation,
    state: result.passed ? "passed" : "failed",
    reasoning: result.evidence,
  };
}

function parseArtifact(value: unknown): TestArtifact | null {
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
  const results: ArtifactExpectationResult[] = [];
  for (const result of value.results) {
    const parsed = parseResult(result);
    if (!parsed) return null;
    results.push(parsed);
  }
  const judgments: ArtifactJudgment[] = [];
  if (value.judgments === undefined) {
    judgments.push(...results.map(judgmentForResult));
  } else {
    if (!Array.isArray(value.judgments)) return null;
    for (const judgment of value.judgments) {
      const parsed = parseJudgment(judgment);
      if (!parsed) return null;
      judgments.push(parsed);
    }
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

function pendingCounts(artifacts: TestArtifact[]): { pendingArtifacts: number; pendingJudgments: number } {
  return {
    pendingArtifacts: artifacts.filter((artifact) => artifact.judgments.some((judgment) => judgment.state === "pending")).length,
    pendingJudgments: artifacts.flatMap((artifact) => artifact.judgments).filter((judgment) => judgment.state === "pending").length,
  };
}

function parseCurrentSummary(value: unknown, artifacts: TestArtifact[]): TestRunSummary | null {
  if (
    !isRecord(value)
    || typeof value.ok !== "boolean"
    || !isCount(value.totalArtifacts)
    || !isCount(value.passedArtifacts)
    || !isCount(value.failedArtifacts)
    || !isCount(value.unvalidatedArtifacts)
    || !isCount(value.passedExpectations)
    || !isCount(value.failedExpectations)
  ) return null;
  const derived = pendingCounts(artifacts);
  const pendingArtifacts = value.pendingArtifacts === undefined ? derived.pendingArtifacts : value.pendingArtifacts;
  const pendingJudgments = value.pendingJudgments === undefined ? derived.pendingJudgments : value.pendingJudgments;
  if (!isCount(pendingArtifacts) || !isCount(pendingJudgments)) return null;
  return {
    ok: value.ok,
    totalArtifacts: value.totalArtifacts,
    passedArtifacts: value.passedArtifacts,
    failedArtifacts: value.failedArtifacts,
    unvalidatedArtifacts: value.unvalidatedArtifacts,
    pendingArtifacts,
    passedExpectations: value.passedExpectations,
    failedExpectations: value.failedExpectations,
    pendingJudgments,
  };
}

function parseLegacySummary(value: unknown, artifacts: TestArtifact[]): TestRunSummary | null {
  if (
    !isRecord(value)
    || typeof value.ok !== "boolean"
    || !isCount(value.totalFrames)
    || !isCount(value.passedFrames)
    || !isCount(value.failedFrames)
    || !isCount(value.unvalidatedFrames)
    || !isCount(value.passedExpectations)
    || !isCount(value.failedExpectations)
  ) return null;
  const pending = pendingCounts(artifacts);
  return {
    ok: value.ok,
    totalArtifacts: value.totalFrames,
    passedArtifacts: value.passedFrames,
    failedArtifacts: value.failedFrames,
    unvalidatedArtifacts: value.unvalidatedFrames,
    pendingArtifacts: pending.pendingArtifacts,
    passedExpectations: value.passedExpectations,
    failedExpectations: value.failedExpectations,
    pendingJudgments: pending.pendingJudgments,
  };
}

function parseRecord(value: unknown, legacy: boolean): TestRunRecord | null {
  if (
    !isRecord(value)
    || typeof value.name !== "string"
    || typeof value.dir !== "string"
    || typeof value.createdAt !== "string"
    || typeof value.closedAt !== "string"
  ) return null;
  const entries = legacy ? value.frames : value.artifacts;
  if (!Array.isArray(entries)) return null;
  const artifacts: TestArtifact[] = [];
  for (const entry of entries) {
    const parsed = parseArtifact(entry);
    if (!parsed) return null;
    artifacts.push(parsed);
  }
  const summary = legacy ? parseLegacySummary(value.summary, artifacts) : parseCurrentSummary(value.summary, artifacts);
  if (!summary) return null;
  const gitSha = typeof value.gitSha === "string" ? value.gitSha : undefined;
  const branch = typeof value.branch === "string" ? value.branch : undefined;
  return {
    name: value.name,
    dir: value.dir,
    createdAt: value.createdAt,
    closedAt: value.closedAt,
    gitSha,
    branch,
    summary,
    artifacts,
  };
}

export function parseTestRunJson(value: unknown): TestRunRecord | null {
  return parseRecord(value, false);
}

export function parseLegacyTestRunJson(value: unknown): TestRunRecord | null {
  return parseRecord(value, true);
}
