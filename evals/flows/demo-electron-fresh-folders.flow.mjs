import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDemoRun, resolveDemoRoot } from "../../scripts/dev-two-electron-demo.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "demo-electron-fresh-folders";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAUNCHER_PATH = path.join(ROOT, "scripts", "dev-two-electron-demo.mjs");
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const exists = (filePath) => access(filePath).then(() => true, () => false);

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, `${assertion}${actual ? ` (actual: ${actual})` : ""}`);
}

export default {
  id: FLOW_ID,
  title: "demo:electron launches two independent demos with fresh folders",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "One command launches both demo profiles",
      run: async (ctx) => {
        await ctx.prove("demo:electron starts Demo A and Demo B together", {
          voiceover: vo[0],
          assert: async () => {
            const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
            const launcher = await readFile(LAUNCHER_PATH, "utf8");
            const testRun = spawnSync(process.execPath, ["--test", "scripts/dev-two-electron-demo.test.mjs"], {
              cwd: ROOT,
              encoding: "utf8",
            });
            witness(ctx, packageJson.scripts["demo:electron"].includes("dev-two-electron-demo.mjs"), "demo:electron invokes the two-demo launcher");
            witness(ctx, /startElectron\(\s*appProfiles\.admin\.label/.test(launcher), "the launcher starts Demo A");
            witness(ctx, /startElectron\(\s*appProfiles\.consumer\.label/.test(launcher), "the launcher starts Demo B");
            witness(ctx, testRun.status === 0, "the focused launcher tests pass", testRun.stderr.trim() || String(testRun.status));
            ctx.output("$ node --test scripts/dev-two-electron-demo.test.mjs", testRun.stdout.trim());
          },
        });
      },
    },
    {
      name: "The two profiles use separate non-production folders",
      run: async (ctx) => {
        const testRoot = await mkdtemp(path.join(os.tmpdir(), "fraimz-electron-demo-"));
        try {
          await ctx.prove("each demo gets an independent folder under the temporary demo root", {
            voiceover: vo[1],
            action: async () => {},
            assert: async () => {
              const run = await createDemoRun(testRoot);
              const productionRoot = path.join(os.homedir(), ".openwork");
              witness(ctx, run.admin.root !== run.consumer.root, "Demo A and Demo B folders differ");
              witness(ctx, !run.admin.root.startsWith(productionRoot), "Demo A does not use the production .openwork folder", run.admin.root);
              witness(ctx, !run.consumer.root.startsWith(productionRoot), "Demo B does not use the production .openwork folder", run.consumer.root);
              witness(ctx, await exists(run.admin.userDataDir), "Demo A Electron data folder exists");
              witness(ctx, await exists(run.consumer.userDataDir), "Demo B Electron data folder exists");
              ctx.output("Created demo folders", `Demo A: ${run.admin.root}\nDemo B: ${run.consumer.root}`);
            },
          });
        } finally {
          await rm(testRoot, { recursive: true, force: true });
        }
      },
    },
    {
      name: "The launcher reports both isolated paths",
      run: async (ctx) => {
        await ctx.prove("terminal output labels the folder for each demo", {
          voiceover: vo[2],
          assert: async () => {
            const launcher = await readFile(LAUNCHER_PATH, "utf8");
            witness(ctx, launcher.includes("Demo A folder:"), "terminal output includes the Demo A folder label");
            witness(ctx, launcher.includes("Demo B folder:"), "terminal output includes the Demo B folder label");
            witness(ctx, launcher.includes("demoRun.admin.root"), "the Demo A label prints its actual generated path");
            witness(ctx, launcher.includes("demoRun.consumer.root"), "the Demo B label prints its actual generated path");
            ctx.output("Launcher output contract", "Demo A folder: <fresh path>\nDemo B folder: <fresh path>");
          },
        });
      },
    },
    {
      name: "Every launch starts clean",
      run: async (ctx) => {
        const testRoot = await mkdtemp(path.join(os.tmpdir(), "fraimz-electron-rerun-"));
        try {
          await ctx.prove("a rerun creates new folders with no state inherited from the prior run", {
            voiceover: vo[3],
            action: async () => {},
            assert: async () => {
              const first = await createDemoRun(testRoot);
              const markerPath = path.join(first.admin.dataDir, "prior-run-marker");
              await writeFile(markerPath, "old state", "utf8");
              const second = await createDemoRun(testRoot);
              witness(ctx, first.runRoot !== second.runRoot, "the rerun receives a different run root");
              witness(ctx, first.admin.root !== second.admin.root, "Demo A receives a fresh folder on rerun");
              witness(ctx, first.consumer.root !== second.consumer.root, "Demo B receives a fresh folder on rerun");
              witness(ctx, !(await exists(path.join(second.admin.dataDir, "prior-run-marker"))), "prior Demo A state is absent from the rerun");
              ctx.output("Consecutive run roots", `First:  ${first.runRoot}\nSecond: ${second.runRoot}`);
            },
          });
        } finally {
          await rm(testRoot, { recursive: true, force: true });
        }
      },
    },
  ],
};
