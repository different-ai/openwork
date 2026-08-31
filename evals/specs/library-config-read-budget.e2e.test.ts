import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = { optIn: ["OPENWORK_EVAL_E2E_TESTS"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `library config read budget skipped — needs: ${missingRequirements.join(", ")}`
  : "an idle Library page keeps config reads bounded and skill details stable";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const IDLE_WINDOW_MS = 20_000;
// One legitimate re-read is tolerated (workspace identity settling after
// navigation). The regression this guards against produced a project+global
// pair on every settings re-render: 8+ requests in the same window.
const IDLE_READ_BUDGET = 2;
const LIFECYCLE_READ_BUDGET = 10;

test(title, { timeout: 300_000 }, async ({ evidence }) => {
  needs(requirements);

  await using app = await desktop({ name: "library-config-read-budget" });
  await createAndSelectWorkspace(app, { path: repoRoot });

  // Count opencode-config reads from the renderer before Library mounts so
  // the initial load is observable (the positive half of the claim). The read
  // reaches the config through either seam depending on server availability:
  // an openwork-server fetch (/opencode-config) or the Electron desktop
  // bridge (readOpencodeConfig IPC). Count both.
  const installed = await evalIn(app, `(() => {
    if (window.__opencodeConfigReads !== undefined) return true;
    window.__opencodeConfigReads = 0;
    window.__librarySkillReads = 0;
    window.__libraryLifecycleReads = 0;
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const target = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (typeof target === "string" && target.includes("/opencode-config")) {
        window.__opencodeConfigReads += 1;
      }
      if (typeof target === "string" && target.includes("/skills/browser-automation")) {
        window.__librarySkillReads += 1;
      }
      if (typeof target === "string" && (
        target.includes("/cloud-provider-sync/status")
        || target.includes("/opencode/config?")
        || target.endsWith("/mcp")
        || target.endsWith("/den-session")
      )) {
        window.__libraryLifecycleReads += 1;
      }
      return originalFetch.apply(this, args);
    };
    const bridge = window.__OPENWORK_ELECTRON__;
    if (bridge && typeof bridge.invokeDesktop === "function") {
      const originalInvoke = bridge.invokeDesktop.bind(bridge);
      bridge.invokeDesktop = function (command, ...rest) {
        if (command === "readOpencodeConfig") {
          window.__opencodeConfigReads += 1;
        }
        return originalInvoke(command, ...rest);
      };
    }
    return true;
  })()`);
  expect(installed).toBe(true);

  await evalIn(app, `(() => {
    window.location.hash = "#/settings/extensions";
    return true;
  })()`);
  await waitFor(
    app,
    `window.location.hash.includes("/settings/extensions")
      && [...document.querySelectorAll("h1, h2")].some((heading) => heading.textContent?.trim() === "Library")`,
    { timeoutMs: 60_000, label: "Library page" },
  );

  // Positive half: the Library page still reads opencode.json at least once.
  await waitFor(app, `window.__opencodeConfigReads >= 1`, {
    timeoutMs: 30_000,
    label: "initial opencode-config read",
  });

  // Let the initial mount (project + global scopes, workspace settling) finish.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const settled = await evalIn(app, `window.__opencodeConfigReads`);
  expect(typeof settled).toBe("number");

  // Negative half: while idle on Library, background store ticks (health
  // polls, MCP status refreshes) must not retrigger config reads.
  await new Promise((resolve) => setTimeout(resolve, IDLE_WINDOW_MS));
  const afterIdle = await evalIn(app, `window.__opencodeConfigReads`);
  expect(typeof afterIdle).toBe("number");

  const idleReads = Number(afterIdle) - Number(settled);
  evidence.recordAssertionEvidence(
    "Idle Library config reads stay bounded",
    `${idleReads} opencode-config reads during a ${IDLE_WINDOW_MS / 1000}s settled idle window; budget ${IDLE_READ_BUDGET}.`,
    idleReads <= IDLE_READ_BUDGET,
  );
  expect(
    idleReads,
    `opencode-config was read ${idleReads} times during a ${IDLE_WINDOW_MS / 1000}s idle window (budget ${IDLE_READ_BUDGET}); the Library page is refetching config on unrelated re-renders`,
  ).toBeLessThanOrEqual(IDLE_READ_BUDGET);

  // The page must still be alive and on Library after the idle window.
  const stillOnLibrary = await evalIn(
    app,
    `window.location.hash.includes("/settings/extensions")`,
  );
  expect(stillOnLibrary).toBe(true);

  // Opening a local skill reads its body once. Unrelated server health ticks
  // must not recreate the Library's derived arrays/callback and repeatedly
  // clear + reload the detail body.
  const openedSkill = await evalIn(app, `(() => {
    const skill = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("browser-automation"));
    if (!skill) return false;
    skill.click();
    return true;
  })()`);
  expect(openedSkill).toBe(true);
  await waitFor(
    app,
    `window.location.hash.includes("skill%3Abrowser-automation")
      && document.body.innerText.includes("known-good smoke prompt")`,
    { timeoutMs: 30_000, label: "browser automation skill detail" },
  );

  const settledSkillReads = await evalIn(app, `window.__librarySkillReads`);
  expect(typeof settledSkillReads).toBe("number");
  await evalIn(app, `(() => {
    window.__libraryDetailContentMissing = false;
    window.__libraryLifecycleReads = 0;
    window.__libraryPolicyTick = 0;
    window.__libraryDetailWatcher = window.setInterval(() => {
      if (!document.body.innerText.includes("known-good smoke prompt")) {
        window.__libraryDetailContentMissing = true;
      }
    }, 50);
    window.__libraryPolicyWatcher = window.setInterval(() => {
      window.__libraryPolicyTick += 1;
      window.__openworkApplyDesktopConfig?.({
        allowZenModel: window.__libraryPolicyTick % 2 === 0,
      });
    }, 100);
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, IDLE_WINDOW_MS));
  const detailResult = await evalIn(app, `(() => {
    window.clearInterval(window.__libraryDetailWatcher);
    window.clearInterval(window.__libraryPolicyWatcher);
    return {
      skillReads: window.__librarySkillReads,
      contentMissing: window.__libraryDetailContentMissing,
      contentVisible: document.body.innerText.includes("known-good smoke prompt"),
      lifecycleReads: window.__libraryLifecycleReads,
      policyTicks: window.__libraryPolicyTick,
      stable: window.__librarySkillReads === ${Number(settledSkillReads)}
        && !window.__libraryDetailContentMissing
        && document.body.innerText.includes("known-good smoke prompt")
        && window.__libraryLifecycleReads <= ${LIFECYCLE_READ_BUDGET}
        && window.__libraryPolicyTick > 0,
    };
  })()`);
  const detailStable = JSON.stringify(detailResult).includes('"stable":true');
  evidence.recordAssertionEvidence(
    "Open Library skill details stay visible without refetching",
    `Settled reads: ${String(settledSkillReads)}; observed after ${IDLE_WINDOW_MS / 1000}s: ${JSON.stringify(detailResult)}.`,
    detailStable,
  );
  expect(detailResult).toMatchObject({
    skillReads: settledSkillReads,
    contentMissing: false,
    contentVisible: true,
    stable: true,
  });
  expect(detailResult).toMatchObject({ lifecycleReads: expect.any(Number) });
  expect(detailResult).toMatchObject({ policyTicks: expect.any(Number) });
  expect(detailResult).not.toMatchObject({ policyTicks: 0 });
});
