import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { adminDashboardWeb } from "../worlds/den-admin-navigation.ts";

// cmdk group headings render with CSS `uppercase`; the rendered text is what
// people see, so the witnesses are the uppercase headings.
const test = spec.world(adminDashboardWeb, { timeout: 420_000 });
const paletteInput = { testId: "den-command-palette-input" };
const palette = { testId: "den-command-palette" };
const paletteShortcut = process.platform === "darwin" ? "Meta+K" : "Control+K";

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

test("the Den command palette searches pages, navigates, and records recents", async ({ world, user, probe, evidence, step }) => {
  await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
  await user.see({ text: /Download for this workspace/ }, { timeoutMs: 90_000 });
  // The dashboard shell remounts while its data loads; let that transition settle before interacting.
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  await step("the Den header shows a search bar and the palette is closed", async () => {
    await user.see({ testId: "den-command-palette-trigger" });
    await probe.eventually(() => probe.has("↵ open"), {
      within: 15_000,
      label: "command palette starts closed",
      until: (open) => !open,
    });
    await user.notSee(palette);
    await user.screenshot();
  });

  await step("clicking the search bar opens the palette with pages", async () => {
    await user.click({ testId: "den-command-palette-trigger" });
    await user.see(paletteInput);
    await user.see({ text: "PAGES" });
    await user.see({ role: "option", label: /^Connectors/ });
    await user.notSee({ text: "RECENT" });
    await user.screenshot();
  });

  await step("typing an alias and Enter navigates", async () => {
    await user.type(paletteInput, "mcp", { replace: true });
    await user.see({ role: "option", label: /^Connectors/ });
    await user.press("Enter");
    const path = await probe.eventually(() => world.location(), {
      within: 30_000,
      label: "Connectors route",
      until: (location) => location === "/dashboard/mcp-connections",
    });
    await probe.eventually(() => probe.has("↵ open"), {
      within: 15_000,
      label: "command palette closes after navigation",
      until: (open) => !open,
    });
    await user.notSee(palette);
    expect(path).toBe("/dashboard/mcp-connections");
    await user.see({ text: /Connectors is where you can add MCP servers/ }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("The mcp alias opens the Connectors page and closes the palette", `path=${path}; palette closed`, path === "/dashboard/mcp-connections");
    await user.screenshot();
  });

  await step("the keyboard shortcut reopens it with Connectors under Recent", async () => {
    await user.press(paletteShortcut);
    await user.see(paletteInput);
    await user.see({ text: "RECENT" });
    await user.see({ role: "option", label: /^Connectors/ });
    const storedRecents = stringArray(await probe.storage("den.command-palette.recents"));
    expect(storedRecents).toEqual(["page:Manage:Connectors"]);
    evidence.recordAssertionEvidence("The keyboard shortcut reopens the palette with Connectors as the sole recent page", `recents=${JSON.stringify(storedRecents)}`, storedRecents.length === 1 && storedRecents[0] === "page:Manage:Connectors");
    await user.screenshot();
  });

  await step("the Members page is one keystroke away and Escape closes", async () => {
    await user.type(paletteInput, "members", { replace: true });
    await user.see({ role: "option", label: /^Members/ });
    await user.see({ text: "PAGES" });
    await user.press("Escape");
    await probe.eventually(() => probe.has("↵ open"), {
      within: 15_000,
      label: "command palette footer disappears",
      until: (open) => !open,
    });
    await user.notSee(palette);
    const path = await world.location();
    expect(path).toBe("/dashboard/mcp-connections");
    evidence.recordAssertionEvidence("Escape closes Members page search without leaving Connectors", `path=${path}; palette closed`, path === "/dashboard/mcp-connections");
    await user.screenshot();
  });
});
