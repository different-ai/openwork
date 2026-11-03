import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { calmFeed } from "../worlds/calm-feed.ts";

const test = spec.world(calmFeed, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

test("a member keeps workspace chats in place while only ungrouped Feed chats can settle", async ({ world, user, probe, step, evidence }) => {
  const id = world.resting.sessionId;
  const openMenu = async () => {
    await user.hover({ testId: `sidebar-session-${id}` });
    await user.click({ testId: `session-actions-${id}` });
  };

  await step("given an ungrouped Feed chat, the member can settle it", async () => {
    await user.click({ role: "tab", label: "Feed" });
    await user.see({ testId: `sidebar-session-${id}` }, { timeoutMs: 60_000 });
    await openMenu();
    await user.click({ role: "menuitem", label: /^Settle session/ });
    await user.see({ text: "Settled", exact: true });
    const shelf = await probe.dom('[data-feed-shelf="settled"]');
    evidence.recordAssertionEvidence("ungrouped Feed chat settles", `Settled shelves: ${shelf.elements.length}`, shelf.elements.length === 1);
    expect(shelf.elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("after: switching to Workspaces shows the chat normally, with no Settled row or action", async () => {
    await user.click({ role: "tab", label: "Workspaces" });
    await user.see({ testId: `sidebar-session-${id}` });
    await user.notSee({ text: "Settled", exact: true });
    await openMenu();
    await user.notSee({ role: "menuitem", label: /[Ss]ettle session/ });
    const items = await probe.dom('[data-session-menu-settle]');
    evidence.recordAssertionEvidence("Workspaces have no settling", `Settle menu items: ${items.elements.length}; previously settled chat is visible`, items.elements.length === 0);
    expect(items.elements).toHaveLength(0);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("when the member creates a workspace group and files the chat there", async () => {
    await openMenu();
    await user.hover({ role: "menuitem", label: "Move to group" });
    await user.click({ role: "menuitem", label: "No groups yet" });
    await user.type({ role: "textbox", placeholder: "Name this group (e.g. Done, In progress):" }, "Project notes");
    await user.click({ role: "button", label: "Save" });
    await openMenu();
    await user.hover({ role: "menuitem", label: "Move to group" });
    await user.click({ role: "menuitem", label: "Project notes" });
    await user.see({ testId: `sidebar-session-${id}` });
    const rows = await probe.dom(`[data-sidebar-session-id="${id}"]`);
    evidence.recordAssertionEvidence("filed chat stays visible", `Previously settled chat rows visible in Workspaces: ${rows.elements.length}`, rows.elements.length === 1);
    expect(rows.elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("after: the grouped chat stays in Feed even with its old settle, without needing a pinned folder", async () => {
    await user.click({ role: "tab", label: "Feed" });
    await user.see({ testId: `sidebar-session-${id}` });
    await user.notSee({ text: "Settled", exact: true });
    await openMenu();
    await user.notSee({ role: "menuitem", label: /[Ss]ettle session/ });
    const items = await probe.dom('[data-session-menu-settle]');
    evidence.recordAssertionEvidence("grouped Feed chat cannot settle", `Settle menu items: ${items.elements.length}; grouped chat is visible outside Settled`, items.elements.length === 0);
    expect(items.elements).toHaveLength(0);
    await user.screenshot();
  });
});
