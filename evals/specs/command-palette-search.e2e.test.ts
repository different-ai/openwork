import { browserScript } from "@openwork/testkit";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { commandPaletteSearch } from "../worlds/session-shell.ts";

const test = spec.world(commandPaletteSearch, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: [] },
});
const paletteInput = { placeholder: "Search actions, settings, and sessions…" };

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

test("command palette searches settings by alias, navigates, records recents, and filters actions", async ({ world, user, probe, step, evidence }) => {
  const workspaceId = world.workspace.workspaceId;
  const draft = "Keep this draft while checking Models.";
  const runtime = await world.runtimeFacts();
  expect(runtime.browser).toContain("HeadlessChrome");
  expect(runtime.electronBridge).toBe(false);
  evidence.recordJsonArtifact("command palette web runtime", runtime);
  const macPlatform = await probe.eval(() => (/Mac|iPhone|iPad|iPod/.test(navigator.platform)));
  const paletteShortcut = macPlatform ? "Meta+K" : "Control+K";
  const waitForPaletteClose = () => probe.eventually(() => probe.has("Arrow keys to navigate"), {
    within: 15_000,
    label: "command palette finishes closing",
    until: (open) => !open,
  });

  await user.type("composer", draft);
  const initialComposer = await probe.composer();

  await step("the empty palette offers actions and settings without recents", async () => {
    expect(await world.location()).toContain(workspaceId);
    await user.press(paletteShortcut);
    await user.see(paletteInput);
    await user.see({ text: "Actions" });
    await user.see({ role: "option", label: /^Permissions/ });
    await user.notSee({ text: "Recent" });
    await user.notSee({ role: "option", label: /^Experimental engine/ });
    await user.screenshot();
  });

  await step("Models stays readable beside long selected-model metadata and preserves composer state", async () => {
    await user.type(paletteInput, "models", { replace: true });
    await user.screenshot();
    await user.see({ role: "option", label: /^Models/ });
    const row = await probe.dom('[data-command-palette-item="models"]');
    const label = await probe.dom('[data-command-palette-item="models"] > div:first-child');
    const metadata = await probe.dom('[data-command-palette-item="models"] > [data-slot="command-shortcut"]');
    expect(row.elements).toHaveLength(1);
    expect(label.elements).toHaveLength(1);
    expect(metadata.elements).toHaveLength(1);
    expect(label.elements[0]!.text).toContain("Models");
    expect(label.elements[0]!.rect.width).toBeGreaterThan(80);
    expect(metadata.elements[0]!.rect.height).toBeLessThanOrEqual(20);
    expect(label.elements[0]!.rect.right).toBeLessThanOrEqual(metadata.elements[0]!.rect.left);
    evidence.recordJsonArtifact("Models row geometry", {
      row: row.elements[0],
      label: label.elements[0],
      metadata: metadata.elements[0],
      longModelId: world.longModelId,
    });
    await user.looks([
      "The visible command palette row is clearly labeled Models.",
      "The selected-model metadata is a single unobtrusive trailing line and does not overlap, replace, or garble the Models label.",
    ]);
    await user.press("Enter");
    await user.see({ placeholder: "Search models..." });
    await user.press("Escape");
    await user.see(paletteInput);
    await user.press("Escape");
    await waitForPaletteClose();
    await user.see("composer", { text: draft });
    const currentComposer = await probe.composer();
    expect(currentComposer.selectedModelLabel).toBe(initialComposer.selectedModelLabel);
    expect(currentComposer.draftText).toBe(initialComposer.draftText);
    await user.press(paletteShortcut);
    await user.see(paletteInput);
  });

  await step("folders ranks Permissions first and Enter navigates there", async () => {
    await user.type(paletteInput, "folders", { replace: true });
    await user.see({ role: "option", label: /^Permissions/ });
    await user.notSee({ text: "Sessions" });
    await user.screenshot();
    await user.press("Enter");
    const location = await probe.eventually(() => world.location(), {
      within: 15_000,
      label: "Permissions settings route",
      until: (value) => value.endsWith("/settings/permissions"),
    });
    expect(location).toContain(workspaceId);
    expect(location).toMatch(/\/settings\/permissions$/);
    expect(location).not.toMatch(/\/settings\/general$/);
    expect(location).not.toMatch(/\/settings\/preferences$/);
  });

  await step("reopening the palette shows the chosen Models and Permissions recents", async () => {
    await user.see({ text: /Authorized folders/ });
    // Settings closes route-owned overlays just after its content appears; let that
    // transition settle so it does not immediately close the newly opened palette.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await user.press(paletteShortcut);
    await user.see(paletteInput);
    await user.see({ text: "Recent" });
    await user.see({ role: "option", label: /^Permissions/ });
    await user.see({ role: "option", label: /^Models/ });
    const storedRecents = stringArray(await probe.storage("openwork.react.command-palette.recents"));
    expect(storedRecents).toEqual(["settings:permissions", "models"]);
    expect(storedRecents).not.toContain("settings:appearance");
    await user.screenshot();
  });

  await step("dark mode ranks Appearance first and Enter navigates there", async () => {
    await user.type(paletteInput, "dark mode", { replace: true });
    await user.see({ role: "option", label: /^Appearance/ });
    await user.screenshot();
    await user.press("Enter");
    const location = await probe.eventually(() => world.location(), {
      within: 15_000,
      label: "Appearance settings route",
      until: (value) => value.endsWith("/settings/appearance"),
    });
    expect(location).toContain(workspaceId);
    expect(location).toMatch(/\/settings\/appearance$/);
    expect(location).not.toMatch(/\/settings\/permissions$/);
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
    const location = await world.location();
    expect(location).toContain(workspaceId);
    expect(location).toMatch(/\/settings\/appearance$/);
  });

  await step("developer mode surfaces Advanced sections without a search", async () => {
    await user.press(paletteShortcut);
    await user.type(paletteInput, "Enable Developer Mode", { replace: true });
    await user.click({ role: "option", label: /^Enable Developer Mode/ });
    await waitForPaletteClose();
    await user.press(paletteShortcut);
    await user.see({ role: "option", label: /^Organization server/ });
    await user.see({ role: "option", label: /^Runtime/ });
    await user.see({ role: "option", label: /^Agent access diagnostics/ });
    await user.see({ role: "option", label: /^OpenCode config sources/ });
    await user.see({ role: "option", label: /^Experimental engine/ });
    await user.see({ role: "option", label: /^Workspace run mode/ });
    await user.see({ role: "option", label: /^Developer/ });
    await user.screenshot();
    await user.type(paletteInput, "Disable Developer Mode", { replace: true });
    await user.click({ role: "option", label: /^Disable Developer Mode/ });
    await waitForPaletteClose();
    await user.notSee(paletteInput);
  });

  for (const section of [
    { query: "server url", title: "Organization server", id: "organization-server" },
    { query: "connection status", title: "Runtime", id: "runtime" },
    { query: "cloud mcp", title: "Agent access diagnostics", id: "agent-access" },
    { query: "config sources", title: "OpenCode config sources", id: "config-sources" },
    { query: "chat engine", title: "Experimental engine", id: "experimental-engine" },
    { query: "keep going", title: "Workspace run mode", id: "workspace-run-mode" },
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
      const sectionLocation = await probe.eventually(() => world.location(), {
        within: 15_000,
        label: `${section.title} section route`,
        until: (value) => value.endsWith(`/settings/advanced/${section.id}`),
      });
      expect(sectionLocation).toBe(`/workspace/${workspaceId}/settings/advanced/${section.id}`);
      await waitForPaletteClose();
      expect(await probe.eventually(() => probe.eval(browserScript((id) => {
        const section = document.getElementById(id);
        const heading = section?.querySelector<HTMLElement>("h3");
        const bounds = heading?.getBoundingClientRect();
        return document.activeElement === section && !!bounds && bounds.top >= 0 && bounds.bottom <= innerHeight;
      }, [`advanced-${section.id}`])), {
        within: 15_000,
        label: `${section.title} is focused and in view`,
        until: (value) => value === true,
      })).toBe(true);
      if (section.id === "workspace-run-mode") {
        await user.see({ role: "switch", label: "Show workspace run mode" });
        const readSwitch = () => probe.eval(browserScript(() => {
          const control = document.querySelector<HTMLButtonElement>('[data-testid="workspace-run-mode-flag"]');
          return control ? { disabled: control.disabled, checked: control.getAttribute("aria-checked") } : null;
        }, []));
        const before = await readSwitch();
        expect(before?.disabled).toBe(true);
        await expect(user.click({ role: "switch", label: "Show workspace run mode" })).rejects.toThrow("Refused to click disabled");
        expect(await readSwitch()).toEqual(before);
      }
      await user.notSee(paletteInput);
    });
  }



});
