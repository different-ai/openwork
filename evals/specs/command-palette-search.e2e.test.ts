import { expect } from "vitest";
import {
  control,
  evalIn,
  seedSessions,
  waitFor,
} from "@openwork/behaviors";
import { screenshot } from "@openwork/test-evidence";
import {
  app,
  localMysqlIsRunning,
  localRedisIsRunning,
  needs,
  server,
  test,
} from "@openwork/testkit";
import type { App } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const daytonaEnabled = process.env.OPENWORK_EVAL_DAYTONA === "1";
const configuredDen = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const localServicesRequired = !daytonaEnabled && !configuredDen;
const mysqlOpen = await localMysqlIsRunning();
const redisOpen = await localRedisIsRunning();
const runnable = e2eTestsEnabled && (!localServicesRequired || (mysqlOpen && redisOpen));
const skipSuffix = !e2eTestsEnabled
  ? " skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : localServicesRequired && !mysqlOpen
    ? " skipped — needs MySQL on 127.0.0.1:3306"
    : localServicesRequired && !redisOpen
      ? " skipped — needs Redis on 127.0.0.1:6379"
      : "";

interface PaletteFacts {
  firstItemId: string;
  firstItemGroup: string;
  hasActions: boolean;
  hasRecent: boolean;
  hasSessions: boolean;
  hasSettings: boolean;
}

