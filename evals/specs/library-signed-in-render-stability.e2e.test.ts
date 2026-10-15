import { browserScript } from "@openwork/testkit";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { clickText, createAndSelectWorkspace, evalIn, signInDesktopAs, waitFor } from "@openwork/behaviors";
import { allocateFreePorts, appWeb, needs, server, test } from "@openwork/testkit";

// No trailing slash: the workspace is matched by its exact folder path.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/+$/, "");
const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "signed-in Library stays rendered without provider refresh storms"
  : "signed-in Library stability skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

test.skipIf(!enabled)(title, { timeout: 10 * 60_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  const [webPort] = await allocateFreePorts(1);
  if (!webPort) throw new Error("No port available for the app in a browser.");
  await using den = await server({
    place,
    trustedOrigins: [`http://127.0.0.1:${webPort}`],
    org: {
      name: "Library Render Stability",
      admin: { name: "Library Admin" },
      members: { member: { name: "Library Member" } },
    },
  });
  // The member's app in headless Chrome, on the repository workspace.
  await using desktopApp = await appWeb({ place, name: "library-signed-in-render-stability", workspacePath: repoRoot, webPort, den: den.ref, mouse: true });
  const member = den.members.member;
  if (!member) throw new Error("The Library member was not created.");
  await signInDesktopAs(desktopApp, den.ref, member);
  const workspace = await createAndSelectWorkspace(desktopApp, { path: repoRoot });

  const instrumented = await evalIn(desktopApp, browserScript((value) => {
    window.__libraryStability = {
      requests: [],
      denEvents: 0,
      samples: [],
    };
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const target = args[0] instanceof Request ? args[0].url : String(args[0]);
      window.__libraryStability.requests.push(String(target));
      return originalFetch.apply(this, args);
    };
    window.addEventListener("openwork-den-settings-changed", () => {
      window.__libraryStability.denEvents += 1;
    });
    // The app in a browser routes by path; its router follows popstate.
    history.pushState(history.state, "", value);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    return true;
  }, [`/workspace/${workspace.workspaceId}/extensions`]));
  expect(instrumented).toBe(true);
  await waitFor(
    desktopApp,
    () => (location.pathname.includes("/extensions")
      && [...document.querySelectorAll<HTMLElement>("h1, h2")].some((heading) => heading.textContent?.trim() === "Library")),
    { timeoutMs: 60_000, label: "signed-in Library" },
  );

  // The repository workspace ships skills under .opencode/skills, so Skills is
  // the deterministic card inventory for a fresh member. OpenWork's own
  // runtimes (such as Browser) are no longer Library cards. The
  // regression this spec guards against fires on the Library route itself:
  // repeated Den settings echoes retrigger provider sync and remove/re-add
  // inventory cards.
  await clickText(desktopApp, "Skills", { selector: '[aria-label="Library filters"] button[aria-pressed]' });
  await waitFor(
    desktopApp,
    () => (document.body.innerText.includes("add-a-feature")
      && document.body.innerText.includes("create-plugin")
      && !document.body.innerText.includes("OpenWork Browser")),
    { timeoutMs: 120_000, label: "signed-in Library inventory" },
  );

  await new Promise((resolve) => setTimeout(resolve, 10_000));
  await evalIn(desktopApp, () => {
    window.__libraryStability.requests = [];
    window.__libraryStability.denEvents = 0;
    window.__libraryStability.samples = [];
    window.__libraryStability.sampler = window.setInterval(() => {
      window.__libraryStability.samples.push({
        buttons: document.querySelectorAll("button").length,
        contentVisible: document.body.innerText.includes("add-a-feature")
          && document.body.innerText.includes("create-plugin"),
      });
    }, 50);
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20_000));

  const result = await evalIn(desktopApp, () => {
    window.clearInterval(window.__libraryStability.sampler);
    const requests = window.__libraryStability.requests;
    const count = (part: string) => requests.filter((target) => target.includes(part)).length;
    const buttonCounts = window.__libraryStability.samples.map((sample) => sample.buttons);
    const inventoryStayedVisible = window.__libraryStability.samples.every((sample) => sample.contentVisible);
    const minButtons = Math.min(...buttonCounts);
    const maxButtons = Math.max(...buttonCounts);
    const observed = {
      denEvents: window.__libraryStability.denEvents,
      providerConfigReads: count("/opencode/config?"),
      providerSyncStatusReads: count("/cloud-provider-sync/status"),
      providerSyncRuns: count("/cloud-provider-sync/run"),
      inventoryStayedVisible,
      minButtons,
      maxButtons,
    };
    return {
      ...observed,
      stable: observed.denEvents <= 1
        && observed.providerConfigReads <= 2
        && observed.providerSyncStatusReads <= 2
        && observed.providerSyncRuns <= 1
        && observed.inventoryStayedVisible
        && observed.minButtons === observed.maxButtons,
    };
  });
  const passed = JSON.stringify(result).includes('"stable":true');
  evidence.recordAssertionEvidence(
    "Signed-in Library remains stable after its initial load",
    `Twenty-second settled observation: ${JSON.stringify(result)}.`,
    passed,
  );
  expect(result).toMatchObject({
    stable: true,
    inventoryStayedVisible: true,
    denEvents: expect.any(Number),
    providerConfigReads: expect.any(Number),
    providerSyncStatusReads: expect.any(Number),
  });
});
