export interface RollExpectationResult {
  expectation: string;
  passed: boolean;
  evidence: string;
}

export interface RollFrame {
  caption: string;
  fileName: string;
  hash: string;
  route: string;
  at: string;
  description: string;
  model: string;
  ok: boolean | null;
  results: RollExpectationResult[];
}

export interface RollSummary {
  ok: boolean;
  totalFrames: number;
  passedFrames: number;
  failedFrames: number;
  unvalidatedFrames: number;
  passedExpectations: number;
  failedExpectations: number;
}

export interface PhotoRollRecord {
  name: string;
  dir: string;
  createdAt: string;
  closedAt: string;
  gitSha?: string;
  branch?: string;
  summary: RollSummary;
  frames: RollFrame[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseResult(value: unknown): RollExpectationResult | null {
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

function parseFrame(value: unknown): RollFrame | null {
  if (
    !isRecord(value)
    || typeof value.caption !== "string"
    || typeof value.fileName !== "string"
    || typeof value.hash !== "string"
    || typeof value.route !== "string"
    || typeof value.at !== "string"
    || typeof value.description !== "string"
    || typeof value.model !== "string"
    || (value.ok !== null && typeof value.ok !== "boolean")
    || !Array.isArray(value.results)
  ) return null;
  const results: RollExpectationResult[] = [];
  for (const result of value.results) {
    const parsed = parseResult(result);
    if (!parsed) return null;
    results.push(parsed);
  }
  return {
    caption: value.caption,
    fileName: value.fileName,
    hash: value.hash,
    route: value.route,
    at: value.at,
    description: value.description,
    model: value.model,
    ok: value.ok,
    results,
  };
}

function parseSummary(value: unknown): RollSummary | null {
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
  return {
    ok: value.ok,
    totalFrames: value.totalFrames,
    passedFrames: value.passedFrames,
    failedFrames: value.failedFrames,
    unvalidatedFrames: value.unvalidatedFrames,
    passedExpectations: value.passedExpectations,
    failedExpectations: value.failedExpectations,
  };
}

export function parseRollJson(value: unknown): PhotoRollRecord | null {
  if (
    !isRecord(value)
    || typeof value.name !== "string"
    || typeof value.dir !== "string"
    || typeof value.createdAt !== "string"
    || typeof value.closedAt !== "string"
    || !Array.isArray(value.frames)
  ) return null;
  const summary = parseSummary(value.summary);
  if (!summary) return null;
  const frames: RollFrame[] = [];
  for (const frame of value.frames) {
    const parsed = parseFrame(frame);
    if (!parsed) return null;
    frames.push(parsed);
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
    summary,
    frames,
  };
}
