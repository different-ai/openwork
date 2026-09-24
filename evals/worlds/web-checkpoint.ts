import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { allocateFreePort, setViewport } from "@openwork/cdp";
import { chrome, localHost } from "@openwork/hosts";
import { freestyleEvidenceWeb, attachEvidenceBrowser } from "@openwork/env";
import { registerScreenshotCheckpoint } from "@openwork/test-evidence";
import type { ScreenshotArtifact } from "@openwork/test-evidence";
import { uploadReview } from "@openwork/review/storage";
import type { ReviewReport } from "@openwork/review";
import { client } from "../../packages/freestyle/src/index.ts";
import { deleteEvidenceVm, FORK_KIND, readEvidenceSession, continueEvidenceStream } from "../../packages/freestyle/src/checkpoints.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

export async function checkpointWorld() {
  if (process.env.OPENWORK_EVIDENCE_CHECKPOINTS !== "1") throw new Error("Opt in with OPENWORK_EVIDENCE_CHECKPOINTS=1");
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (process.env.OPENWORK_EVIDENCE_SOURCE_SHA && process.env.OPENWORK_EVIDENCE_SOURCE_SHA !== sourceSha) throw new Error("Evidence source must equal the runner checkout");
  const resources = new AsyncDisposableStack();
  const temporary = await mkdtemp(join(tmpdir(), "openwork-web-checkpoint-"));
  resources.defer(() => rm(temporary, { recursive: true, force: true }));
  try {
    const world = resources.use(await freestyleEvidenceWeb(sourceSha));
    resources.defer(registerScreenshotCheckpoint(world.app, world.capture));
    const host = resources.use(localHost());
    const reviewer = resources.use(await chrome({ host, name: "checkpoint-reviewer", headless: true }));
    await setViewport(reviewer, { width: 1440, height: 1000, deviceScaleFactor: 1 });
    const viewer = resources.use(await chrome({ host, name: "checkpoint-viewer", headless: true }));
    await setViewport(viewer, { width: 1440, height: 1000, deviceScaleFactor: 1 });
    const storage = join(temporary, "reports");
    await mkdir(storage);
    const port = await allocateFreePort();
    const reviewUrl = `http://127.0.0.1:${port}`;
    const processHandle = spawn(process.execPath, [join(root, "apps/review/node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: join(root, "apps/review"), stdio: "ignore",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "preview",
        OPENWORK_REVIEW_LOCAL_DIR: storage, FREESTYLE_API_KEY: process.env.FREESTYLE_API_KEY },
    });
    resources.defer(async () => {
      if (processHandle.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => processHandle.kill("SIGKILL"), 5000);
        processHandle.once("exit", () => { clearTimeout(timer); resolve(); }); processHandle.kill("SIGTERM");
      });
    });
    const deadline = Date.now() + 30_000;
    while (true) {
      if (await fetch(reviewUrl).then((r) => r.ok).catch(() => false)) break;
      if (Date.now() > deadline || processHandle.exitCode !== null) throw new Error("Build the branch review app before running its checkpoint proof");
      await delay(250);
    }
    return {
      ...world, reviewer, viewer, reviewUrl, sourceSha,
      async publish(shot: ScreenshotArtifact, caption: string) {
        if (!shot.checkpoint) throw new Error("No checkpoint was captured");
        const image = `${shot.hash}.png`;
        // This temporary report is a live reference, not fabricated passing test
        // evidence. The real testkit record is published only after the test ends.
        const report: ReviewReport = {
          schemaVersion: 1, title: "Web checkpoint reference", gitSha: sourceSha, createdAt: shot.at, gaps: [],
          sources: [{ kind: "docshot", id: "capture", name: caption, gitSha: sourceSha, createdAt: shot.at, asset: "capture.json" }],
          sections: [{ id: "capture", sourceId: "capture", title: caption, evidenceIds: ["image"] }],
          evidence: [{ id: "image", sourceId: "capture", kind: "image", asset: image, caption, description: "", judgments: [], checkpoint: shot.checkpoint }],
        };
        const id = await uploadReview(report, [{ name: image, body: shot.png }, { name: "capture.json", body: Buffer.from(JSON.stringify({ capturedAt: shot.at, sourceSha, imageHash: shot.hash })) }], { localDir: storage });
        return { id, url: `${reviewUrl}/r/${id}` };
      },
      async openedFork(reportId: string) {
        const api = client();
        const found = await api.vms.list({ metadata: `kind:${FORK_KIND},reportId:${reportId}`, limit: 3 });
        if (found.vms.length !== 1) throw new Error("Expected one private fork from the review action");
        const vm = found.vms[0];
        resources.defer(() => deleteEvidenceVm(vm.id));
        const session = await readEvidenceSession(vm.id, sourceSha, api);
        const app = resources.use(await attachEvidenceBrowser(session));
        return { app, viewerUrl: session.url, continueStream: () => continueEvidenceStream(vm.id), id: vm.id,
          async streamState() {
            const response = await fetch(new URL("/__evidence/state", session.url), { headers: { cookie: session.cookie }, signal: AbortSignal.timeout(10_000) });
            if (!response.ok) throw new Error("Fork stream witness unavailable");
            return response.json();
          },
        };
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
