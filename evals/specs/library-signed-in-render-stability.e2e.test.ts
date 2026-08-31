import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { app, needs, server, test } from "@openwork/testkit";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "signed-in Library stays rendered without provider refresh storms"
  : "signed-in Library stability skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

test.skipIf(!enabled)(title, { timeout: 10 * 60_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  await using den = await server({
    place,
    org: {
      name: "Library Render Stability",
      admin: { name: "Library Admin" },
      members: { member: { name: "Library Member" } },
    },
  });
  await using desktopApp = await app({ den, as: "member", place });
  const workspace = await createAndSelectWorkspace(desktopApp, { path: repoRoot });

  const instrumented = await evalIn(desktopApp, `(() => {
    window.__libraryStability = {
      requests: [],
      denEvents: 0,
      samples: [],
    };
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const target = typeof args[0] === "string" ? args[0] : args[0]?.url;
      window.__libraryStability.requests.push(String(target));
      return originalFetch.apply(this, args);
    };
    window.addEventListener("openwork-den-settings-changed", () => {
      window.__libraryStability.denEvents += 1;
    });
    location.hash = ${JSON.stringify(`#/workspace/${workspace.workspaceId}/extensions`)};
    return true;
  })()`);
  expect(instrumented).toBe(true);
  await waitFor(
    desktopApp,
    `location.hash.includes("/extensions")
      && [...document.querySelectorAll("h1, h2")].some((heading) => heading.textContent?.trim() === "Library")`,
    { timeoutMs: 60_000, label: "signed-in Library" },
  );

  await waitFor(
    desktopApp,
    `[...document.querySelectorAll("button")]
      .some((button) => button.textContent?.includes("browser-automation"))`,
    { timeoutMs: 120_000, label: "browser automation skill card" },
  );
  const openedSkill = await evalIn(desktopApp, `(() => {
    const skill = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("browser-automation"));
    if (!skill) return false;
    skill.click();
    return true;
  })()`);
  expect(openedSkill).toBe(true);
  await waitFor(
    desktopApp,
    `location.hash.includes("skill%3Abrowser-automation")
      && document.body.innerText.includes("known-good smoke prompt")`,
    { timeoutMs: 30_000, label: "signed-in Library skill detail" },
  );

  await new Promise((resolve) => setTimeout(resolve, 5_000));
  await evalIn(desktopApp, `(() => {
    window.__libraryStability.requests = [];
    window.__libraryStability.denEvents = 0;
    window.__libraryStability.samples = [];
    window.__libraryStability.sampler = window.setInterval(() => {
      window.__libraryStability.samples.push({
        buttons: document.querySelectorAll("button").length,
        contentVisible: document.body.innerText.includes("known-good smoke prompt"),
      });
    }, 50);
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 20_000));

  const result = await evalIn(desktopApp, `(() => {
    window.clearInterval(window.__libraryStability.sampler);
    const requests = window.__libraryStability.requests;
    const count = (part) => requests.filter((target) => target.includes(part)).length;
    const buttonCounts = window.__libraryStability.samples.map((sample) => sample.buttons);
    const detailStayedVisible = window.__libraryStability.samples.every((sample) => sample.contentVisible);
    const minButtons = Math.min(...buttonCounts);
    const maxButtons = Math.max(...buttonCounts);
    const observed = {
      denEvents: window.__libraryStability.denEvents,
      providerConfigReads: count("/opencode/config?"),
      providerSyncStatusReads: count("/cloud-provider-sync/status"),
      providerSyncRuns: count("/cloud-provider-sync/run"),
      detailStayedVisible,
      minButtons,
      maxButtons,
    };
    return {
      ...observed,
      stable: observed.denEvents <= 1
        && observed.providerConfigReads <= 2
        && observed.providerSyncStatusReads <= 2
        && observed.providerSyncRuns <= 1
        && observed.detailStayedVisible
        && observed.minButtons === observed.maxButtons,
    };
  })()`);
  const passed = JSON.stringify(result).includes('"stable":true');
  evidence.recordAssertionEvidence(
    "Signed-in Library remains stable after its initial load",
    `Twenty-second settled observation: ${JSON.stringify(result)}.`,
    passed,
  );
  expect(result).toMatchObject({
    stable: true,
    detailStayedVisible: true,
    denEvents: expect.any(Number),
    providerConfigReads: expect.any(Number),
    providerSyncStatusReads: expect.any(Number),
  });
});