interface RecentFacts {
  itemIds: string[];
  storedIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePaletteFacts(value: unknown): PaletteFacts {
  if (!isRecord(value)) throw new Error(`Invalid palette facts: ${JSON.stringify(value)}`);
  return {
    firstItemId: typeof value.firstItemId === "string" ? value.firstItemId : "",
    firstItemGroup: typeof value.firstItemGroup === "string" ? value.firstItemGroup : "",
    hasActions: value.hasActions === true,
    hasRecent: value.hasRecent === true,
    hasSessions: value.hasSessions === true,
    hasSettings: value.hasSettings === true,
  };
}

function parseRecentFacts(value: unknown): RecentFacts {
  if (!isRecord(value)) throw new Error(`Invalid recent facts: ${JSON.stringify(value)}`);
  const itemIds = Array.isArray(value.itemIds)
    ? value.itemIds.filter((item): item is string => typeof item === "string")
    : [];
  const storedIds = Array.isArray(value.storedIds)
    ? value.storedIds.filter((item): item is string => typeof item === "string")
    : [];
  return { itemIds, storedIds };
}

async function setPaletteQuery(
  appSurface: App,
  text: string,
  expectedCondition: string,
  label: string,
): Promise<void> {
  const changed = await evalIn(appSurface, `(() => {
    const input = document.querySelector("input[data-command-palette-input]");
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return Boolean(setter);
  })()`);
  expect(changed).toBe(true);

  try {
    await waitFor(appSurface, expectedCondition, { timeoutMs: 15_000, label });
  } catch {
    const fallbackChanged = await evalIn(appSurface, `(() => {
      const input = document.querySelector("input[data-command-palette-input]");
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) return false;
      input.focus();
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      let value = "";
      for (const character of ${JSON.stringify(text)}) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: character, bubbles: true, cancelable: true }));
        value += character;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return true;
    })()`);
    expect(fallbackChanged).toBe(true);
    await waitFor(appSurface, expectedCondition, { timeoutMs: 15_000, label: `${label} after key fallback` });
  }
}

async function readPaletteFacts(appSurface: App): Promise<PaletteFacts> {
  return parsePaletteFacts(await evalIn(appSurface, `(() => {
    const firstItem = document.querySelector("[data-command-palette-item]");
    return {
      firstItemId: firstItem?.getAttribute("data-command-palette-item") ?? "",
      firstItemGroup: firstItem?.closest("[data-command-palette-group]")?.getAttribute("data-command-palette-group") ?? "",
      hasActions: Boolean(document.querySelector('[data-command-palette-group="actions"]')),
      hasRecent: Boolean(document.querySelector('[data-command-palette-group="recent"]')),
      hasSessions: Boolean(document.querySelector('[data-command-palette-group="sessions"]')),
      hasSettings: Boolean(document.querySelector('[data-command-palette-group="settings"]')),
    };
  })()`));
}

test.skipIf(!runnable)(
  `command palette searches settings and sessions, records recents, and filters actions${skipSuffix}`,
  { timeout: 8 * 60_000 },
  async ({ place }) => {
    needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
    const runId = `${Date.now().toString(36)}-${process.pid}`;

    await using den = await server({
      place,
      org: {
        name: "Command Palette Search",
        admin: { name: "Palette Admin" },
        members: { member: { name: "Palette Member" } },
      },
    });
    await using desktopApp = await app({ den, as: "admin", place });

    const [seeded] = await seedSessions(desktopApp, [`Palette Probe ${runId}`]);
    const workspaceId = desktopApp.workspaceId;
    if (!workspaceId) throw new Error("The command palette search world did not resolve a workspace.");

    const sessionHashValue = await evalIn(desktopApp, "window.location.hash");
    if (typeof sessionHashValue !== "string") {
      throw new Error(`Invalid session hash: ${JSON.stringify(sessionHashValue)}`);
    }
    const sessionHash = sessionHashValue;
    expect(sessionHash).toContain(workspaceId);

    await control(desktopApp, "command_palette.open");
    await waitFor(desktopApp, `Boolean(document.querySelector("input[data-command-palette-input]"))`, {
      timeoutMs: 15_000,
      label: "command palette opens from the session route",
    });

    const emptyFacts = await readPaletteFacts(desktopApp);
    expect(emptyFacts.hasActions).toBe(true);
    expect(emptyFacts.hasRecent).toBe(false);

    const sessionItemId = `session:${workspaceId}:${seeded.sessionId}`;
    await setPaletteQuery(
      desktopApp,
      "Palette Probe",
      `(() => {
        const first = document.querySelector("[data-command-palette-item]");
        return first?.getAttribute("data-command-palette-item") === ${JSON.stringify(sessionItemId)}
          && first?.closest("[data-command-palette-group]")?.getAttribute("data-command-palette-group") === "sessions";
      })()`,
      "renamed session ranks first in the sessions group",
    );
    const sessionFacts = await readPaletteFacts(desktopApp);
    expect(sessionFacts.firstItemId).toBe(sessionItemId);
    expect(sessionFacts.firstItemGroup).toBe("sessions");

    await setPaletteQuery(
      desktopApp,
      "folders",
      `(() => {
        const first = document.querySelector("[data-command-palette-item]");
        return first?.getAttribute("data-command-palette-item") === "settings:permissions"
          && !document.querySelector('[data-command-palette-group="sessions"]');
      })()`,
      "authorized folders alias ranks permissions first without session results",
    );
    const foldersFacts = await readPaletteFacts(desktopApp);
    expect(foldersFacts.firstItemId).toBe("settings:permissions");
    expect(foldersFacts.firstItemId).not.toBe("settings:preferences");
    expect(foldersFacts.hasSessions).toBe(false);
    await screenshot(desktopApp);

    const clicked = await evalIn(desktopApp, `(() => {
      const first = document.querySelector("[data-command-palette-item]");
      if (!(first instanceof HTMLElement)) return false;
      first.click();
      return true;
    })()`);
    expect(clicked).toBe(true);
    await waitFor(desktopApp, `window.location.hash.endsWith("/settings/permissions")`, {
      timeoutMs: 15_000,
      label: "permissions result navigates to permissions settings",
    });
    const permissionsHashValue = await evalIn(desktopApp, "window.location.hash");
    if (typeof permissionsHashValue !== "string") {
      throw new Error(`Invalid permissions hash: ${JSON.stringify(permissionsHashValue)}`);
    }
    expect(permissionsHashValue).toContain(workspaceId);
    expect(permissionsHashValue).toMatch(/\/settings\/permissions$/);
    expect(permissionsHashValue).not.toMatch(/\/settings\/general$/);

    await evalIn(desktopApp, `(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        metaKey: true,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
      return true;
    })()`);
    await waitFor(desktopApp, `Boolean(document.querySelector("input[data-command-palette-input]"))`, {
      timeoutMs: 15_000,
      label: "command palette opens by keyboard from settings",
    });
    await waitFor(desktopApp, `(() => {
      const group = document.querySelector('[data-command-palette-group="recent"]');
      return group?.querySelectorAll("[data-command-palette-item]").length === 1
        && Boolean(group.querySelector('[data-command-palette-item="settings:permissions"]'));
    })()`, { timeoutMs: 15_000, label: "permissions appears as the sole recent item" });

    const recentFacts = parseRecentFacts(await evalIn(desktopApp, `(() => {
      const group = document.querySelector('[data-command-palette-group="recent"]');
      let storedIds = [];
      try {
        const parsed = JSON.parse(localStorage.getItem("openwork.react.command-palette.recents") ?? "[]");
        storedIds = Array.isArray(parsed) ? parsed : [];
      } catch {
        storedIds = [];
      }
      return {
        itemIds: Array.from(group?.querySelectorAll("[data-command-palette-item]") ?? [])
          .map((item) => item.getAttribute("data-command-palette-item") ?? ""),
        storedIds,
      };
    })()`));
    expect(recentFacts.itemIds).toEqual(["settings:permissions"]);
    expect(recentFacts.itemIds).not.toContain("settings:appearance");
    expect(recentFacts.storedIds[0]).toBe("settings:permissions");

    await setPaletteQuery(
      desktopApp,
      "dark mode",
      `document.querySelector("[data-command-palette-item]")?.getAttribute("data-command-palette-item") === "settings:appearance"`,
      "dark mode alias ranks appearance first",
    );
    const appearanceFacts = await readPaletteFacts(desktopApp);
    expect(appearanceFacts.firstItemId).toBe("settings:appearance");

    await setPaletteQuery(
      desktopApp,
      ">",
      `!document.querySelector('[data-command-palette-group="settings"]')
        && Boolean(document.querySelector('[data-command-palette-group="actions"]'))`,
      "greater-than query restricts results to actions",
    );
    const actionFacts = await readPaletteFacts(desktopApp);
    expect(actionFacts.hasSettings).toBe(false);
    expect(actionFacts.hasActions).toBe(true);

    await evalIn(desktopApp, `(() => {
      const input = document.querySelector("input[data-command-palette-input]");
      if (!(input instanceof HTMLInputElement)) return false;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      return true;
    })()`);
    await waitFor(desktopApp, `!document.querySelector("input[data-command-palette-input]")`, {
      timeoutMs: 15_000,
      label: "Escape closes the command palette",
    });
    const finalHashValue = await evalIn(desktopApp, "window.location.hash");
    if (typeof finalHashValue !== "string") {
      throw new Error(`Invalid final hash: ${JSON.stringify(finalHashValue)}`);
    }
    expect(finalHashValue).toMatch(/\/settings\/permissions$/);
    expect(finalHashValue).toContain(workspaceId);
  },
);
