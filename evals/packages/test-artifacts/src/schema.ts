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

export type TraceStage = "world" | "body";
export type TraceChannel = "seed" | "seed:raw" | "user" | "agent" | "probe" | "probe:raw" | "vision" | "step";
export type TestOutcome = "passed" | "failed" | "skipped" | "unknown";
export type EvalEngine = "v1" | "v2";

export interface TraceEntry {
  seq: number;
  at: string;
  stage: TraceStage;
  channel: TraceChannel;
  verb: string;
  detail: string;
  surface?: string;
  ok: boolean;
  ms?: number;
  error?: string;
}

export interface StepRecord {
  seq: number;
  name: string;
  depth: number;
  ok: boolean | "not-reached";
  ms?: number;
  error?: string;
}

export interface TestRunRecord {
  name: string;
  dir: string;
  createdAt: string;
  closedAt: string;
  gitSha?: string;
  engine: EvalEngine;
  branch?: string;
  summary: TestRunSummary;
  artifacts: TestArtifact[];
  trace: TraceEntry[];
  steps: StepRecord[];
  outcome: TestOutcome;
  failure?: string;
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

function traceChannel(value: unknown): TraceChannel | null {
  if (value === "seed" || value === "seed:raw" || value === "user" || value === "agent"
    || value === "probe" || value === "probe:raw" || value === "vision" || value === "step") return value;
  return null;
}

function parseTrace(value: unknown): TraceEntry | null {
  if (!isRecord(value) || !isCount(value.seq) || typeof value.at !== "string"
    || (value.stage !== "world" && value.stage !== "body") || typeof value.verb !== "string"
    || typeof value.detail !== "string" || typeof value.ok !== "boolean") return null;
  const channel = traceChannel(value.channel);
  if (!channel) return null;
  if (value.surface !== undefined && typeof value.surface !== "string") return null;
  if (value.ms !== undefined && typeof value.ms !== "number") return null;
  if (value.error !== undefined && typeof value.error !== "string") return null;
  return {
    seq: value.seq,
    at: value.at,
    stage: value.stage,
    channel,
    verb: value.verb,
    detail: value.detail,
    surface: value.surface,
    ok: value.ok,
    ms: value.ms,
    error: value.error,
  };
}

function parseStep(value: unknown): StepRecord | null {
  if (!isRecord(value) || !isCount(value.seq) || typeof value.name !== "string" || !isCount(value.depth)
    || (typeof value.ok !== "boolean" && value.ok !== "not-reached")) return null;
  if (value.ms !== undefined && typeof value.ms !== "number") return null;
  if (value.error !== undefined && typeof value.error !== "string") return null;
  return {
    seq: value.seq,
    name: value.name,
    depth: value.depth,
    ok: value.ok,
    ms: value.ms,
    error: value.error,
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
    if (isRecord(entry) && entry.kind === "json") {
      if (typeof entry.label !== "string" || typeof entry.fileName !== "string") return null;
      continue;
    }
    const parsed = parseArtifact(entry);
    if (!parsed) return null;
    artifacts.push(parsed);
  }
  const summary = legacy ? parseLegacySummary(value.summary, artifacts) : parseCurrentSummary(value.summary, artifacts);
  if (!summary) return null;
  const gitSha = typeof value.gitSha === "string" ? value.gitSha : undefined;
  const engine: EvalEngine | null = value.engine === undefined || value.engine === "v1"
    ? "v1"
    : value.engine === "v2"
      ? "v2"
      : null;
  if (engine === null) return null;
  const branch = typeof value.branch === "string" ? value.branch : undefined;
  const trace: TraceEntry[] = [];
  if (value.trace !== undefined) {
    if (!Array.isArray(value.trace)) return null;
    for (const entry of value.trace) {
      const parsed = parseTrace(entry);
      if (!parsed) return null;
      trace.push(parsed);
    }
  }
  const steps: StepRecord[] = [];
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps)) return null;
    for (const step of value.steps) {
      const parsed = parseStep(step);
      if (!parsed) return null;
      steps.push(parsed);
    }
  }
  const outcome: TestOutcome = value.outcome === "passed" || value.outcome === "failed" || value.outcome === "skipped"
    ? value.outcome
    : "unknown";
  const failure = typeof value.failure === "string" ? value.failure : undefined;
  return {
    name: value.name,
    dir: value.dir,
    createdAt: value.createdAt,
    closedAt: value.closedAt,
    gitSha,
    engine,
    branch,
    summary,
    artifacts,
    trace,
    steps,
    outcome,
    failure,
  };
}

export function parseTestRunJson(value: unknown): TestRunRecord | null {
  return parseRecord(value, false);
}

export function parseLegacyTestRunJson(value: unknown): TestRunRecord | null {
  return parseRecord(value, true);
}
