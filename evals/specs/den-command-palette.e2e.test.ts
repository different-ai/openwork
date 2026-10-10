import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denCommandPalette, type PaletteTextAppearance } from "../worlds/den-command-palette.ts";

const test = spec.world(denCommandPalette, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 420_000,
});
const paletteInput = { testId: "den-command-palette-input" };
const palette = { testId: "den-command-palette" };
const footer = { testId: "den-command-palette-footer" };
const paletteSelector = '[data-testid="den-command-palette"]';
const footerSelector = '[data-testid="den-command-palette-footer"]';
const footerText = "↑↓ navigate · ↵ open · esc close";
const unmatchedQuery = "no-such-page";
const noMatchesText = `No matches for “${unmatchedQuery}”.`;

type Bounds = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const inside = (inner: Bounds, outer: Bounds) => inner.width > 0 && inner.height > 0 && inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;
const boundsLine = (rect: Bounds) => `${Math.round(rect.left)},${Math.round(rect.top)} to ${Math.round(rect.right)},${Math.round(rect.bottom)}`;
const untracked = (text: PaletteTextAppearance) => text.letterSpacing === "normal" || Number.parseFloat(text.letterSpacing ?? "") === 0;
const appearanceLine = (name: string, text: PaletteTextAppearance) => `${name} ${text.fontSize}px, ${text.foreground} on ${text.background} = ${text.contrast.toFixed(2)}:1`;

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

