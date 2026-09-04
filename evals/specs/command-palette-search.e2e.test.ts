import { expect } from "vitest";
import { spec, type Probe } from "@openwork/testkit";
import { commandPaletteSearch } from "../worlds/session-shell.ts";

const test = spec.world(commandPaletteSearch);
const paletteInput = { placeholder: "Search actions, settings, and sessions…" };
const paletteShortcut = process.platform === "darwin" ? "Meta+K" : "Control+K";

interface PaletteState {
  firstItemId: string;
  hasActions: boolean;
  hasPermissions: boolean;
  hasRecent: boolean;
  hasSessions: boolean;
  hasSettings: boolean;
  recentIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function paletteState(probe: Probe): Promise<PaletteState> {
  // TODO(primitive): probe.palette should expose command-palette groups and item order.
  const value = await probe.eval(`(() => {
    const firstItem = document.querySelector("[data-command-palette-item]");
    const recent = document.querySelector('[data-command-palette-group="recent"]');
    return {
      firstItemId: firstItem?.getAttribute("data-command-palette-item") ?? "",
      hasActions: Boolean(document.querySelector('[data-command-palette-group="actions"]')),
      hasPermissions: Boolean(document.querySelector('[data-command-palette-item="settings:permissions"]')),
      hasRecent: Boolean(recent),
      hasSessions: Boolean(document.querySelector('[data-command-palette-group="sessions"]')),
      hasSettings: Boolean(document.querySelector('[data-command-palette-group="settings"]')),
      recentIds: Array.from(recent?.querySelectorAll("[data-command-palette-item]") ?? [])
        .map((item) => item.getAttribute("data-command-palette-item") ?? ""),
    };
  })()`);
  if (!isRecord(value)) throw new Error(`Invalid command palette state: ${JSON.stringify(value)}`);
  return {
    firstItemId: typeof value.firstItemId === "string" ? value.firstItemId : "",
    hasActions: value.hasActions === true,
    hasPermissions: value.hasPermissions === true,
    hasRecent: value.hasRecent === true,
    hasSessions: value.hasSessions === true,
    hasSettings: value.hasSettings === true,
    recentIds: stringArray(value.recentIds),
  };
}

test("command palette searches settings by alias, navigates, records recents, and filters actions", async ({ world, user, probe, step }) => {
  const workspaceId = world.workspace.workspaceId;

  await step("the empty palette offers actions and settings without recents", async () => {
    expect(await probe.hash()).toContain(workspaceId);
    await user.press(paletteShortcut);
    await user.see(paletteInput);
    const empty = await probe.eventually(() => paletteState(probe), {
      within: 15_000,
      label: "empty command palette groups",
      until: (state) => state.hasActions && state.hasSettings && state.hasPermissions,
    });
    expect(empty.hasRecent).toBe(false);
    await user.screenshot();
  });

  await step("folders ranks Permissions first and excludes sessions", async () => {
    await user.type(paletteInput, "folders", { replace: true });
    const folders = await probe.eventually(() => paletteState(probe), {
      within: 15_000,
      label: "authorized folders alias ranks Permissions first",
      until: (state) => state.firstItemId === "settings:permissions" && !state.hasSessions,
    });
    expect(folders.firstItemId).toBe("settings:permissions");
    expect(folders.firstItemId).not.toBe("settings:preferences");
    expect(folders.hasSessions).toBe(false);
    await user.screenshot();
  });

  await step("choosing Permissions navigates within the current workspace", async () => {
    await user.click({ role: "option", label: /permissions/i });
    const hash = await probe.eventually(() => probe.hash(), {
      within: 15_000,
      label: "Permissions settings route",
      until: (value) => value.endsWith("/settings/permissions"),
    });
    expect(hash).toContain(workspaceId);
    expect(hash).toMatch(/\/settings\/permissions$/);
    expect(hash).not.toMatch(/\/settings\/general$/);
  });

  await step("reopening the palette shows Permissions as the sole recent item", async () => {
    await user.see({ text: /Authorized folders/ });
    // Settings closes route-owned overlays just after its content appears; let that
    // transition settle so it does not immediately close the newly opened palette.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await user.press(paletteShortcut);
    await user.see(paletteInput);
    const recent = await probe.eventually(() => paletteState(probe), {
      within: 15_000,
      label: "Permissions is the sole recent command",
      until: (state) => state.recentIds.length === 1 && state.recentIds[0] === "settings:permissions",
    });
    expect(recent.hasRecent).toBe(true);
    expect(recent.recentIds).toEqual(["settings:permissions"]);
    expect(recent.recentIds).not.toContain("settings:appearance");
    const storedRecents = stringArray(await probe.storage("openwork.react.command-palette.recents"));
    expect(storedRecents[0]).toBe("settings:permissions");
    await user.screenshot();
  });

  await step("dark mode ranks Appearance first", async () => {
    await user.type(paletteInput, "dark mode", { replace: true });
    const appearance = await probe.eventually(() => paletteState(probe), {
      within: 15_000,
      label: "dark mode alias ranks Appearance first",
      until: (state) => state.firstItemId === "settings:appearance",
    });
    expect(appearance.firstItemId).toBe("settings:appearance");
    await user.screenshot();
  });

  await step("> restricts the palette to actions", async () => {
    await user.type(paletteInput, ">", { replace: true });
    const actionsOnly = await probe.eventually(() => paletteState(probe), {
      within: 15_000,
      label: "greater-than query restricts results to actions",
      until: (state) => state.hasActions && !state.hasSettings,
    });
    expect(actionsOnly.hasActions).toBe(true);
    expect(actionsOnly.hasSettings).toBe(false);
    await user.screenshot();
  });

  await step("Escape closes the palette without navigating", async () => {
    await user.press("Escape");
    // TODO(primitive): user.notSee should be able to wait for a dialog's exit transition.
    await probe.eventually(() => probe.eval(`Boolean(document.querySelector("input[data-command-palette-input]"))`), {
      within: 15_000,
      label: "palette closes after Escape",
      until: (open) => open === false,
    });
    await user.notSee(paletteInput);
    const hash = await probe.hash();
    expect(hash).toContain(workspaceId);
    expect(hash).toMatch(/\/settings\/permissions$/);
  });
});
