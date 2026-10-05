import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentTestEvidence } from "@openwork/test-evidence";
import { needs, test } from "@openwork/testkit";
import { expect } from "vitest";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const config = join(repository, ".betterleaks.toml");
const binary = resolve(repository, process.env.BETTERLEAKS_BIN || "tmp/betterleaks");
const awsId = ["AKIA", "Q7N4R2W6T3Y5U2I7"].join("");
const awsSecret = ["q7N4r2W6t3", "Y5u2I7o9P8", "a1S6d4F3g2", "H5j8K9l0Zx"].join("");
const githubToken = ["ghp_", "q7N4r2W6t", "3Y5u2I7o9", "P8a1S6d4F", "3g2H5j8K9"].join("");
const uriPassword = ["q7N4r2", "W6t3Y5u2"].join("");
const credentialUri = `postgresql://scan_user:${uriPassword}@db.scan.invalid:5432/service`;

function run(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Secret scan fixture",
      GIT_AUTHOR_EMAIL: "secret-scan@openwork.invalid",
      GIT_COMMITTER_NAME: "Secret scan fixture",
      GIT_COMMITTER_EMAIL: "secret-scan@openwork.invalid",
      ...extraEnv,
    },
  });
}

function git(cwd: string, args: string[]): string {
  const result = run("git", args, cwd);
  expect(result.error === undefined, "git fixture command must start and finish within its timeout").toBe(true);
  expect(result.status, "git fixture command must succeed").toBe(0);
  return result.stdout.trim();
}