test("a Den admin reads page search, navigates with an alias, and dismisses empty searches on small screens", async ({ world, user, probe, evidence, step }) => {
  const openShortcut = world.web.handle.hostKind !== "daytona" && process.platform === "darwin" ? "Meta+K" : "Control+K";
  const element = async (selector: string) => {
    const snapshot = await probe.dom(selector);
    const first = snapshot.elements[0];
    if (!first) throw new Error(`Missing command palette element: ${selector}`);
    return first;
  };

  await step("before search: the admin sees the search bar without an open palette or recent pages", async () => {
    await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
    await user.see({ testId: "den-download-openwork", label: "Download OpenWork" }, { timeoutMs: 90_000 });
    await user.see({ testId: "den-command-palette-trigger" });
    await probe.eventually(() => probe.has("↵ open"), {
      within: 15_000,
      label: "command palette starts closed",
      until: (open) => !open,
    });
    await user.notSee(palette);
    const recents = stringArray(await probe.storage("den.command-palette.recents"));
    const path = await world.location();
    expect(recents).toEqual([]);
    expect(path).toBe("/dashboard");
    evidence.recordAssertionEvidence("The admin starts on the dashboard with the palette closed and no recent pages", `path=${path}; recents=${JSON.stringify(recents)}; palette closed`, path === "/dashboard" && recents.length === 0);
    await user.screenshot();
  });

  await step("after opening search: Pages, page hints, and keyboard chords are readable without uppercase headings", async () => {
    await user.click({ testId: "den-command-palette-trigger" });
    await user.see(paletteInput);
    await user.see({ text: "Pages" });
    await user.see({ role: "option", label: /^Connectors/ });
    await user.notSee({ text: "Recent" });
    await user.see(footer, { text: footerText });
    const heading = await world.textAppearance("heading");
    const hint = await world.textAppearance("hint");
    const selectedHint = await world.textAppearance("selectedHint");
    const chords = await world.textAppearance("footer");
    const readable = [heading, hint, selectedHint, chords].every((text) => text.contrast >= 4.5 && text.fontSize >= 11 && untracked(text)) && heading.textTransform === "none";
    expect((await element(`${paletteSelector} [cmdk-group-heading]`)).text).toBe("Pages");
    evidence.recordAssertionEvidence("Pages and both normal and selected page hints meet readable text contrast", `${appearanceLine("Pages", heading)}; ${appearanceLine("hint", hint)}; ${appearanceLine("selected hint", selectedHint)}; ${appearanceLine("chords", chords)}; heading transform=${heading.textTransform}, tracking=${heading.letterSpacing}`, readable);
    await user.screenshot();
    expect(readable).toBe(true);
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
    await user.see({ role: "heading", label: "Connectors" }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("The mcp alias opens the Connectors page and closes the palette", `path=${path}; palette closed`, path === "/dashboard/mcp-connections");
    await user.screenshot();
  });

  await step("the keyboard shortcut reopens it with Connectors under Recent", async () => {
    await user.press(openShortcut);
    await user.see(paletteInput);
    await user.see({ text: "Recent" });
    await user.see({ role: "option", label: /^Connectors/ });
    const storedRecents = stringArray(await probe.storage("den.command-palette.recents"));
    const heading = await world.textAppearance("heading");
    const sentenceCase = heading.textTransform === "none" && untracked(heading) && heading.fontSize >= 11 && heading.contrast >= 4.5;
    expect((await element(`${paletteSelector} [cmdk-group-heading]`)).text).toBe("Recent");
    expect(storedRecents).toEqual(["page:Manage:Connectors"]);
    expect(sentenceCase).toBe(true);
    evidence.recordAssertionEvidence("The keyboard shortcut reopens a readable Recent heading with Connectors as the sole recent page", `recents=${JSON.stringify(storedRecents)}; ${appearanceLine("Recent", heading)}; transform=${heading.textTransform}, tracking=${heading.letterSpacing}`, storedRecents.length === 1 && storedRecents[0] === "page:Manage:Connectors" && sentenceCase);
    await user.screenshot();
  });

  await step("searching Members and pressing Escape leaves the admin on Connectors with the same recent page", async () => {
    const beforeRecents = stringArray(await probe.storage("den.command-palette.recents"));
    await user.type(paletteInput, "members", { replace: true });
    await user.see({ role: "option", label: /^Members/ });
    await user.see({ text: "Pages" });
    await user.press("Escape");
    await probe.eventually(() => probe.has("↵ open"), {
      within: 15_000,
      label: "command palette footer disappears",
      until: (open) => !open,
    });
    await user.notSee(palette);
    const path = await world.location();
    const recents = stringArray(await probe.storage("den.command-palette.recents"));
    expect(path).toBe("/dashboard/mcp-connections");
    expect(recents).toEqual(beforeRecents);
    evidence.recordAssertionEvidence("Escape closes Members search without navigating or recording an unchosen page", `path=${path}; recents=${JSON.stringify(recents)} unchanged; palette closed`, path === "/dashboard/mcp-connections" && JSON.stringify(recents) === JSON.stringify(beforeRecents));
    await user.screenshot();
  });

  await step("after an unmatched search: the admin can read No matches and the keyboard chords without selecting a page", async () => {
    const beforePath = await world.location();
    const beforeRecents = stringArray(await probe.storage("den.command-palette.recents"));
    await user.press(openShortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, unmatchedQuery, { replace: true });
    await user.see({ text: noMatchesText });
    await user.see(footer, { text: footerText });
    await user.notSee({ role: "option" });
    const empty = await world.textAppearance("empty");
    const chords = await world.textAppearance("footer");
    const readable = empty.contrast >= 4.5 && empty.fontSize >= 12 && empty.textNodes === 1 && chords.contrast >= 4.5 && chords.fontSize >= 11;
    expect((await element(`${paletteSelector} [cmdk-empty]`)).text).toBe(noMatchesText);
    await user.screenshot();
    await user.press("Escape");
    await user.notSee(palette);
    const path = await world.location();
    const recents = stringArray(await probe.storage("den.command-palette.recents"));
    const unchanged = path === beforePath && JSON.stringify(recents) === JSON.stringify(beforeRecents);
    expect(path).toBe(beforePath);
    expect(recents).toEqual(beforeRecents);
    evidence.recordAssertionEvidence("The empty result and real keyboard chords are readable, and dismissal does not change navigation or recents", `${appearanceLine("No matches", empty)}; ${appearanceLine("chords", chords)}; empty text nodes=${empty.textNodes}; zero visible options; path=${path}; recents=${JSON.stringify(recents)} unchanged`, readable && unchanged);
    expect(readable).toBe(true);
  });

  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
    await step(`after: on a ${viewport.width}px phone the empty search and keyboard footer fit, and Escape only dismisses them`, async () => {
      const beforePath = await world.location();
      const beforeRecents = stringArray(await probe.storage("den.command-palette.recents"));
      await user.resizeViewport({ ...viewport, deviceScaleFactor: 1 });
      await user.press(openShortcut);
      await user.see(paletteInput);
      await user.see({ text: "Recent" });
      await user.see(footer, { text: footerText });
      const populatedDialog = (await element(paletteSelector)).rect;
      const populatedFooter = (await element(footerSelector)).rect;
      const populatedBounded = populatedDialog.left >= 16 && populatedDialog.right <= viewport.width - 16 && populatedDialog.top >= 0 && populatedDialog.bottom <= viewport.height && inside(populatedFooter, populatedDialog);
      await user.type(paletteInput, unmatchedQuery, { replace: true });
      await user.see({ text: noMatchesText });
      await user.see(footer, { text: footerText });
      await user.notSee({ role: "option" });
      const snapshot = await probe.dom(paletteSelector);
      const dialog = snapshot.elements[0]?.rect;
      if (!dialog) throw new Error("The narrow command palette has not rendered.");
      const input = await element('[data-testid="den-command-palette-input"]');
      const empty = await element(`${paletteSelector} [cmdk-empty]`);
      const chords = await element(footerSelector);
      const emptyText = await world.textAppearance("empty");
      const chordText = await world.textAppearance("footer");
      const readable = emptyText.contrast >= 4.5 && emptyText.fontSize >= 12 && chordText.contrast >= 4.5 && chordText.fontSize >= 11;
      const bounded = populatedBounded && snapshot.viewportWidth === viewport.width && dialog.left >= 16 && dialog.right <= viewport.width - 16 && dialog.top >= 0 && dialog.bottom <= viewport.height && inside(input.rect, dialog) && inside(empty.rect, dialog) && inside(chords.rect, dialog) && input.focused && chords.text === footerText;
      await user.screenshot();
      await user.press("Escape");
      await user.notSee(palette);
      await user.notSee(footer);
      const path = await world.location();
      const recents = stringArray(await probe.storage("den.command-palette.recents"));
      const unchanged = path === beforePath && JSON.stringify(recents) === JSON.stringify(beforeRecents);
      expect(path).toBe(beforePath);
      expect(recents).toEqual(beforeRecents);
      evidence.recordAssertionEvidence("The phone keeps empty search, focused input, and dismissal chords on screen without recording or opening a page", `${viewport.width}×${viewport.height}; populated dialog ${boundsLine(populatedDialog)}, footer ${boundsLine(populatedFooter)}; empty dialog ${boundsLine(dialog)}, footer ${boundsLine(chords.rect)}; input focused=${input.focused}; ${appearanceLine("No matches", emptyText)}; ${appearanceLine("chords", chordText)}; Escape closed palette; path=${path}; recents=${JSON.stringify(recents)} unchanged`, readable && bounded && unchanged);
      expect(readable).toBe(true);
      expect(bounded).toBe(true);
    });
  }
});
