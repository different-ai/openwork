import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { browserScript, captureScreenshot, evaluate, navigate, setViewport, type Surface } from "@openwork/cdp";
import {
  collectLayout,
  LAYOUT_BOX_LIMIT,
  layoutFileName,
  parseLayoutSnapshot,
  reviewTestRunDesign,
  type DesignReviewFile,
} from "@openwork/design-review";
import type { Place, Seed } from "@openwork/env";
import { uploadReview } from "@openwork/review/storage";
import type { TestRunRecord } from "@openwork/test-artifacts";
import { assembleReview } from "@openwork/test-artifacts/review";
import { reviewBrowserWorld } from "./evidence-review.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

const rows = [
  ["docs-helper", "Connector", "Local", "Local (runs on this device)"],
  ["files-helper", "Connector", "Local", "Local (runs on this device)"],
  ["brand-voice", "Skill", "Local", "Tone, words we use and words we avoid in anything customer-facing."],
  ["release-notes", "Skill", "Local", "Turns merged pull requests into short customer-facing release notes."],
  ["weekly-update", "Skill", "Local", "Drafts the Friday team update from this week's sessions."],
] as const;

/**
 * A Library-like list at 1920 wide. "apart" is the layout that shipped by
 * mistake: what it does in the middle, Kind and From pushed to the far edge.
 * "together" keeps the short values next to the name and lets the
 * description take the rest of the row.
 */
function libraryPage(layout: "apart" | "together"): string {
  const cell = (text: string, style: string) => `<span style="${style}">${text}</span>`;
  const row = ([name, kind, from, description]: readonly string[]) => layout === "apart"
    ? `<div class="row" data-library-row="${name ?? ""}"><i></i>${cell(name ?? "", "width:190px;font-weight:500")}${cell(description ?? "", "flex:1")}${cell(kind ?? "", "width:104px;color:#60646c")}${cell(from ?? "", "width:200px;color:#60646c")}</div>`
    : `<div class="row" data-library-row="${name ?? ""}"><i></i>${cell(name ?? "", "width:220px;font-weight:500")}${cell(kind ?? "", "width:84px;color:#60646c")}${cell(from ?? "", "width:160px;color:#60646c")}${cell(description ?? "", "flex:1;color:#60646c")}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:13px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1c2024;background:#fff}
main{padding:32px 40px}h1{font-size:16px;margin:0 0 20px;font-weight:600}
.row{display:flex;align-items:center;gap:12px;height:52px;border-bottom:1px solid #e8e8ec}
.row i{width:32px;height:32px;border-radius:8px;background:#f0f0f3;flex-shrink:0}
</style></head><body><main><h1>Library</h1>${rows.map(row).join("")}</main></body></html>`;
}

async function show(app: Surface, html: string): Promise<void> {
  await navigate(app.client, `data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = await evaluate(app.client, () => document.readyState === "complete" && document.querySelectorAll(".row").length > 0).catch(() => false);
    if (ready) return;
    await delay(100);
  }
  throw new Error("The design review fixture page did not render.");
}

/** One fixture run the way `screenshot()` stores it: PNG, layout beside it, and the record. */
async function captureRun(app: Surface, dir: string, title: string, gitSha: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const png = await captureScreenshot(app.client);
  const layout = parseLayoutSnapshot(await evaluate(app.client, browserScript(collectLayout, [LAYOUT_BOX_LIMIT])));
  if (!layout) throw new Error("The fixture page did not report its layout.");
  const fileName = "01-library.png";
  await writeFile(join(dir, fileName), png);
  await writeFile(join(dir, layoutFileName(fileName)), `${JSON.stringify(layout)}\n`);
  const at = new Date().toISOString();
  const record: TestRunRecord = {
    name: title,
    dir,
    gitSha,
    engine: "v1",
    createdAt: at,
    closedAt: at,
    outcome: "passed",
    summary: { ok: true, totalArtifacts: 2, passedArtifacts: 1, failedArtifacts: 0, unvalidatedArtifacts: 1, pendingArtifacts: 0, passedExpectations: 1, failedExpectations: 0, pendingJudgments: 0 },
    steps: [{ seq: 1, name: title, depth: 0, ok: true }],
    trace: [],
    artifacts: [
      {
        caption: title, fileName, hash: createHash("sha256").update(png).digest("hex"), route: "", at,
        model: "", description: "", ok: null, results: [], judgments: [],
      },
      {
        caption: "the fixture list rendered", fileName: "", hash: "", route: "", at, model: "",
        description: `${rows.length} rows at 1920×1080`, ok: true,
        results: [{ expectation: "the fixture list rendered", passed: true, evidence: `${rows.length} rows at 1920×1080` }],
        judgments: [{ expectation: "the fixture list rendered", state: "passed", reasoning: `${rows.length} rows at 1920×1080` }],
      },
    ],
  };
  await writeFile(join(dir, "test-run.json"), JSON.stringify(record));
}

/**
 * The chain a PR goes through, for real: a screen is captured with its
 * layout, the design review runs its measured rules on it (no model key in
 * the proof lane), and the report is published to an isolated production
 * review app that a reviewer then opens.
 */
export async function designReviewWorld(seed: Seed, context: { place: Place }) {
  const world = await reviewBrowserWorld(seed, context);
  try {
    const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    if (git.status !== 0) throw new Error("Cannot resolve the design review fixture commit.");
    const gitSha = git.stdout.trim();
    const runs = await mkdtemp(join(tmpdir(), "openwork-design-review-"));
    const captured: { title: string; dir: string; review: DesignReviewFile }[] = [];
    await setViewport(world.app, { width: 1920, height: 1080, deviceScaleFactor: 1 });
    for (const [layout, title] of [
      ["apart", "Library on a wide window, values far from their names"],
      ["together", "Library on a wide window, values next to their names"],
    ] as const) {
      const dir = join(runs, layout);
      await show(world.app, libraryPage(layout));
      await captureRun(world.app, dir, title, gitSha);
      captured.push({ title, dir, review: await reviewTestRunDesign(dir) });
    }
    const bundle = await assembleReview({ testRunDirs: captured.map((entry) => entry.dir), title: "Design review of two Library layouts" });
    const report = await uploadReview(bundle.report, bundle.assets, { localDir: join(world.directory, "reports") });
    await setViewport(world.app, { width: 1440, height: 1000, deviceScaleFactor: 1 });
    await navigate(world.app.client, "about:blank");
    return { ...world, designReport: report, captured };
  } catch (error) {
    await world[Symbol.asyncDispose]();
    throw error;
  }
}
