import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { uploadReview } from "@openwork/review/storage";
import type { ReviewReport } from "@openwork/review";
import { setViewport } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import { chrome, localHost } from "@openwork/hosts";
import { prepareReviewBuild } from "./review-build.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** A free loopback port for the production review app. */
async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing review port."));
      server.close(() => resolve(address.port));
    });
  });
}

/**
 * Synthetic report inputs only: documentation images stand in for screenshots,
 * and no test here claims to have exercised the behaviors named in the report.
 */
async function syntheticReports(storage: string) {
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (git.status !== 0) throw new Error("Cannot resolve the review fixture commit.");
  const gitSha = git.stdout.trim();
  const createdAt = new Date().toISOString();
  const assets = new Map<string, Uint8Array>();
  async function image(file: string) {
    const body = await readFile(join(root, "packages/docs/images", file));
    const name = `${createHash("sha256").update(body).digest("hex")}.png`;
    assets.set(name, body);
    return name;
  }
  const record = (id: string) => {
    const name = `${id}.json`;
    assets.set(name, new TextEncoder().encode(JSON.stringify({ fixture: "synthetic review proof input" })));
    return name;
  };
  const selector = await image("chatgpt-model-selector.png");
  const settings = await image("chatgpt-connect-provider-settings.png");
  const key = await image("anthropic-key.png");
  const pass = (expectation: string) => ({ expectation, state: "passed" as const, reasoning: "Synthetic assertion used to render the report." });
  function report(failing: boolean): ReviewReport {
    return {
      schemaVersion: 1, title: "Connecting a model provider from settings", gitSha, createdAt, gaps: [],
      sources: [
        { kind: "test-run", id: "connect-run", name: "A member connects a provider", gitSha, createdAt, asset: record("connect-run"), outcome: "passed" },
        { kind: "test-run", id: "picker-run", name: "The new models appear in the picker", gitSha, createdAt, asset: record("picker-run"), outcome: failing ? "failed" : "passed",
          ...(failing ? { failure: "Expected the provider's models in the picker; none were listed." } : {}) },
        { kind: "docshot", id: "key-doc", name: "Provider key reference", gitSha, createdAt, asset: record("key-doc") },
      ],
      sections: [
        { id: "connect-run", title: "A member connects a provider", sourceId: "connect-run", evidenceIds: ["connect-checks", "connect-shot"] },
        { id: "picker-run", title: "The new models appear in the picker", sourceId: "picker-run", evidenceIds: ["picker-checks", "picker-shot"] },
        { id: "key-doc", title: "Provider key reference", sourceId: "key-doc", evidenceIds: ["key-shot"] },
      ],
      evidence: [
        { kind: "assertion", id: "connect-checks", sourceId: "connect-run", caption: "Connect checks", judgments: [pass("The provider shows as connected")] },
        { kind: "image", id: "connect-shot", sourceId: "connect-run", caption: "Provider settings after connecting", asset: settings, description: "Documentation image reused as a report fixture.", judgments: [] },
        { kind: "assertion", id: "picker-checks", sourceId: "picker-run", caption: "Picker checks", judgments: [
          failing ? { expectation: "The provider's models are listed", state: "failed", reasoning: "Synthetic failure used to render the report." } : pass("The provider's models are listed"),
        ] },
        { kind: "image", id: "picker-shot", sourceId: "picker-run", caption: "Model picker with the new provider", asset: selector, description: "Documentation image reused as a report fixture.", judgments: [] },
        { kind: "image", id: "key-shot", sourceId: "key-doc", caption: "Provider key reference", asset: key, description: "Documentation reference, not a test result.", judgments: [] },
      ],
    };
  }
  const upload = (value: ReviewReport) => uploadReview(value, [...assets].map(([name, body]) => ({ name, body })), { localDir: storage });
  return { failed: await upload(report(true)), passed: await upload(report(false)) };
}

/** The production review app on loopback with isolated local storage and no sandbox provider access. */
export async function reviewReportWorld(_seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new Error("The review app fixture requires --local; it never provisions a VM.");
  prepareReviewBuild();
  const resources = new AsyncDisposableStack();
  try {
    const directory = await mkdtemp(join(tmpdir(), "openwork-review-report-"));
    resources.defer(() => rm(directory, { recursive: true, force: true }));
    const storage = join(directory, "reports");
    await mkdir(storage);
    const reports = await syntheticReports(storage);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [join(root, "apps/review/node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: join(root, "apps/review"),
      // This isolated HTTP fixture must never inherit live sandbox access.
      env: { ...process.env, FREESTYLE_API_KEY: "", DAYTONA_API_KEY: "", OPENWORK_REVIEW_LOCAL_DIR: storage, VERCEL: "1", VERCEL_ENV: "preview" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    const keep = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-8000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    resources.defer(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(kill);
    });
    const deadline = Date.now() + 30_000;
    while (true) {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1000) }).catch(() => null);
      if (response?.status === 200) break;
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Review app did not start. Run its build first.\n${logs}`);
      await delay(100);
    }
    const host = resources.use(localHost());
    const web = resources.use(await chrome({ name: "review-report", host, startUrl: `${baseUrl}/r/${reports.failed}`, headless: true }));
    await setViewport(web, { width: 1440, height: 1000, deviceScaleFactor: 1 });
    return {
      web,
      baseUrl,
      ...reports,
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}
