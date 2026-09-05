import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { commandPaletteSearch } from "../worlds/session-shell.ts";

const test = spec.world(commandPaletteSearch);
const paletteInput = { placeholder: "Search actions, settings, and sessions…" };

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

test("command palette searches settings by alias, navigates, records recents, and filters actions", async ({ world, user, probe, step }) => {
  const workspaceId = world.workspace.workspaceId;
  const macPlatform = await probe.eval(`/Mac|iPhone|iPad|iPod/.test(navigator.platform)`);
  const paletteShortcut = macPlatform ? "Meta+K" : "Control+K";

  await step("the empty palette offers actions and settings without recents", async () => {
    expect(await probe.hash()).toContain(workspaceId);
    await user.press(paletteShortcut);
    await user.see(paletteInput);
    await user.see({ text: "Actions" });
    await user.see({ role: "option", label: /^Permissions/ });
    await user.notSee({ text: "Recent" });
    await user.notSee({ role: "option", label: /^Experimental engine/ });
    await user.screenshot();
  });

  await step("folders ranks Permissions first and Enter navigates there", async () => {
    await user.type(paletteInput, "folders", { replace: true });
    await user.see({ role: "option", label: /^Permissions/ });
    await user.notSee({ text: "Sessions" });
    await user.screenshot();
    await user.press("Enter");
    const hash = await probe.eventually(() => probe.hash(), {
      within: 15_000,
      label: "Permissions settings route",
      until: (value) => value.endsWith("/settings/permissions"),
    });
    expect(hash).toContain(workspaceId);
    expect(hash).toMatch(/\/settings\/permissions$/);
    expect(hash).not.toMatch(/\/settings\/general$/);
    expect(hash).not.toMatch(/\/settings\/preferences$/);
  });

  await step("reopening the palette shows Permissions as the sole recent item", async () => {
    await user.see({ text: /Authorized folders/ });
    // Settings closes route-owned overlays just after its content appears; let that
    // transition settle so it does not immediately close the newly opened palette.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await user.press(paletteShortcut);
    await user.see(paletteInput);
    await user.see({ text: "Recent" });
    await user.see({ role: "option", label: /^Permissions/ });
    const storedRecents = stringArray(await probe.storage("openwork.react.command-palette.recents"));
    expect(storedRecents).toEqual(["settings:permissions"]);
    expect(storedRecents).not.toContain("settings:appearance");
    await user.screenshot();
  });

  await step("dark mode ranks Appearance first and Enter navigates there", async () => {
    await user.type(paletteInput, "dark mode", { replace: true });
    await user.see({ role: "option", label: /^Appearance/ });
    await user.screenshot();
    await user.press("Enter");
    const hash = await probe.eventually(() => probe.hash(), {
      within: 15_000,
      label: "Appearance settings route",
      until: (value) => value.endsWith("/settings/appearance"),
    });
    expect(hash).toContain(workspaceId);
    expect(hash).toMatch(/\/settings\/appearance$/);
    expect(hash).not.toMatch(/\/settings\/permissions$/);
    await probe.eventually(() => probe.has("Arrow keys to navigate"), {
      within: 15_000,
      label: "command palette closes after choosing Appearance",
      until: (open) => !open,
    });
  });

  await step("> restricts the palette to actions", async () => {
    await user.see({ text: /Adjust how OpenWork looks/ });
    // Settings closes route-owned overlays just after navigation; let that
    // transition settle before reopening the palette.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await user.press(paletteShortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, ">", { replace: true });
    await user.see({ role: "option", label: /^Toggle sidebar/ });
    await user.notSee({ role: "option", label: /^Appearance/ });
    await user.notSee({ role: "option", label: /^Permissions/ });
    await user.screenshot();
  });

  await step("Escape closes the palette without navigating", async () => {
    await user.press("Escape");
    await probe.eventually(() => probe.has("Arrow keys to navigate"), {
      within: 15_000,
      label: "command palette footer disappears",
      until: (open) => !open,
    });
    await user.notSee(paletteInput);
    const hash = await probe.hash();
    expect(hash).toContain(workspaceId);
    expect(hash).toMatch(/\/settings\/appearance$/);
  });

  await step("developer mode surfaces Advanced sections without a search", async () => {
    await user.press(paletteShortcut);
    await user.type(paletteInput, "Enable Developer Mode", { replace: true });
    await user.click({ role: "option", label: /^Enable Developer Mode/ });
    await user.press(paletteShortcut);
    await user.see({ role: "option", label: /^Organization server/ });
    await user.see({ role: "option", label: /^Runtime/ });
    await user.see({ role: "option", label: /^Agent access diagnostics/ });
    await user.see({ role: "option", label: /^OpenCode config sources/ });
    await user.see({ role: "option", label: /^Experimental engine/ });
    await user.see({ role: "option", label: /^Developer/ });
    await user.screenshot();
    await user.type(paletteInput, "Disable Developer Mode", { replace: true });
    await user.click({ role: "option", label: /^Disable Developer Mode/ });
    await user.notSee(paletteInput);
  });

  for (const section of [
    { query: "server url", title: "Organization server", id: "organization-server" },
    { query: "connection status", title: "Runtime", id: "runtime" },
    { query: "cloud mcp", title: "Agent access diagnostics", id: "agent-access" },
    { query: "config sources", title: "OpenCode config sources", id: "config-sources" },
    { query: "chat engine", title: "Experimental engine", id: "experimental-engine" },
    { query: "deep link", title: "Developer", id: "developer" },
  ]) {
    await step(`Command+K jumps directly to ${section.title}`, async () => {
      await user.press(paletteShortcut);
      await user.type(paletteInput, section.query, { replace: true });
      await user.notSee({
        role: "option",
        label: section.id === "experimental-engine" ? /^Organization server/ : /^Experimental engine/,
      });
      await user.click({ role: "option", label: new RegExp(`^${section.title}`) });
      await probe.eventually(() => probe.hash(), {
        within: 15_000,
        label: `${section.title} section route`,
        until: (value) => value.endsWith(`/settings/advanced/${section.id}`),
      });
      expect(await probe.eventually(() => probe.eval(`(id) => {
        const section = document.getElementById(id);
        const heading = section?.querySelector("h3");
        const bounds = heading?.getBoundingClientRect();
        return document.activeElement === section && !!bounds && bounds.top >= 0 && bounds.bottom <= innerHeight;
      }`, { args: [`advanced-${section.id}`] }), {
        within: 15_000,
        label: `${section.title} is focused and in view`,
        until: (value) => value === true,
      })).toBe(true);
      await user.notSee(paletteInput);
    });
  }



});
