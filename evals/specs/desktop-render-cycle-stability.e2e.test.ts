import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import type { Surface } from "@openwork/cdp";
import { clickButton, evalIn, fill, waitFor, waitForText } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `desktop render-cycle stability skipped — needs: ${missingRequirements.join(", ")}`
  : "workspace onboarding settles without timer-driven React commits";

interface WelcomeRenderFacts {
  commitCount: number;
  longestHalfSecondRun: number;
  recentCommitCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: Record<string, unknown>, key: string): number {
  const field = Reflect.get(value, key);
  if (typeof field !== "number") throw new Error(`Render facts omitted numeric ${key}.`);
  return field;
}

async function readWelcomeRenderFacts(app: Surface): Promise<WelcomeRenderFacts> {
  const value = await evalIn(app, `(() => {
    const profiler = window.__openwork.snapshot().profiler;
    const zone = profiler.zones.find((entry) => entry.id === "WelcomeRoute");
    const commits = profiler.recent
      .filter((entry) => entry.id === "WelcomeRoute")
      .map((entry) => entry.commitAt);
    let longestHalfSecondRun = 0;
    let currentRun = 0;
    for (let index = 1; index < commits.length; index += 1) {
      const gap = commits[index] - commits[index - 1];
      currentRun = gap >= 400 && gap <= 600 ? currentRun + 1 : 0;
      longestHalfSecondRun = Math.max(longestHalfSecondRun, currentRun);
    }
    return {
      commitCount: zone?.commitCount ?? 0,
      longestHalfSecondRun,
      recentCommitCount: commits.length,
    };
  })()`);
  if (!isRecord(value)) throw new Error("Welcome render facts were not an object.");
  return {
    commitCount: readNumber(value, "commitCount"),
    longestHalfSecondRun: readNumber(value, "longestHalfSecondRun"),
    recentCommitCount: readNumber(value, "recentCommitCount"),
  };
}

test(title, async ({ evidence }) => {
  needs(requirements);

  await using app = await desktop({
    name: "desktop-render-cycle-stability",
    env: { VITE_OPENWORK_PROFILER: "1" },
  });
  let workspacePath = "";
  onTestFinished(async () => {
    if (workspacePath) await rm(workspacePath, { recursive: true, force: true });
  });

  expect(app.readiness.route).toContain("/welcome");
  await waitForText(app, "Welcome to OpenWork");
  await evalIn(app, `(() => {
    localStorage.setItem("openwork.debug.profilerOverlay", "1");
    location.reload();
    return true;
  })()`);
  await waitForText(app, "Welcome to OpenWork", { timeoutMs: 30_000 });

  await clickButton(app, "Use Without Cloud");
  await waitFor(app, 'Boolean(document.querySelector(\'input[placeholder="/workspace/my-project"]\'))', {
    timeoutMs: 15_000,
    label: "local workspace folder input",
  });
  workspacePath = await mkdtemp(join(tmpdir(), "openwork-render-cycle-"));
  await fill(app, 'input[placeholder="/workspace/my-project"]', workspacePath);
  await clickButton(app, "Use this folder");
  await waitForText(app, "Skip and use the free model", { timeoutMs: 90_000 });

  const completed = await readWelcomeRenderFacts(app);
  expect(completed.recentCommitCount).toBeGreaterThan(0);
  expect(completed.longestHalfSecondRun).toBeLessThan(2);

  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const settled = await readWelcomeRenderFacts(app);
  expect(settled.commitCount - completed.commitCount).toBeLessThanOrEqual(1);

  evidence.recordAssertionEvidence(
    "Workspace creation does not drive an invisible half-second render loop",
    `recentWelcomeCommits=${completed.recentCommitCount}; longestHalfSecondRun=${completed.longestHalfSecondRun}; settledCommitDelta=${settled.commitCount - completed.commitCount}`,
    completed.longestHalfSecondRun < 2 && settled.commitCount - completed.commitCount <= 1,
  );
});
