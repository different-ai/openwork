import { browserScript } from "@openwork/testkit";
import { expect } from "vitest";
import { evalIn, go, waitFor } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import { needs, spec, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import { libraryConnectorDiscovery } from "../worlds/library.ts";

const test = spec.world(libraryConnectorDiscovery);

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
  "Local MCP",
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

test(title, async ({ evidence, world, probe }) => {
  needs(requirements);
  const { app: desktop, workspaceId, organizationId: orgId, denWebUrl } = world;
  await waitFor(desktop, () => document.body.innerText.includes("OpenWork Cloud account and organization."), {
    timeoutMs: 30_000,
    label: "Settings overview on an upgraded profile",
  });
  expect(await probe.storage("openwork.extension.enabled.google-workspace")).toBe(1);
  const settingsText = await probe.text();
  expect(settingsText).toContain("OpenWork Cloud account and organization.");
  expect(settingsText).not.toContain("Google Workspace");
  expect(settingsText).not.toMatch(/Google OAuth|Google Client ID|Google Client Secret/i);
  evidence.recordAssertionEvidence(
    "A stale local Google enabled flag cannot restore legacy Settings setup",
    "The upgraded profile retains openwork.extension.enabled.google-workspace=1. Settings retains the Cloud account entry without restoring Google Workspace or local Google OAuth setup; hosted Connection discovery is checked below.",
    true,
  );
  await go(desktop, `/workspace/${workspaceId}/extensions`);
  await waitFor(desktop, () => ([...document.querySelectorAll("button")]
    .some((button) => (button.textContent ?? "").trim() === "Add")), {
    timeoutMs: 90_000,
    label: "signed-in Library Add control",
  });
  const voiceModeVisible = await evalIn(desktop, () => (
    [...document.querySelectorAll("button, [role=menuitem], h1, h2, h3")]
      .some((element) => /voice mode/i.test(element.textContent ?? "")
        || /voice mode/i.test(element.getAttribute("aria-label") ?? ""))
  ));
  expect(voiceModeVisible).toBe(false);
  const libraryText = await evalIn(desktop, () => document.body.innerText);
  expect(libraryText).not.toContain("Voice Mode");
  expect(libraryText).not.toMatch(/Google OAuth|Google Client ID|Google Client Secret/i);

  const bootstrap = await evalIn(
    desktop,
    () => (window.__OPENWORK_ELECTRON__.invokeDesktop("getDesktopBootstrapConfig")
      .then((config) => ({
        baseUrl: config.baseUrl,
        activeOrgId: localStorage.getItem("openwork.den.activeOrgId"),
      }))),
    { awaitPromise: true },
  );
  expect(bootstrap).toMatchObject({
    baseUrl: denWebUrl,
    activeOrgId: orgId,
  });

  const addOpened = await evalIn(desktop, () => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => (entry.textContent ?? "").trim() === "Add");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  });
  expect(addOpened).toBe(true);
  await waitFor(desktop, () => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    return dialog?.querySelectorAll<HTMLElement>('[data-testid="connection-logo-cues"] [data-connector-cue]').length === 5;
  }, {
    timeoutMs: 30_000,
    label: "unified Library picker with representative connector logos",
  });

  const picker = await evalIn(desktop, () => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const dialogRect = dialog?.getBoundingClientRect();
    const continueButton = dialog
      ? [...dialog.querySelectorAll('button')]
          .find((button) => (button.textContent ?? '').trim() === 'Continue')
      : null;
    const continueRect = continueButton?.getBoundingClientRect();
    const cueStrip = dialog?.querySelector<HTMLElement>('[data-testid="connection-logo-cues"]');
    const cueTiles = dialog ? [...dialog.querySelectorAll<HTMLElement>('[data-connector-cue]')] : [];
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
        ? [...dialog.querySelectorAll<HTMLElement>('[data-kind-title]')]
            .map((item) => (item.textContent ?? '').trim())
        : [],
      radioGroups: dialog?.querySelectorAll<HTMLElement>('[role="radiogroup"]').length ?? 0,
      oldMakeSection: dialog?.textContent?.includes('WHAT ARE YOU MAKING') ?? false,
      oldConnectSection: dialog?.textContent?.includes('OR CONNECT SOMETHING') ?? false,
      opensDenCopy: dialog?.textContent?.includes('manage setup for this organization in OpenWork Den') ?? false,
      cues: cueTiles.map((item) => item.getAttribute('title')),
      logoLabels: dialog
        ? [...dialog.querySelectorAll<HTMLElement>('[data-connector-cue] img, [data-connector-cue] [aria-label]')]
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
  });
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
    "Add to your Library is one responsive five-choice surface with recognizable hosted-service cues",
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

  await waitFor(desktop, () => {
    const cues = [...document.querySelectorAll<HTMLElement>('[data-connector-cue]')];
    return cues.length === 5 && cues.every((cue) => {
      const image = cue.querySelector('img');
      return image instanceof HTMLImageElement
        && image.complete
        && image.naturalWidth > 0;
    });
  }, {
    timeoutMs: 30_000,
    label: "all five recognizable connector logos loaded",
  });
  {
    const shot = await screenshot(desktop);
    const seen = await validate(shot, [
      "The Add to your Library dialog presents Skill, Command, Agent, Local MCP, and Connection as one continuous selection surface",
      "The Connection choice visibly includes a compact row of recognizable service marks for Notion, Slack, Google Workspace, Microsoft 365, and Linear",
      "The dialog has no separate WHAT ARE YOU MAKING or OR CONNECT SOMETHING sections",
      "The dialog, descriptions, connector marks, Cancel button, and Continue button fit within the desktop viewport without clipping",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const connectionSelected = await evalIn(desktop, () => {
    const connection = document.querySelector<HTMLElement>('[role="radio"][data-kind="connection"]');
    if (!(connection instanceof HTMLElement)) return false;
    connection.click();
    return true;
  });
  expect(connectionSelected).toBe(true);
  await waitFor(desktop, () => (document.querySelector<HTMLElement>('[role="radio"][data-kind="connection"]')
    ?.getAttribute('aria-checked') === 'true'), {
    timeoutMs: 10_000,
    label: "Connection selected in the unified picker",
  });
  const previousTheme = await evalIn(desktop, () => (document.documentElement.dataset.theme ?? ''));
  await evalIn(desktop, () => (document.documentElement.dataset.theme = 'dark'));
  try {
    await waitFor(desktop, () => (document.documentElement.dataset.theme === 'dark'), {
      timeoutMs: 10_000,
      label: "dark theme applied through the app theme attribute",
    });
    await evalIn(desktop, () => {
      for (const toast of document.querySelectorAll<HTMLElement>('[data-sonner-toast]')) {
        const closeButton = toast.querySelector<HTMLElement>(
          '[data-close-button], button[aria-label*="close" i]',
        );
        if (closeButton instanceof HTMLButtonElement) closeButton.click();
      }
      return true;
    });
    await waitFor(desktop, () => (document.querySelectorAll<HTMLElement>('[data-sonner-toast]').length === 0), {
      timeoutMs: 10_000,
      label: "unrelated test-world notifications dismissed before dark-theme evidence",
    });
    const shot = await screenshot(desktop);
    const seen = await validate(shot, [
      "The Add to your Library dialog is visibly rendered in a dark theme",
      "Connection is the selected choice and remains in the same continuous list as the OpenWork creation and MCP choices",
      "The Connection choice visibly includes recognizable marks for Notion, Slack, Google Workspace, Microsoft 365, and Linear",
      "The dark-theme dialog, all five choices, descriptions, connector marks, Cancel button, and Continue button fit within the desktop viewport without clipping",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  } finally {
    await evalIn(
      desktop,
      browserScript((theme) => {
        if (theme) document.documentElement.dataset.theme = theme;
        else delete document.documentElement.dataset.theme;
      }, [previousTheme]),
    );
  }
  const connectionContinued = await evalIn(desktop, () => {
    const continueButton = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')]
      .find((button) => (button.textContent ?? '').trim() === 'Continue');
    if (!(continueButton instanceof HTMLButtonElement) || continueButton.disabled) return false;
    continueButton.click();
    return true;
  });
  expect(connectionContinued).toBe(true);
  await waitFor(desktop, () => (!document.querySelector<HTMLElement>('[role="dialog"]')
    && decodeURIComponent(location.hash).endsWith('/extensions')
    && [...document.querySelectorAll('button')]
      .some((button) => (button.textContent ?? '').trim() === 'Add')), {
    timeoutMs: 20_000,
    label: "Connection handoff closes cleanly without entering a native creation flow",
  });

  const reopenedCleanly = await evalIn(desktop, () => {
    const addButton = [...document.querySelectorAll('button')]
      .find((button) => (button.textContent ?? '').trim() === 'Add');
    if (!(addButton instanceof HTMLButtonElement)) return false;
    addButton.click();
    return true;
  });
  expect(reopenedCleanly).toBe(true);
  await waitFor(desktop, () => (document.querySelectorAll<HTMLElement>('[role="dialog"]').length === 1
    && document.querySelectorAll<HTMLElement>('[data-testid="library-add-choices"]').length === 1), {
    timeoutMs: 20_000,
    label: "clean Library picker state after returning from Den handoff",
  });
  const modalCount = await evalIn(desktop, () => (document.querySelectorAll<HTMLElement>('[role="dialog"]').length));
  expect(modalCount).toBe(1);
  evidence.recordAssertionEvidence(
    "Connection keeps organization context and returns without duplicate modal state",
    `The active bootstrap organization was ${orgId} on ${denWebUrl}; Connection closed without a native creation modal and reopening produced ${modalCount} dialog.`,
    isRecord(bootstrap)
      && bootstrap.activeOrgId === orgId
      && bootstrap.baseUrl === denWebUrl
      && modalCount === 1,
  );
});
