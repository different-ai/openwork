import { expect } from "vitest";
import { denFetch, evalIn, go, waitFor } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import { app, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Library connector discovery skipped — needs: ${missingRequirements.join(", ")}`
  : "Add to your Library unifies all choices and previews hosted connectors";

const expectedChoices = [
  "Skill",
  "Command",
  "Agent",
  "Plugin",
  "Organization MCP",
  "Workspace MCP",
  "Connection",
];
const expectedConnectorCues = [
  "Notion",
  "Slack",
  "Google Workspace",
  "Microsoft 365",
  "Linear",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function organizationId(session: DenSession): Promise<string> {
  const response = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const organizations = isRecord(response.body) && Array.isArray(response.body.orgs)
    ? response.body.orgs.filter(isRecord)
    : [];
  const id = organizations[0] && typeof organizations[0].id === "string"
    ? organizations[0].id
    : "";
  if (!response.response.ok || !id) {
    throw new Error(`Resolving the test organization failed: HTTP ${response.response.status} ${response.text.slice(0, 500)}`);
  }
  return id;
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  const stamp = Date.now();
  await using den = await server({
    place,
    org: {
      name: `Library connector discovery ${stamp}`,
      admin: { name: "Library Connector Admin" },
    },
  });
  const orgId = await organizationId(den.admin);
  await using desktop = await app({
    den,
    as: "admin",
    place,
  });

  await desktop.client.send("Emulation.setDeviceMetricsOverride", {
    width: 820,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await go(desktop, `/workspace/${desktop.workspaceId}/extensions`);
  await waitFor(desktop, `[...document.querySelectorAll("button")]
    .some((button) => (button.textContent ?? "").trim() === "Add")`, {
    timeoutMs: 90_000,
    label: "signed-in Library Add control",
  });
  const bootstrap = await evalIn(
    desktop,
    `window.__OPENWORK_ELECTRON__.invokeDesktop("getDesktopBootstrapConfig")
      .then((config) => ({
        baseUrl: config.baseUrl,
        activeOrgId: localStorage.getItem("openwork.den.activeOrgId"),
      }))`,
    { awaitPromise: true },
  );
  expect(bootstrap).toMatchObject({
    baseUrl: den.ref.webUrl,
    activeOrgId: orgId,
  });

  const addOpened = await evalIn(desktop, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => (entry.textContent ?? "").trim() === "Add");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(addOpened).toBe(true);
  await waitFor(desktop, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog?.querySelectorAll('[data-testid="connection-logo-cues"] [data-connector-cue]').length === 5;
  })()`, {
    timeoutMs: 30_000,
    label: "unified Library picker with representative connector logos",
  });

  const picker = await evalIn(desktop, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const dialogRect = dialog?.getBoundingClientRect();
    const continueButton = dialog
      ? [...dialog.querySelectorAll('button')]
          .find((button) => (button.textContent ?? '').trim() === 'Continue')
      : null;
    const continueRect = continueButton?.getBoundingClientRect();
    const cueStrip = dialog?.querySelector('[data-testid="connection-logo-cues"]');
    const cueTiles = dialog ? [...dialog.querySelectorAll('[data-connector-cue]')] : [];
    const lightTileBackgrounds = cueTiles.map((tile) => getComputedStyle(tile).backgroundColor);
    const previousTheme = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = 'dark';
    const darkTileBackgrounds = cueTiles.map((tile) => getComputedStyle(tile).backgroundColor);
    if (previousTheme) {
      document.documentElement.dataset.theme = previousTheme;
    } else {
      delete document.documentElement.dataset.theme;
    }
    return {
      choices: dialog
        ? [...dialog.querySelectorAll('[data-kind-title]')]
            .map((item) => (item.textContent ?? '').trim())
        : [],
      radioGroups: dialog?.querySelectorAll('[role="radiogroup"]').length ?? 0,
      oldMakeSection: dialog?.textContent?.includes('WHAT ARE YOU MAKING') ?? false,
      oldConnectSection: dialog?.textContent?.includes('OR CONNECT SOMETHING') ?? false,
      opensDenCopy: dialog?.textContent?.includes('manage setup for this organization in OpenWork Den') ?? false,
      cues: cueTiles.map((item) => item.getAttribute('title')),
      logoLabels: dialog
        ? [...dialog.querySelectorAll('[data-connector-cue] img, [data-connector-cue] [aria-label]')]
            .map((item) => item.getAttribute('alt') || item.getAttribute('aria-label'))
        : [],
      cueStripWraps: cueStrip?.classList.contains('flex-wrap') ?? false,
      lightTileBackgrounds,
      darkTileBackgrounds,
      dialogWithinViewport: Boolean(
        dialogRect
          && dialogRect.left >= 0
          && dialogRect.right <= window.innerWidth
          && dialogRect.top >= 0
          && dialogRect.bottom <= window.innerHeight,
      ),
      continueVisible: Boolean(
        continueRect
          && continueRect.left >= 0
          && continueRect.right <= window.innerWidth
          && continueRect.top >= 0
          && continueRect.bottom <= window.innerHeight,
      ),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  expect(picker).toMatchObject({
    choices: expectedChoices,
    radioGroups: 1,
    oldMakeSection: false,
    oldConnectSection: false,
    opensDenCopy: true,
    cues: expectedConnectorCues,
    logoLabels: expectedConnectorCues.map((name) => `${name} logo`),
    cueStripWraps: true,
    dialogWithinViewport: true,
    continueVisible: true,
    horizontalOverflow: false,
  });
  if (!isRecord(picker) || !Array.isArray(picker.lightTileBackgrounds) || !Array.isArray(picker.darkTileBackgrounds)) {
    throw new Error("The Library picker layout facts were not an object.");
  }
  expect(picker.lightTileBackgrounds).toEqual(expectedConnectorCues.map(() => "rgb(255, 255, 255)"));
  expect(picker.darkTileBackgrounds).toEqual(expectedConnectorCues.map(() => "rgb(255, 255, 255)"));
  evidence.recordAssertionEvidence(
    "Add to your Library is one responsive seven-choice surface with recognizable hosted-service cues",
    `At 820×760 the picker rendered ${JSON.stringify(picker)}.`,
    JSON.stringify(picker.choices) === JSON.stringify(expectedChoices)
      && picker.radioGroups === 1
      && picker.oldMakeSection === false
      && picker.oldConnectSection === false
      && JSON.stringify(picker.cues) === JSON.stringify(expectedConnectorCues)
      && picker.dialogWithinViewport === true
      && picker.continueVisible === true
      && picker.horizontalOverflow === false,
  );

  await waitFor(desktop, `(() => {
    const cues = [...document.querySelectorAll('[data-connector-cue]')];
    return cues.length === 5 && cues.every((cue) => {
      const image = cue.querySelector('img');
      return image instanceof HTMLImageElement
        && image.complete
        && image.naturalWidth > 0;
    });
  })()`, {
    timeoutMs: 30_000,
    label: "all five recognizable connector logos loaded",
  });
  {
    const shot = await screenshot(desktop);
    const seen = await validate(shot, [
      "The Add to your Library dialog presents Skill, Command, Agent, Plugin, Organization MCP, Workspace MCP, and Connection as one continuous selection surface",
      "The Connection choice visibly includes a compact row of recognizable service marks for Notion, Slack, Google Workspace, Microsoft 365, and Linear",
      "The dialog has no separate WHAT ARE YOU MAKING or OR CONNECT SOMETHING sections",
      "The dialog, descriptions, connector marks, Cancel button, and Continue button fit within the desktop viewport without clipping",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const connectionSelected = await evalIn(desktop, `(() => {
    const connection = document.querySelector('[role="radio"][data-kind="connection"]');
    if (!(connection instanceof HTMLElement)) return false;
    connection.click();
    return true;
  })()`);
  expect(connectionSelected).toBe(true);
  await waitFor(desktop, `document.querySelector('[role="radio"][data-kind="connection"]')
    ?.getAttribute('aria-checked') === 'true'`, {
    timeoutMs: 10_000,
    label: "Connection selected in the unified picker",
  });
  const previousTheme = await evalIn(desktop, `document.documentElement.dataset.theme ?? ''`);
  await evalIn(desktop, `document.documentElement.dataset.theme = 'dark'`);
  try {
    await waitFor(desktop, `document.documentElement.dataset.theme === 'dark'`, {
      timeoutMs: 10_000,
      label: "dark theme applied through the app theme attribute",
    });
    await evalIn(desktop, `(() => {
      for (const toast of document.querySelectorAll('[data-sonner-toast]')) {
        const closeButton = toast.querySelector(
          '[data-close-button], button[aria-label*="close" i]',
        );
        if (closeButton instanceof HTMLButtonElement) closeButton.click();
      }
      return true;
    })()`);
    await waitFor(desktop, `document.querySelectorAll('[data-sonner-toast]').length === 0`, {
      timeoutMs: 10_000,
      label: "unrelated test-world notifications dismissed before dark-theme evidence",
    });
    const shot = await screenshot(desktop);
    const seen = await validate(shot, [
      "The Add to your Library dialog is visibly rendered in a dark theme",
      "Connection is the selected choice and remains in the same continuous list as the OpenWork creation and MCP choices",
      "The Connection choice visibly includes recognizable marks for Notion, Slack, Google Workspace, Microsoft 365, and Linear",
      "The dark-theme dialog, all seven choices, descriptions, connector marks, Cancel button, and Continue button fit within the desktop viewport without clipping",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  } finally {
    await evalIn(
      desktop,
      previousTheme
        ? `document.documentElement.dataset.theme = ${JSON.stringify(previousTheme)}`
        : `delete document.documentElement.dataset.theme`,
    );
  }
  const connectionContinued = await evalIn(desktop, `(() => {
    const continueButton = [...document.querySelectorAll('[role="dialog"] button')]
      .find((button) => (button.textContent ?? '').trim() === 'Continue');
    if (!(continueButton instanceof HTMLButtonElement) || continueButton.disabled) return false;
    continueButton.click();
    return true;
  })()`);
  expect(connectionContinued).toBe(true);
  await waitFor(desktop, `!document.querySelector('[role="dialog"]')
    && decodeURIComponent(location.hash).endsWith('/extensions')
    && [...document.querySelectorAll('button')]
      .some((button) => (button.textContent ?? '').trim() === 'Add')`, {
    timeoutMs: 20_000,
    label: "Connection handoff closes cleanly without entering a native creation flow",
  });

  const reopenedCleanly = await evalIn(desktop, `(() => {
    const addButton = [...document.querySelectorAll('button')]
      .find((button) => (button.textContent ?? '').trim() === 'Add');
    if (!(addButton instanceof HTMLButtonElement)) return false;
    addButton.click();
    return true;
  })()`);
  expect(reopenedCleanly).toBe(true);
  await waitFor(desktop, `document.querySelectorAll('[role="dialog"]').length === 1
    && document.querySelectorAll('[data-testid="library-add-choices"]').length === 1`, {
    timeoutMs: 20_000,
    label: "clean Library picker state after returning from Den handoff",
  });
  const modalCount = await evalIn(desktop, `document.querySelectorAll('[role="dialog"]').length`);
  expect(modalCount).toBe(1);
  evidence.recordAssertionEvidence(
    "Connection keeps organization context and returns without duplicate modal state",
    `The active bootstrap organization was ${orgId} on ${den.ref.webUrl}; Connection closed without a native creation modal and reopening produced ${modalCount} dialog.`,
    isRecord(bootstrap)
      && bootstrap.activeOrgId === orgId
      && bootstrap.baseUrl === den.ref.webUrl
      && modalCount === 1,
  );
});
