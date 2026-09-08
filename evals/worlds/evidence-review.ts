import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { assembleReview } from "@openwork/test-artifacts/review";
import { uploadReview } from "@openwork/review/storage";
import type { TestRunRecord } from "@openwork/test-artifacts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Synthetic report inputs exercise the real publisher and production HTTP app. */
export async function reviewWorld() {
  const directory = await mkdtemp(join(tmpdir(), "openwork-review-world-"));
  const storage = join(directory, "reports");
  await mkdir(storage);
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (git.status !== 0)
    throw new Error("Cannot resolve the review fixture commit.");
  const gitSha = git.stdout.trim();
  const png = await readFile(
    join(root, "packages/docs/images/sharing-create-link-dialog.png"),
  );
  const createdAt = new Date().toISOString();
  const records: TestRunRecord[] = [
    "A shared skill can be opened",
    "The owner can revoke a link",
  ].map((name, index) => ({
    name,
    dir: `fixture-${index}`,
    gitSha,
    engine: "v1",
    createdAt,
    closedAt: createdAt,
    outcome: "passed",
    summary: {
      ok: true,
      totalArtifacts: 2,
      passedArtifacts: 1,
      failedArtifacts: 0,
      unvalidatedArtifacts: 1,
      pendingArtifacts: 0,
      passedExpectations: 1,
      failedExpectations: 0,
      pendingJudgments: 0,
    },
    steps: [{ seq: 1, name, depth: 0, ok: true }],
    trace: [
      {
        seq: 1,
        at: createdAt,
        stage: "body",
        channel: "probe",
        verb: "inspect",
        detail: "internal diagnostics fixture",
        ok: true,
      },
    ],
    artifacts: [
      {
        caption: name,
        fileName: "",
        hash: "",
        route: "",
        at: createdAt,
        model: "",
        description: "",
        ok: true,
        results: [
          {
            expectation: name,
            passed: true,
            evidence: "Synthetic assertion used to verify report rendering.",
          },
        ],
        judgments: [
          {
            expectation: name,
            state: "passed",
            reasoning: "Synthetic assertion used to verify report rendering.",
          },
        ],
      },
      ...(index === 0
        ? [
            {
              caption: "Share link dialog · fixture",
              fileName: "dialog.png",
              hash: "",
              route: "",
              at: createdAt,
              model: "",
              description:
                "Existing documentation image, reused as a report fixture.",
              ok: null,
              results: [],
              judgments: [],
            },
          ]
        : []),
    ],
  }));
  const runDirs: string[] = [];
  for (const [index, record] of records.entries()) {
    const path = join(directory, `run-${index}`);
    await mkdir(path);
    await writeFile(join(path, "test-run.json"), JSON.stringify(record));
    await writeFile(join(path, "dialog.png"), png);
    runDirs.push(path);
  }
  const receipt = join(directory, "dialog.png.review.json");
  await writeFile(join(directory, "dialog.png"), png);
  await writeFile(
    receipt,
    JSON.stringify({
      schemaVersion: 1,
      kind: "docshot",
      name: "Documentation reference · fixture",
      fileName: "dialog.png",
      gitSha,
      createdAt,
    }),
  );
  const bundle = await assembleReview({
    testRunDirs: runDirs,
    docShots: [receipt],
    title: "Sharing a skill, from link to access",
  });
  const passed = await uploadReview(bundle.report, bundle.assets, {
    localDir: storage,
  });
  const incompleteReport = structuredClone(bundle.report);
  incompleteReport.gaps.push(
    "Desktop restart remains outside this selected evidence.",
  );
  const skipped = incompleteReport.sources.find(
    (source) => source.kind === "test-run",
  );
  if (skipped?.kind === "test-run") skipped.outcome = "skipped";
  const pending = incompleteReport.evidence.find(
    (item) => item.kind === "image",
  );
  pending?.judgments.push({
    expectation: "Dialog is readable",
    state: "pending",
    reasoning: "Visual judging was deferred.",
  });
  const incomplete = await uploadReview(incompleteReport, bundle.assets, {
    localDir: storage,
  });
  const failedReport = structuredClone(bundle.report);
  const assertion = failedReport.evidence.find(
    (item) => item.kind === "assertion",
  );
  if (!assertion?.judgments[0]) throw new Error("Missing fixture assertion.");
  assertion.judgments[0].state = "failed";
  const failed = await uploadReview(failedReport, bundle.assets, {
    localDir: storage,
  });
  const referenceBundle = await assembleReview({
    testRunDirs: [],
    docShots: [receipt],
  });
  const reference = await uploadReview(
    referenceBundle.report,
    referenceBundle.assets,
    { localDir: storage },
  );
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("Missing review port."));
      server.close(() => resolve(address.port));
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const password = "isolated-review-fixture";
  const child = spawn(
    process.execPath,
    [
      join(root, "apps/review/node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: join(root, "apps/review"),
      env: {
        ...process.env,
        OPENWORK_REVIEW_LOCAL_DIR: storage,
        OPENWORK_REVIEW_PASSWORD: password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stdout.on("data", (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-8000);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-8000);
  });
  async function dispose() {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(kill);
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      const response = await fetch(baseUrl, {
        signal: AbortSignal.timeout(1000),
      }).catch(() => null);
      if (response?.status === 401) break;
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error(
          `Review app did not start. Run its build first.\n${logs}`,
        );
      await delay(100);
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    baseUrl,
    headers: {
      authorization: `Basic ${Buffer.from(`review:${password}`).toString("base64")}`,
    },
    passed,
    incomplete,
    failed,
    reference,
    report: bundle.report,
    directory,
    [Symbol.asyncDispose]: dispose,
  };
}
