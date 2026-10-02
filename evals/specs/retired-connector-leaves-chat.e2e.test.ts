import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { retiredPluginConnectionInApp } from "../worlds/retired-plugin-connection.ts";

// The admin owns the CRM tools plugin and chats in the same app, so one person
// carries the whole journey; the member's side is the agent-flow spec
// retired-plugin-connection.e2e.test.ts.
const test = spec.world(retiredPluginConnectionInApp, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  timeout: 900_000,
});

const plusButton = { role: "button", label: "Add files, skills, connectors, and more" } as const;

test("an admin deletes the CRM tools plugin from the Library, and its connector leaves their chat without waiting for the next refresh; Undo puts it back", { tags: ["user-flow"] }, async ({ world, user, probe, step, evidence }) => {
  const plugin = world.pluginName;
  const rows = async () => (await probe.dom("[data-composer-plus-menu] [role=\"option\"]")).elements
    .map((element) => element.text.split("\n")[0]?.trim() ?? "");
  const isCrm = (row: string) => row.toLowerCase().includes("crm");
  const isNotes = (row: string) => row.toLowerCase().includes("notes");
  const openConnectors = async () => {
    await user.click(plusButton);
    // The section appears once the workspace's connectors have loaded.
    await user.see({ role: "option", label: /^Connectors/ }, { timeoutMs: 60_000 });
    await user.click({ role: "option", label: /^Connectors/ });
    await user.see({ placeholder: "Search connectors" });
  };
  const menuOpen = async () => (await probe.dom("[data-composer-plus-menu]")).elements.length > 0;
  const closeMenu = async () => {
    // Escape steps back from Connectors to the first menu, then closes it.
    for (let presses = 0; presses < 3 && await menuOpen(); presses += 1) await user.press("Escape");
    await user.notSee({ placeholder: "Search connectors" });
    expect(await menuOpen()).toBe(false);
  };
  // The menu reads the chat's connectors each time it opens, so a person
  // checking again closes and reopens it.
  let reopens = 0;
  const waitForRows = (label: string, until: (found: string[]) => boolean) => probe.eventually(async () => {
    const found = await rows();
    if (until(found)) return found;
    await closeMenu();
    await openConnectors();
    reopens += 1;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return rows();
  }, { within: 90_000, intervalMs: 1_000, label, until });

  await step("before: in a new chat, the Connectors menu offers CRM tools and its server next to Notes", async () => {
    await user.see("composer", { editable: true, timeoutMs: 90_000 });
    // Wait for the account menu to report the organization's tools ready, so
    // the chat does not redraw under the open menu.
    await probe.eventually(async () => (await probe.dom('[data-testid="account-status-menu"][data-connect-state="ready"]')).elements.length, {
      within: 120_000, label: "the organization's tools are ready in this chat", until: (count) => count === 1,
    });
    await openConnectors();
    // Both the organization's CRM connector and the CRM server the app added
    // to this chat's tools (listed by its runtime name) are on screen.
    const found = await waitForRows("the CRM connector and its server arrive in the menu", (list) =>
      list.some((row) => row.startsWith(plugin)) && list.some((row) => row.startsWith("openwork-direct-crm")) && list.some(isNotes));
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "The admin's chat offers the CRM connector and its tools",
      `Connectors menu: ${found.join(" / ")}`,
      found.some(isCrm) && found.some(isNotes),
    );
    expect(found.some(isCrm)).toBe(true);
    await closeMenu();
  });

  const library = async () => ({
    rows: (await probe.dom("[data-library-row]")).elements.length,
    crm: (await probe.dom(`[data-library-row="${plugin}"]`)).elements.length,
  });
  const chooseDelete = async () => {
    await user.click({ role: "button", label: `More for ${plugin}` });
    await user.click({ role: "menuitem", label: "Delete…" });
    await user.see({ testId: "library-delete-dialog" });
  };
  const confirmDelete = async () => {
    await user.click({ role: "button", label: "Delete" });
    await user.see({ text: `${plugin} deleted` }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Undo" });
    return probe.eventually(library, {
      within: 30_000, label: "every CRM row leaves the Library", until: (shown) => shown.rows === 0,
    });
  };

  await step(`the admin finds ${plugin} in the Library and chooses Delete`, async () => {
    await user.click({ role: "button", label: "Library" });
    await user.see({ role: "button", label: `More for ${plugin}` }, { timeoutMs: 60_000 });
    await user.type({ placeholder: "Filter by name" }, "CRM");
    await probe.eventually(library, { within: 10_000, label: "the filter narrows the Library", until: (shown) => shown.rows === 1 && shown.crm === 1 });
    await chooseDelete();
    const dialog = (await probe.dom("[data-testid=\"library-delete-dialog\"]")).elements[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    await user.screenshot();
    evidence.recordAssertionEvidence("Delete asks before removing the plugin", `dialog: "${dialog}"`, dialog.includes(plugin));
    expect(dialog).toContain(plugin);
  });

  await step(`after delete: ${plugin} leaves the Library and the toast offers Undo`, async () => {
    const left = await confirmDelete();
    await user.screenshot();
    evidence.recordAssertionEvidence("The Library no longer lists the plugin or its connector", `rows matching "CRM": ${left.rows}; toast "${plugin} deleted · Undo"`, left.rows === 0);
    expect(left.rows).toBe(0);
  });

  await step(`after Undo: ${plugin} is back in the Library`, async () => {
    // The toast offers Undo for 10 seconds, so the admin chooses it here.
    await user.click({ role: "button", label: "Undo" });
    const back = await probe.eventually(library, {
      within: 30_000, label: "the plugin row returns", until: (shown) => shown.crm === 1,
    });
    await user.see({ role: "button", label: `More for ${plugin}` });
    await user.screenshot();
    evidence.recordAssertionEvidence("Undo restores the plugin", `rows matching "CRM": ${back.rows} (${plugin})`, back.crm === 1);
    expect(back.crm).toBe(1);
  });

  await step(`the admin deletes ${plugin} again and keeps it deleted`, async () => {
    await chooseDelete();
    const left = await confirmDelete();
    await user.click({ role: "button", label: "Close" });
    await user.notSee({ role: "button", label: "Undo" });
    await user.screenshot();
    evidence.recordAssertionEvidence("The plugin is deleted for good", `rows matching "CRM": ${left.rows}; the admin closed the toast without Undo`, left.rows === 0);
    expect(left.rows).toBe(0);
  });

  await step("after: back in a new chat, the Connectors menu no longer offers CRM tools, without waiting for the next refresh", async () => {
    const started = Date.now();
    reopens = 0;
    await user.click({ role: "button", label: "New session" });
    await user.see("composer", { editable: true, timeoutMs: 30_000 });
    await openConnectors();
    const found = await waitForRows("the CRM connector leaves the menu", (list) => !list.some(isCrm) && list.some(isNotes));
    const seconds = Math.round((Date.now() - started) / 1000);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "Deleting the plugin removes its connector from the chat right away",
      `${seconds}s after returning to the chat (menu reopened ${reopens} times) the Connectors menu shows: ${found.join(" / ")}; no CRM row, though the periodic refresh only runs every 5 minutes`,
      !found.some(isCrm),
    );
    expect(found.some(isCrm)).toBe(false);
  });

  await step("boundary: Notes, which an admin added on its own, is still offered", async () => {
    await user.type({ placeholder: "Search connectors" }, "Notes");
    const found = await probe.eventually(rows, { within: 10_000, label: "the search narrows the menu", until: (list) => list.some(isNotes) && !list.some((row) => !isNotes(row) && row !== "Manage connectors") });
    const notes = found.filter(isNotes);
    await user.screenshot();
    evidence.recordAssertionEvidence("Unrelated connectors stay", `searching "Notes" finds: ${notes.join(" / ")}`, notes.length > 0);
    expect(notes.length).toBeGreaterThan(0);
  });
});
