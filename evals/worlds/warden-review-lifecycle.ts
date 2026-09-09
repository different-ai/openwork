import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  startMockWardenGithub,
  type MockWardenGithubComment,
  type MockWardenGithubRequest,
  type MockWardenGithubRun,
  type MockWardenGithubThread,
} from "@openwork/labs";

const REPOSITORY = "openworklabs/openwork";
const OTHER_REPOSITORY = "fixture/not-openwork";
const PULL_REQUEST = 42;
const BASE_SHA = "b".repeat(40);
const SUMMARY_MARKER = "<!-- openwork:warden-review-summary:v1 -->";
const PRIVATE_MARKER = "PRIVATE-WARDEN-FIXTURE-MARKER";
const repoRoot = resolve(import.meta.dirname, "../..");
const cliPath = join(repoRoot, ".github", "scripts", "warden-review.mjs");

export type WardenFixture =
  | "advisory"
  | "mixed"
  | "missing-trigger"
  | "partial"
  | "malformed"
  | "repository-mismatch"
  | "wrong-repository";

export interface WardenIdentity {
  repository: string;
  pr: number;
  headSha: string;
  baseSha: string;
  runId: string;
  attempt: number;
}

export interface WardenCliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

export interface PreparedWardenReceipt {
  key: string;
  identity: WardenIdentity;
  result: WardenCliResult;
  receipt: Record<string, unknown> | null;
}

interface NativeFinding {
  id: string;
  severity: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  title: string;
  description: string;
  location: { path: string; startLine: number };
}