async function withScratch(check: (directory: string) => Promise<void>) {
  needs({ commands: ["git", binary] });
  await access(config);
  const directory = await mkdtemp(join(tmpdir(), "openwork-secret-scan-"));
  try {
    const version = run(binary, ["version"], directory);
    expect(version.status, "Betterleaks version command must succeed").toBe(0);
    expect(version.stdout.trim() === "1.8.1", "use pinned Betterleaks 1.8.1 via BETTERLEAKS_BIN or tmp/betterleaks").toBe(true);
    await check(directory);
    currentTestEvidence()?.recordAssertionEvidence(
      "The named pinned-binary proof completed every observable assertion",
      "Local Betterleaks 1.8.1; explicit exit-code, rule, path, policy or redaction assertions in this test all passed. Reproduce: pnpm evals:pr specs/ci-secret-scan.test.ts. No live validation or historical credential access.",
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function fixtureRepository(directory: string) {
  const repo = join(directory, "source");
  await mkdir(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["commit", "--allow-empty", "-m", "Initialize isolated scan fixture"]);
  return { repo, base: git(repo, ["rev-parse", "HEAD"]) };
}

async function commitFile(repo: string, path: string, content: string) {
  const destination = join(repo, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, { mode: 0o600 });
  git(repo, ["add", "--", path]);
  git(repo, ["commit", "-m", "Add isolated scan fixture"]);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function scan(directory: string, source: string, base: string, head: string, name: string) {
  const bare = join(directory, `${name}.git`);
  git(directory, ["clone", "--bare", "--no-hardlinks", source, bare]);
  const report = join(directory, `${name}.sarif`);
  await writeFile(report, "", { mode: 0o600 });
  const result = run(binary, [
    "git", bare,
    `--config=${config}`,
    "--ignore-gitleaks-allow",
    "--validation=false",
    "--git-workers=0",
    `--log-opts=${base}..${head}`,
    "--redact=100",
    "--log-level=info",
    "--no-color",
    "--exit-code=1",
    "--report-format=sarif",
    `--report-path=${report}`,
  ], directory);
  expect(result.error === undefined, "Betterleaks must start and finish within its timeout").toBe(true);
  return { status: result.status, output: result.stdout + result.stderr, report };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function syntheticFindings(result: Awaited<ReturnType<typeof scan>>, secrets: string[]) {
  const report = await readFile(result.report, "utf8");
  expect(secrets.every((secret) => !report.includes(secret) && !result.output.includes(secret)), "synthetic secrets must be fully redacted in SARIF and logs").toBe(true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(report);
  } catch {
    throw new Error("Betterleaks synthetic report must be valid SARIF JSON; contents withheld");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.runs)) throw new Error("SARIF must contain runs");
  const findings: { ruleId: string; paths: string[] }[] = [];
  for (const run of parsed.runs) {
    if (!isRecord(run) || !Array.isArray(run.results)) throw new Error("SARIF run must contain results");
    for (const finding of run.results) {
      if (!isRecord(finding) || typeof finding.ruleId !== "string" || !Array.isArray(finding.locations)) {
        throw new Error("SARIF finding must contain ruleId and locations");
      }
      const paths: string[] = [];
      for (const location of finding.locations) {
        if (!isRecord(location) || !isRecord(location.physicalLocation)
          || !isRecord(location.physicalLocation.artifactLocation)
          || typeof location.physicalLocation.artifactLocation.uri !== "string") {
          throw new Error("SARIF finding must contain artifact URI");
        }
        paths.push(location.physicalLocation.artifactLocation.uri);
      }
      findings.push({ ruleId: finding.ruleId, paths });
    }
  }
  if (findings.length > 0) {
    expect(report.includes("REDACTED"), "positive synthetic SARIF must contain redaction markers").toBe(true);
  }
  return findings;
}

test("CI secret scan validates the actual Betterleaks configuration", async () => {
  await withScratch(async (directory) => {
    const result = run(binary, ["config", "check", "--config", config], directory);
    expect(result.error === undefined, "config check must start and finish within its timeout").toBe(true);
    expect(result.status, "actual .betterleaks.toml must validate").toBe(0);
  });
});

test("CI secret scan rejects paired AWS credentials and GitHub PATs outside exempt paths", async () => {
  await withScratch(async (directory) => {
    expect(/^AKIA[A-Z2-7]{16}$/.test(awsId) && !awsId.endsWith("EXAMPLE")).toBe(true);
    expect(awsSecret.length).toBe(40);
    expect(/^ghp_[A-Za-z0-9]{36}$/.test(githubToken)).toBe(true);
    const { repo, base } = await fixtureRepository(directory);
    const head = await commitFile(repo, "src/credentials.env", [
      `AWS_ACCESS_KEY_ID=${awsId}`,
      `AWS_SECRET_ACCESS_KEY=${awsSecret}`,
      `GITHUB_TOKEN=${githubToken}`,
      "",
    ].join("\n"));
    const result = await scan(directory, repo, base, head, "provider-credentials");
    expect(result.status, "synthetic provider credentials must fail the CI gate").toBe(1);
    const findings = await syntheticFindings(result, [awsId, awsSecret, githubToken]);
    expect(findings.some((finding) => finding.ruleId === "aws-access-token" && finding.paths.includes("src/credentials.env"))).toBe(true);
    expect(findings.some((finding) => finding.ruleId === "github-pat" && finding.paths.includes("src/credentials.env"))).toBe(true);
  });
});

test("CI secret scan excludes credential URI fixtures only at exempt paths", async () => {
  await withScratch(async (directory) => {
    const { repo, base } = await fixtureRepository(directory);
    const content = `DATABASE_URL=${credentialUri}\n`;
    const exemptHead = await commitFile(repo, "tests/database.env", content);
    const exempt = await scan(directory, repo, base, exemptHead, "exempt-uri");
    expect(exempt.status, "credential URI in tests/ must not fail the CI gate").toBe(0);
    expect((await syntheticFindings(exempt, [uriPassword])).length).toBe(0);
    const head = await commitFile(repo, "src/database.env", content);
    const detected = await scan(directory, repo, base, head, "nonexempt-uri");
    expect(detected.status, "identical credential URI outside tests/ must fail the CI gate").toBe(1);
    const findings = await syntheticFindings(detected, [uriPassword]);
    expect(findings.some((finding) => finding.ruleId === "generic-credential-uri" && finding.paths.includes("src/database.env"))).toBe(true);
    expect(findings.some((finding) => finding.paths.includes("tests/database.env"))).toBe(false);
  });
});

test("CI secret scan keeps the held report path detectable without reading historical content", async () => {
  await withScratch(async (directory) => {
    const { repo, base } = await fixtureRepository(directory);
    const path = "evals/results/first-connection-windows-20260721/report.md";
    const head = await commitFile(repo, path, `DATABASE_URL=${credentialUri}\n`);
    const result = await scan(directory, repo, base, head, "held-path-synthetic-only");
    expect(result.status).toBe(1);
    const findings = await syntheticFindings(result, [uriPassword]);
    expect(findings.some((finding) => finding.ruleId === "generic-credential-uri" && finding.paths.includes(path))).toBe(true);
  });
});

test("CI secret scan limits literal exceptions to exact placeholders and loopback defaults", async () => {
  await withScratch(async (directory) => {
    const { repo, base } = await fixtureRepository(directory);
    for (const password of ["changeme", "example", "YOUR_TOKEN", "YOUR_API_KEY", "YOUR_PASSWORD"]) {
      await commitFile(repo, `src/${password}.env`, `DATABASE_URL=postgresql://scan_user:${password}@db.scan.invalid/service\n`);
    }
    const cleanHead = await commitFile(repo, "src/loopback.env", "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/service\n");
    const clean = await scan(directory, repo, base, cleanHead, "literal-exempt");
    expect(clean.status).toBe(0);
    expect((await syntheticFindings(clean, [])).length).toBe(0);
    const head = await commitFile(repo, "src/real-shaped.env", [
      "DATABASE_URL=postgresql://postgres:postgres@db.scan.invalid/service",
      `DATABASE_URL=postgresql://scan_user:changeme${uriPassword}@db.scan.invalid/service`,
      "",
    ].join("\n"));
    const detected = await scan(directory, repo, cleanHead, head, "literal-boundary");
    expect(detected.status).toBe(1);
    expect((await syntheticFindings(detected, [uriPassword])).filter((finding) => finding.ruleId === "generic-credential-uri").length).toBe(2);
  });
});

test("CI secret scan sanitizes SARIF metadata and context with the exact workflow block", async () => {
  await withScratch(async (directory) => {
    needs({ commands: ["python3"] });
    const workflow = await readFile(join(repository, ".github/workflows/secret-scan.yml"), "utf8");
    const start = workflow.indexOf("          python3 - <<'PY'\n");
    const end = workflow.indexOf("          PY\n", start);
    expect(start >= 0 && end > start).toBe(true);
    const script = workflow.slice(start + "          python3 - <<'PY'\n".length, end)
      .split("\n").map((line) => line.replace(/^          /, "")).join("\n");
    await writeFile(join(directory, "secret-scan.raw.sarif"), JSON.stringify({ runs: [{ results: [{
      ruleId: "github-pat", partialFingerprints: { commitSha: githubToken },
      properties: { commitMessage: githubToken }, message: { text: githubToken },
      locations: [{ physicalLocation: {
        artifactLocation: { uri: "src/synthetic.env" },
        contextRegion: { snippet: { text: githubToken } },
        region: { startLine: 3, snippet: { text: githubToken } },
      } }],
    }] }] }), { mode: 0o600 });
    const result = run("python3", ["-c", script], directory);
    expect(result.status).toBe(0);
    const sanitized = await readFile(join(directory, "secret-scan.sarif"), "utf8");
    expect(sanitized.includes(githubToken)).toBe(false);
    expect(JSON.parse(sanitized)).toEqual({ runs: [{ results: [{
      ruleId: "github-pat", message: { text: "Potential secret detected (redacted)." },
      locations: [{ physicalLocation: {
        artifactLocation: { uri: "src/synthetic.env" },
        region: { startLine: 3, snippet: { text: "REDACTED" } },
      } }],
    }] }] });
  });
});

test("CI secret scan bootstraps once then uses base policy and preserves detached base objects", async () => {
  await withScratch(async (directory) => {
    needs({ commands: ["bash"] });
    const workflow = await readFile(join(repository, ".github/workflows/secret-scan.yml"), "utf8");
    const step = workflow.indexOf("      - name: Prepare trusted policy");
    const start = workflow.indexOf("        run: |\n", step);
    const end = workflow.indexOf("      - name: Scan only", start);
    expect(step >= 0 && start > step && end > start).toBe(true);
    const script = workflow.slice(start + "        run: |\n".length, end)
      .split("\n").map((line) => line.replace(/^          /, "")).join("\n");
    const { repo, base } = await fixtureRepository(directory);
    const policy = await readFile(config, "utf8");
    const installed = await commitFile(repo, ".betterleaks.toml", policy);
    async function prepare(name: string, baseSha: string, headSha: string) {
      const temp = join(directory, name);
      await mkdir(temp);
      const result = run("bash", ["-c", script], repo, { RUNNER_TEMP: temp, BASE_SHA: baseSha, HEAD_SHA: headSha });
      expect(result.status).toBe(0);
      expect(await readFile(join(temp, "secret-scan.toml"), "utf8")).toBe(policy);
      expect(git(join(temp, "secret-scan.git"), ["cat-file", "-t", baseSha])).toBe("commit");
      return result;
    }
    expect((await prepare("bootstrap", base, installed)).stdout.includes("Bootstrapping")).toBe(true);
    const trusted = await commitFile(repo, "trusted.txt", "trusted-base\n");
    git(repo, ["update-ref", "refs/remotes/origin/review-base", trusted]);
    git(repo, ["checkout", "--detach", installed]);
    const head = await commitFile(repo, ".betterleaks.toml", "[extend]\nuseDefault = true\n");
    git(repo, ["branch", "-D", "main"]);
    expect((await prepare("established", trusted, head)).stdout.includes("Bootstrapping")).toBe(false);
  });
});

test("CI secret scan accepts only the bounded origin/dev five-commit range from a bare clone", async () => {
  await withScratch(async (directory) => {
    const head = git(repository, ["rev-parse", "--verify", "origin/dev^{commit}"]);
    const base = git(repository, ["rev-parse", "--verify", `${head}~5^{commit}`]);
    expect(git(repository, ["rev-list", "--count", "--first-parent", `${base}..${head}`])).toBe("5");
    const result = await scan(directory, repository, base, head, "bounded-origin-dev");
    expect(result.status, "bounded origin/dev~5..origin/dev range must be clean; report contents withheld").toBe(0);
  });
});
