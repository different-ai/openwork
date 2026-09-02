import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, go, seedSessions, waitFor } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "the session header names the workspace a pinned session belongs to, after its title"
  : "session header workspace name skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

/**
 * Pinned (and archived) sessions are listed in one global sidebar section
 * across every workspace, and those rows carry no workspace label. Opening a
 * pinned session must therefore tell the person which workspace it came from:
 * the header shows the session title first and the workspace name after it
 * as secondary text.
 */

type HeaderFacts = {
  hash: string;
  title: string;
  workspace: string | null;
  pinnedRowIds: string[];
  pinnedRowTitles: string[];
};

/** Interpolate a value into page JavaScript without letting it close a script or break a line. */
function jsValue(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHeaderFacts(value: unknown): HeaderFacts {
  if (
    !isRecord(value)
    || typeof value.hash !== "string"
    || typeof value.title !== "string"
    || !(typeof value.workspace === "string" || value.workspace === null)
    || !Array.isArray(value.pinnedRowIds)
  ) {
    throw new Error(`Header facts were malformed: ${JSON.stringify(value)}`);
  }
  const pinnedRowIds = value.pinnedRowIds.filter((entry): entry is string => typeof entry === "string");
  const pinnedRowTitles = Array.isArray(value.pinnedRowTitles)
    ? value.pinnedRowTitles.filter((entry): entry is string => typeof entry === "string")
    : [];
  return { hash: value.hash, title: value.title, workspace: value.workspace, pinnedRowIds, pinnedRowTitles };
}

const headerFactsExpression = `(() => {
  const header = document.querySelector("header");
  const title = header?.querySelector("h1")?.textContent?.trim() ?? "";
  const workspaceNode = header?.querySelector("[data-session-header-workspace]");
  const workspace = workspaceNode?.getAttribute("data-session-header-workspace") ?? null;
  const pinnedRowIds = [...document.querySelectorAll("[data-global-pinned-sessions] [data-sidebar-session-id]")]
    .map((row) => row.getAttribute("data-sidebar-session-id"))
    .filter(Boolean);
  const pinnedRowTitles = [...document.querySelectorAll("[data-global-pinned-sessions] [data-sidebar-session-id]")]
    .map((row) => (row.querySelector("[data-session-title-text]")?.textContent ?? "").trim());
  // The workspace is rendered after the title in DOM order, so a person reads
  // "title · workspace", never "workspace / title".
  const titleNode = header?.querySelector("h1");
  const orderOk = titleNode && workspaceNode
    ? Boolean(titleNode.compareDocumentPosition(workspaceNode) & Node.DOCUMENT_POSITION_FOLLOWING)
    : true;
  return { hash: window.location.hash, title, workspace: orderOk ? workspace : "<workspace-before-title>", pinnedRowIds, pinnedRowTitles };
})()`;

async function readHeaderFacts(app: Surface): Promise<HeaderFacts> {
  return parseHeaderFacts(await evalIn(app, headerFactsExpression));
}

async function createSecondWorkspace(app: Surface, firstWorkspaceId: string, path: string): Promise<string> {
  await control(app, "workspace.create", { path }, { timeoutMs: 90_000 });
  await waitFor(app, `(() => {
    const active = localStorage.getItem("openwork.react.activeWorkspace") ?? "";
    return active !== "" && active !== ${jsValue(firstWorkspaceId)};
  })()`, { timeoutMs: 120_000, label: "second workspace selected" });
  const workspaceId = await evalIn(app, `localStorage.getItem("openwork.react.activeWorkspace") ?? ""`);
  if (typeof workspaceId !== "string" || !workspaceId) {
    throw new Error(`workspace.create did not select a second workspace: ${JSON.stringify(workspaceId)}`);
  }
  return workspaceId;
}

async function pinSession(app: Surface, sessionId: string): Promise<void> {
  const result = await control(app, "session.pin", { sessionId }, { timeoutMs: 15_000 });
  if (!isRecord(result) || result.pinned !== true) {
    throw new Error(`session.pin did not pin ${sessionId}: ${JSON.stringify(result)}`);
  }
}

/**
 * Open a session and give the header a bounded chance to reach the expected
 * state. Switching workspaces reloads that workspace's session list, so the
 * title can briefly read as the default until the list arrives. The bound
 * never throws: the caller's assertions decide.
 */
async function openAndSettle(
  app: Surface,
  session: { sessionId: string; title: string },
  expectedWorkspace: string,
): Promise<HeaderFacts> {
  // Click the row in the global Pinned section, the way a person opens it.
  const clicked = await evalIn(app, `(() => {
    const row = document.querySelector(${jsValue(`[data-global-pinned-sessions] [data-sidebar-session-id="${session.sessionId}"] [data-session-tab-id]`)});
    if (!(row instanceof HTMLElement)) return "pinned row missing";
    row.click();
    return "ok";
  })()`);
  if (clicked !== "ok") throw new Error(`Could not click pinned row for ${session.sessionId}: ${JSON.stringify(clicked)}`);
  await waitFor(app, `window.location.hash.includes(${jsValue(session.sessionId)})`, {
    timeoutMs: 30_000,
    label: `route points at ${session.sessionId}`,
  });
  await waitFor(app, `(() => {
    const header = document.querySelector("header");
    const title = header?.querySelector("h1")?.textContent?.trim() ?? "";
    const workspace = header?.querySelector("[data-session-header-workspace]")?.getAttribute("data-session-header-workspace");
    return title === ${jsValue(session.title)} && workspace === ${jsValue(expectedWorkspace)};
  })()`, { timeoutMs: 30_000, label: `header reads ${session.title} · ${expectedWorkspace}` }).catch(() => undefined);
  return readHeaderFacts(app);
}

test.skipIf(!e2eTestsEnabled)(title, { timeout: 20 * 60_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "session-header-workspace-name", host: place.host() });
  // Below the app's 1024px mobile breakpoint the sidebar is a closed sheet and
  // the Pinned section a person would use is not mounted.
  await app.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const stamp = `${Date.now()}-${process.pid}`;
  // Workspace names come from the folder basename, so name the folders after
  // what the header must show.
  const alphaName = `alpha-notes-${stamp}`;
  const betaName = `beta-research-${stamp}`;

  const { workspaceId: alphaId } = await createAndSelectWorkspace(app, { path: `/tmp/${alphaName}` });
  const betaId = await createSecondWorkspace(app, alphaId, `/tmp/${betaName}`);
  expect(betaId).not.toBe(alphaId);

  // Beta is selected right after creation: seed its session first, then alpha's.
  const [betaSession] = await seedSessions(app, [`Beta plan ${stamp}`]);
  await pinSession(app, betaSession.sessionId);
  await waitFor(app, `document.querySelectorAll("[data-global-pinned-sessions] [data-sidebar-session-id]").length >= 1`, {
    timeoutMs: 30_000,
    label: "beta pinned row rendered",
  });
  // Control: opening a pinned session from the currently selected workspace.
  const betaOwnFacts = await openAndSettle(app, betaSession, betaName);
  expect(betaOwnFacts.title).toBe(betaSession.title);
  expect(betaOwnFacts.workspace).toBe(betaName);

  await go(app, `/workspace/${encodeURIComponent(alphaId)}/session`);
  await waitFor(app, `(localStorage.getItem("openwork.react.activeWorkspace") ?? "") === ${jsValue(alphaId)}`, {
    timeoutMs: 60_000,
    label: "alpha workspace selected",
  });
  const [alphaSession] = await seedSessions(app, [`Alpha brief ${stamp}`]);
  await pinSession(app, alphaSession.sessionId);
  await waitFor(app, `document.querySelectorAll("[data-global-pinned-sessions] [data-sidebar-session-id]").length >= 2`, {
    timeoutMs: 30_000,
    label: "both pinned rows rendered",
  });

  // Subject: open the pinned session from the other workspace (beta) while alpha is selected.
  const betaFacts = await openAndSettle(app, betaSession, betaName);
  expect(betaFacts.hash).toContain(betaSession.sessionId);
  expect(betaFacts.pinnedRowIds).toEqual(expect.arrayContaining([alphaSession.sessionId, betaSession.sessionId]));
  expect(betaFacts.title, "header keeps the session title as the primary text").toBe(betaSession.title);
  expect(betaFacts.workspace, "header names beta after the title").toBe(betaName);
  expect(betaFacts.workspace, "header must not name the previously selected workspace").not.toBe(alphaName);
  evidence.recordAssertionEvidence(
    "Opening a pinned session from another workspace shows its title first and that workspace's name as secondary header text",
    `route=${betaFacts.hash}; title=${JSON.stringify(betaFacts.title)}; workspace=${JSON.stringify(betaFacts.workspace)}; pinned=${JSON.stringify(betaFacts.pinnedRowIds)}.`,
    betaFacts.title === betaSession.title && betaFacts.workspace === betaName,
  );

  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      `The top header of the main pane shows the session title "${betaSession.title}" followed by smaller secondary text naming the workspace "${betaName}"`,
      "The workspace name appears after the session title, not before it",
      "The left sidebar has a Pinned section with two rows",
      "No error dialog or crash message is visible",
    ]);
    evidence.recordAssertionEvidence("Visual: header reads title first, workspace second", seen.why, seen.ok);
  }

  // Negative half: switching to the other pinned session swaps the workspace name back.
  const alphaFacts = await openAndSettle(app, alphaSession, alphaName);
  expect(alphaFacts.hash).toContain(alphaSession.sessionId);
  expect(alphaFacts.title, `header title; facts=${JSON.stringify(alphaFacts)}`).toBe(alphaSession.title);
  expect(alphaFacts.workspace).toBe(alphaName);
  expect(alphaFacts.workspace).not.toBe(betaName);
  evidence.recordAssertionEvidence(
    "Opening the other pinned session updates the header to its own workspace and drops the previous one",
    `route=${alphaFacts.hash}; title=${JSON.stringify(alphaFacts.title)}; workspace=${JSON.stringify(alphaFacts.workspace)}.`,
    alphaFacts.workspace === alphaName && alphaFacts.title === alphaSession.title,
  );
});