interface NativeSkill {
  name: string;
  summary: string;
  durationMs: number;
  findings: NativeFinding[];
  failedHunks?: number;
  failedExtractions?: number;
  error?: { code: string; message: string; timestamp: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedLastLine(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function finding(id: string, severity: NativeFinding["severity"], confidence: NativeFinding["confidence"]): NativeFinding {
  return {
    id,
    severity,
    confidence,
    title: `${PRIVATE_MARKER} title`,
    description: `${PRIVATE_MARKER} description`,
    location: { path: "src/fixture.ts", startLine: 1 },
  };
}

function skill(name: string, findings: NativeFinding[] = [], partial: Partial<Pick<NativeSkill, "failedHunks" | "failedExtractions" | "error">> = {}): NativeSkill {
  return {
    name,
    summary: `${PRIVATE_MARKER} model summary`,
    durationMs: 5,
    findings,
    ...partial,
  };
}

function nativeRaw(
  fixture: Exclude<WardenFixture, "malformed" | "repository-mismatch" | "wrong-repository">,
  identity: WardenIdentity,
  rawRepository: string,
): Record<string, unknown> {
  let skills: NativeSkill[];
  if (fixture === "advisory") {
    skills = [
      skill("diff-security-review"),
      skill("confidentiality-review"),
      skill("desktop-den-sync-review", [finding("SYNC-ADVISORY", "medium", "medium")]),
      skill("spec-provenance-review", [finding("PROV-ADVISORY", "medium", "medium")]),
    ];
  } else if (fixture === "mixed") {
    skills = [
      skill("diff-security-review", [finding("SEC-LOW", "low", "low")]),
      skill("confidentiality-review", [finding("CONF-MED", "medium", "low")]),
      skill("desktop-den-sync-review", [finding("SYNC-HIGH", "high", "low")]),
    ];
  } else if (fixture === "partial") {
    skills = [
      skill("diff-security-review", [], {
        failedHunks: 1,
        error: {
          code: "fixture-partial",
          message: `${PRIVATE_MARKER} partial error`,
          timestamp: "2026-09-09T12:00:00.000Z",
        },
      }),
      skill("confidentiality-review", [], { failedExtractions: 1 }),
    ];
  } else {
    skills = [skill("diff-security-review"), skill("confidentiality-review")];
  }

  const findings = skills.flatMap((entry) => entry.findings);
  const [owner, name] = rawRepository.split("/");
  const triggerResults = skills.map((entry) => ({
    triggerName: "local-reference-name",
    skillName: entry.name,
    status: "success",
    report: {
      skill: entry.name,
      summary: entry.summary,
      durationMs: 5,
      findings: entry.findings,
    },
  }));
  if (fixture === "missing-trigger") triggerResults.splice(1, 1);

  return {
    version: "1",
    timestamp: "2026-09-09T12:00:00.000Z",
    repository: { owner, name, fullName: rawRepository },
    event: "pull_request",
    pullRequest: {
      number: identity.pr,
      author: `${PRIVATE_MARKER}-author`,
      title: `${PRIVATE_MARKER} pull request`,
      baseBranch: "dev",
      headBranch: `${PRIVATE_MARKER}-branch`,
      headSha: identity.headSha,
    },
    runId: identity.runId,
    summary: {
      totalFindings: findings.length,
      totalSkills: skills.length,
      findingsBySeverity: {
        high: findings.filter((entry) => entry.severity === "high").length,
        medium: findings.filter((entry) => entry.severity === "medium").length,
        low: findings.filter((entry) => entry.severity === "low").length,
      },
    },
    skills,
    triggerResults,
    findingObservations: [],
  };
}

function nativeFixture(fixture: WardenFixture, identity: WardenIdentity): unknown {
  if (fixture === "malformed") return { version: "1", private: PRIVATE_MARKER };
  const rawRepository = fixture === "repository-mismatch" ? REPOSITORY : identity.repository;
  const rawFixture = fixture === "repository-mismatch" || fixture === "wrong-repository" ? "advisory" : fixture;
  return nativeRaw(rawFixture, identity, rawRepository);
}

function cloneThread(thread: MockWardenGithubThread): MockWardenGithubThread {
  return { ...thread, author: { ...thread.author } };
}

export async function wardenReviewLifecycle() {
  const directory = await mkdtemp(join(tmpdir(), "openwork-warden-review-"));
  const home = join(directory, "home");
  const scratch = join(directory, "scratch");
  await mkdir(home, { recursive: true });
  await mkdir(scratch, { recursive: true });

  const initialThreads: MockWardenGithubThread[] = [
    {
      id: "RT_initial_resolved",
      isResolved: true,
      body: "<!-- warden:finding:v1:INITIAL -->",
      author: { login: "github-actions", type: "Bot" },
    },
    {
      id: "RT_toggle",
      isResolved: false,
      body: "<!-- warden:finding:v1:TOGGLE -->",
      author: { login: "github-actions", type: "Bot" },
    },
    {
      id: "RT_human_clearance",
      isResolved: false,
      body: "<!-- warden:finding:v1:HUMAN --> Clearance granted by a person",
      author: { login: "github-actions", type: "User" },
    },
  ];
  const initialComments: MockWardenGithubComment[] = Array.from({ length: 99 }, (_unused, index) => ({
    id: index + 1,
    body: `ordinary fixture comment ${index + 1}`,
    user: { login: "fixture-human", type: "User" },
  }));
  initialComments.push({
    id: 100,
    body: `${SUMMARY_MARKER}\nspoofed summary must remain human-owned`,
    user: { login: "fixture-human", type: "User" },
  });

  const witness = await startMockWardenGithub({
    token: "test-token",
    repository: REPOSITORY,
    pullRequest: PULL_REQUEST,
    headSha: "a".repeat(40),
    baseSha: BASE_SHA,
    headBranch: "fixture-branch",
    baseBranch: "dev",
    comments: initialComments,
    threads: initialThreads,
  });
  const children = new Set<ChildProcess>();
  let sequence = 0;
  const baseEnv: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TMPDIR: scratch,
    PATH: process.env.PATH ?? "",
    LANG: "C.UTF-8",
  };

  const runCli = (args: string[], env: NodeJS.ProcessEnv): Promise<WardenCliResult> => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      children.delete(child);
      reject(new Error(`Warden CLI timed out.\n${stderr.slice(-2_000)}`));
    }, 20_000);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      resolveRun({ code: code ?? 1, stdout, stderr, json: parsedLastLine(stdout) });
    });
  });

  const dispose = async (): Promise<void> => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
    await witness.stop();
    await rm(directory, { recursive: true, force: true });
  };

  try {
    return {
      repository: REPOSITORY,
      pullRequest: PULL_REQUEST,
      baseSha: BASE_SHA,
      privateMarker: PRIVATE_MARKER,
      heads: {
        first: "a".repeat(40),
        second: "c".repeat(40),
        stale: "d".repeat(40),
        forged: "e".repeat(40),
      },
      async prepare(
        fixture: WardenFixture,
        overrides: Partial<Pick<WardenIdentity, "headSha" | "baseSha" | "runId" | "attempt">> = {},
      ): Promise<PreparedWardenReceipt> {
        sequence += 1;
        const repository = fixture === "repository-mismatch" || fixture === "wrong-repository"
          ? OTHER_REPOSITORY
          : REPOSITORY;
        const identity: WardenIdentity = {
          repository,
          pr: PULL_REQUEST,
          headSha: overrides.headSha ?? "a".repeat(40),
          baseSha: overrides.baseSha ?? BASE_SHA,
          runId: overrides.runId ?? "123456",
          attempt: overrides.attempt ?? 1,
        };
        const key = `receipt-${sequence}`;
        const findingsPath = join(scratch, `${key}-raw.json`);
        const receiptPath = join(scratch, `${key}.json`);
        await writeFile(findingsPath, `${JSON.stringify(nativeFixture(fixture, identity), null, 2)}\n`, "utf8");
        const result = await runCli([
          "prepare",
          "--findings", findingsPath,
          "--repository", identity.repository,
          "--pr", String(identity.pr),
          "--head", identity.headSha,
          "--base", identity.baseSha,
          "--run-id", identity.runId,
          "--attempt", String(identity.attempt),
          "--output", receiptPath,
        ], baseEnv);
        let receipt: Record<string, unknown> | null = null;
        if (result.code === 0) {
          const parsed: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
          receipt = isObject(parsed) ? parsed : null;
        }
        return { key: receiptPath, identity, result, receipt };
      },
      publish(prepared: PreparedWardenReceipt, token = "test-token"): Promise<WardenCliResult> {
        return runCli(["publish", "--receipt", prepared.key], {
          ...baseEnv,
          GITHUB_TOKEN: token,
          GITHUB_API_URL: witness.apiUrl,
          GITHUB_GRAPHQL_URL: witness.graphqlUrl,
          GITHUB_SERVER_URL: "https://github.example.invalid",
          WARDEN_EXPECTED_REPOSITORY: prepared.identity.repository,
          WARDEN_EXPECTED_RUN_ID: prepared.identity.runId,
          WARDEN_EXPECTED_RUN_ATTEMPT: String(prepared.identity.attempt),
          WARDEN_EXPECTED_HEAD_SHA: prepared.identity.headSha,
        });
      },
      async forgeReceiptProducer(
        prepared: PreparedWardenReceipt,
        producer: Pick<WardenIdentity, "headSha" | "runId">,
      ): Promise<PreparedWardenReceipt> {
        const parsed: unknown = JSON.parse(await readFile(prepared.key, "utf8"));
        if (!isObject(parsed) || !isObject(parsed.producer)) {
          throw new Error("Cannot forge a receipt without a producer.");
        }
        sequence += 1;
        const receipt = {
          ...parsed,
          head_sha: producer.headSha,
          producer: {
            ...parsed.producer,
            headSha: producer.headSha,
            runId: producer.runId,
          },
        };
        const key = join(scratch, `receipt-${sequence}-forged.json`);
        await writeFile(key, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
        return {
          key,
          identity: { ...prepared.identity },
          result: prepared.result,
          receipt,
        };
      },
      seedRun(prepared: PreparedWardenReceipt, runNumber: number, overrides: Partial<Omit<MockWardenGithubRun, "id" | "runNumber" | "attempt" | "headSha">> = {}): void {
        witness.seedRun({
          id: prepared.identity.runId,
          runNumber,
          attempt: prepared.identity.attempt,
          headSha: prepared.identity.headSha,
          ...overrides,
        });
      },
      setPullHead(headSha: string): void {
        witness.setPullHead(headSha);
      },
      resolveToggleThread(): void {
        witness.seedThreads(initialThreads.map((thread) => ({
          ...cloneThread(thread),
          isResolved: thread.id === "RT_toggle" ? true : thread.isResolved,
        })));
      },
      seedPaginatedThreads(): { warden: number; total: number } {
        const additional: MockWardenGithubThread[] = Array.from({ length: 99 }, (_unused, index) => ({
          id: `RT_page_${String(index + 1).padStart(3, "0")}`,
          isResolved: false,
          body: `<!-- warden:finding:v1:PAGE_${String(index + 1).padStart(3, "0")} -->`,
          author: { login: "github-actions", type: "Bot" },
        }));
        const human = initialThreads[2];
        if (!human) throw new Error("Missing human review-thread fixture.");
        const paginated: MockWardenGithubThread[] = [
          ...initialThreads.slice(0, 2).map((thread) => ({ ...cloneThread(thread), isResolved: true })),
          ...additional,
          cloneThread(human),
        ];
        witness.seedThreads(paginated);
        return { warden: 101, total: paginated.length };
      },
      changeHeadAfterGraphql(headSha: string): void {
        witness.changeHeadAfterGraphql(headSha);
      },
      setGraphqlErrors(enabled: boolean): void {
        witness.setGraphqlErrors(enabled);
      },
      comments: witness.comments,
      requests: witness.requests,
      writes(): MockWardenGithubRequest[] {
        return witness.requests().filter((request) =>
          request.method === "PATCH" ||
          request.method === "POST" && request.path === `/repos/openworklabs/openwork/issues/${PULL_REQUEST}/comments`,
        );
      },
      reviewMutations(): MockWardenGithubRequest[] {
        return witness.requests().filter((request) =>
          request.path.includes("/reviews") || request.path.includes("/dismissals") ||
          request.path === "/graphql" && /\bmutation\b/.test(request.body),
        );
      },
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
