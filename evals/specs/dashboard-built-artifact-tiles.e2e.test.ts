import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appTitle, mcpAppServersChat } from "../worlds/mcp-app-servers.ts";

// The personal dashboard matches Library: Add lives in the titlebar, the page
// has no heading of its own, an artifact tile has no header bar, and Refresh,
// Share and Remove sit in the tile's hover menu. The world builds one App the
// owner can open, so the dashboard starts empty and the owner adds it.
const test = spec.world(mcpAppServersChat, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun", "pnpm", "opencode"] }, timeout: 600_000,
});

const emptyHeading = "Pin the artifacts you check every day";
const emptyDescription = "Add artifacts your team shared with you, or ones you made. They stay live, so you never open a chat to see the numbers.";
const tiles = '[data-dashboard-tile^="personal:"]';

test("the personal dashboard keeps Add in the titlebar and each artifact's actions in its tile menu", async ({ world, user, probe, step, evidence }) => {
  let frame: Awaited<ReturnType<typeof world.appFrame>> | undefined;
  await using _openFrame = { [Symbol.asyncDispose]: async () => { await frame?.[Symbol.asyncDispose](); } };
  const pageControls = async () => (await probe.dom("[data-dashboard-page] button")).elements.map(element => element.text.trim());

  await step("an empty dashboard invites the first artifact, with Add in the titlebar", async () => {
    await user.click({ role: "button", label: "Dashboard" });
    await user.see({ role: "heading", label: emptyHeading }, { timeoutMs: 60_000 });
    await user.see({ text: emptyDescription });
    await user.see({ role: "button", label: "Add an artifact" });
    await user.see({ role: "button", label: "Add to dashboard" });
    const headings = (await probe.dom("[data-dashboard-page] h1")).elements;
    const controls = await pageControls();
    expect(headings).toHaveLength(0);
    expect(controls).not.toContain("Add to dashboard");
    expect((await probe.dom(tiles)).elements).toHaveLength(0);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "The empty dashboard has one title and its Add control sits in the titlebar",
      `The page shows "${emptyHeading}", its description, and an "Add an artifact" button. The page has ${headings.length} h1 headings, so "Your dashboard" appears only in the titlebar. "Add to dashboard" is visible and is not among the page's own buttons (${JSON.stringify(controls)}).`,
      headings.length === 0 && !controls.includes("Add to dashboard"),
    );
  });

  await step("adding an artifact shows it as a tile without a header bar", async () => {
    await user.click({ role: "button", label: "Add an artifact" });
    await user.see({ label: "Search artifacts" });
    await user.type({ label: "Search artifacts" }, "order calc", { replace: true });
    await user.click({ role: "option", label: `Add ${appTitle}` });
    await probe.eventually(async () => (await probe.dom(tiles)).elements.length, { within: 30_000, label: "one personal tile", until: count => count === 1 });
    frame = await world.appFrame(appTitle);
    await user.on(frame).see({ role: "heading", label: appTitle }, { timeoutMs: 90_000 });
    await user.notSee({ role: "heading", label: emptyHeading });
    const tileShare = (await probe.dom(`${tiles} [aria-label="Share ${appTitle}"]`)).elements;
    const tileText = (await probe.dom(tiles)).elements.map(element => element.text).join(" ");
    expect(tileShare).toHaveLength(0);
    expect(tileText).not.toMatch(/Updated/);
    await user.see({ role: "button", label: `Artifact options for ${appTitle}` });
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "An added artifact renders as a plain tile with only a hover menu",
      `After adding ${appTitle}, one personal tile opens the real App. The tile has no Share button and no "Updated" status of its own, only the "Artifact options for ${appTitle}" menu.`,
      tileShare.length === 0 && !/Updated/.test(tileText),
    );
  });

  await step("the tile menu holds Refresh, Share and Remove from dashboard", async () => {
    await user.click({ role: "button", label: `Artifact options for ${appTitle}` });
    await user.see({ role: "menuitem", label: `Refresh ${appTitle}` });
    await user.see({ role: "menuitem", label: `Share ${appTitle}` });
    await user.see({ role: "menuitem", label: `Remove ${appTitle} from dashboard` });
    await user.screenshot();
    await user.click({ role: "menuitem", label: `Share ${appTitle}` });
    await user.see({ role: "heading", label: `Share ${appTitle}` });
    await user.see({ text: "Who can use it" }, { timeoutMs: 15_000 });
    // Wait out the dialog's fade-in so the screenshot shows it as people see it.
    await probe.eventually(() => probe.eval(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog ? getComputedStyle(dialog).opacity : null;
    }), { within: 5_000, label: "share dialog fully shown", until: opacity => opacity === "1" });
    await user.screenshot();
    await user.press("Escape");
    await user.notSee({ role: "heading", label: `Share ${appTitle}` });
  });
  evidence.recordAssertionEvidence(
    "Sharing moved into the tile menu and still opens the share dialog",
    `The tile menu lists Refresh, Share and Remove from dashboard. Choosing Share opens the "Share ${appTitle}" dialog, and Escape closes it.`,
    true,
  );

  await step("removing the only artifact brings back the empty state, and Undo restores it", async () => {
    await frame?.[Symbol.asyncDispose]();
    frame = undefined;
    await user.click({ role: "button", label: `Artifact options for ${appTitle}` });
    await user.click({ role: "menuitem", label: `Remove ${appTitle} from dashboard` });
    await user.see({ role: "heading", label: emptyHeading }, { timeoutMs: 15_000 });
    expect((await probe.dom(tiles)).elements).toHaveLength(0);
    await user.see({ text: `Removed ${appTitle}` });
    await user.see({ role: "button", label: "Undo" });
    await user.screenshot();
    await user.click({ role: "button", label: "Undo" });
    await probe.eventually(async () => (await probe.dom(tiles)).elements.length, { within: 15_000, label: "tile restored by Undo", until: count => count === 1 });
    await user.notSee({ role: "heading", label: emptyHeading });
    frame = await world.appFrame(appTitle);
    await user.on(frame).see({ role: "heading", label: appTitle }, { timeoutMs: 90_000 });
    await user.screenshot();
  });
  evidence.recordAssertionEvidence(
    "Remove and Undo only change placement",
    `Removing ${appTitle} from its menu emptied the dashboard and showed "${emptyHeading}" again. Undo put the same tile back and it reopened the App.`,
    true,
  );
});
