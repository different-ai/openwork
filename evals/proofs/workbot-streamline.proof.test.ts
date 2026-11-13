import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotWorkspace } from "../worlds/workbot-workspace.ts";

const test = spec.world(workbotWorkspace, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("Workbot's menus name the computer page for what the person has", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  world.seedOwnerConversation("Hi Workbot");
  await step("with the browser and the desktop apps, the page is called Computer", async () => {
    await user.navigate(`${world.url}?assistant=off&browser=on&computer=on`);
    await user.see({ role: "button", label: "Computer" });
    await user.notSee({ role: "button", label: "Browser" });
    await user.screenshot();
  });
  await step("with only the browser, the header, the drawer and the command palette all call it Browser", async () => {
    await user.navigate(`${world.url}?assistant=off&browser=on`);
    await user.see({ role: "button", label: "Browser" });
    await user.notSee({ role: "button", label: "Computer" });
    await user.screenshot();
    await user.click({ role: "button", label: "Browser" });
    expect(await probe.url()).toContain("/browser");
    await user.see({ text: "Workbot's browser is paused." });
    expect((await probe.dom('section[aria-label="Browser"]')).elements.length).toBe(1);
    await user.navigate(`${world.url}?browser=on`);
    await user.click({ role: "button", label: "Open workspace navigation" });
    await user.see({ role: "button", label: "Browser" });
    await user.notSee({ role: "button", label: "Computer" });
    await user.screenshot();
    await user.press("Escape");
    await user.click({ role: "button", label: "Search and actions" });
    await user.type({ role: "combobox" }, "browser");
    const entry = await probe.eventually(() => probe.dom('[data-workbot-palette-item="nav:computer"]'), { within: 3000, label: "the palette lists the page", until: layout => layout.elements.length === 1 });
    expect(entry.elements[0]?.text).toMatch(/^Browser/);
    evidence.recordAssertionEvidence("One name everywhere", "Header, drawer and command palette all offer Browser when it is the only view", entry.elements[0]?.text.startsWith("Browser") === true);
    await user.screenshot();
  });
});

test("the conversation docks beside the browser for browser-heavy work", async ({ world, user, probe, step, evidence }) => {
  world.seedOwnerConversation("Hi Workbot");
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

  await step("after: the same conversation sits beside the browser, and a message sent there reaches Workbot", async () => {
    await user.navigate(`${world.url}browser?assistant=off&browser=on`);
    await user.see({ text: "Workbot's browser is paused." });
    expect((await probe.dom('section[aria-label="Browser"]')).elements.length).toBe(1);
    await user.see({ testId: "workbot-docked-chat" });
    await user.see({ text: "Hi Workbot" });
    const before = world.messages().length;
    await user.type({ role: "textbox", label: "Message Workbot" }, "Check the budget site on your computer");
    await user.click({ role: "button", label: "Send" });
    await probe.eventually(async () => world.messages().length, { within: 5000, label: "the docked chat sends the message", until: count => count === before + 1 });
    await user.see({ text: "I checked the budget site on my computer." });
    evidence.recordAssertionEvidence("Docked chat is the real conversation", "The earlier message is shown and a new one reaches Workbot from beside the browser", world.messages().length === before + 1);
    await user.screenshot();
  });
  await step("after: on a narrow window the chat floats over the browser instead of squeezing it", async () => {
    await user.resizeViewport({ width: 900, height: 900, deviceScaleFactor: 1 });
    await user.navigate(`${world.url}browser?assistant=off&browser=on`);
    await user.see({ text: "Workbot's browser is paused." });
    expect((await probe.dom('section[aria-label="Browser"]')).elements.length).toBe(1);
    await user.notSee({ testId: "workbot-docked-chat" });
    await user.see({ role: "button", label: /workspace chat/ });
    await user.screenshot();
  });
});

test("Documents opens with files already read and shows plain text as a readable page", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  world.seedOwnerConversation("Hi Workbot");
  await step("reaching the Documents tab reads its first listing before the click", async () => {
    await user.navigate(`${world.url}?assistant=off`);
    await user.see({ role: "button", label: "Documents" });
    const before = world.listingReads().length;
    await user.hover({ role: "button", label: "Documents" });
    await probe.eventually(async () => world.listingReads().length, { within: 5000, label: "hovering Documents reads Recent", until: count => count > before });
    const reads = world.listingReads().length;
    await user.click({ role: "button", label: "Documents" });
    await user.see({ role: "button", label: "Project brief.txt", nth: 0 });
    expect((await probe.dom(".ow-documents-skeleton")).elements.length).toBe(0);
    evidence.recordAssertionEvidence("Documents opens with its listing", "The listing was read on hover; after the click no skeleton was on screen", reads > before);
    await user.screenshot();
  });
  await step("a file the pointer rests on is read before it is opened, and opens as a readable page", async () => {
    const before = world.editorReads().filter(id => id === "file_brief").length;
    await user.hover({ role: "button", label: "Project brief.txt", nth: 1 });
    await probe.eventually(async () => world.editorReads().filter(id => id === "file_brief").length, { within: 5000, label: "hovering a file reads it", until: count => count > before });
    await user.click({ role: "button", label: "Project brief.txt", nth: 1 });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Project overview" });
    expect(world.editorReads().filter(id => id === "file_brief").length).toBe(before + 1);
    const field = await probe.dom(".ow-editor-plain");
    evidence.recordAssertionEvidence("The click reuses the read made on hover", "Exactly one editor read for the file, made before the click", world.editorReads().filter(id => id === "file_brief").length === before + 1);
    expect(field.elements.length).toBe(1);
    await user.screenshot();
  });
  await step("going back to a listing shows it at once while it refreshes", async () => {
    await user.click({ role: "button", label: /^Files$/ });
    await user.click({ role: "button", label: "My Drive" });
    await user.see({ role: "button", label: "Team folder" });
    await user.click({ role: "button", label: "Recent" });
    expect((await probe.dom(".ow-documents-skeleton")).elements.length).toBe(0);
    await user.see({ role: "button", label: "Budget notes.txt", nth: 1 });
    await user.screenshot();
  });
});

test("a spreadsheet Workbot wrote opens in the chat preview, its reader loaded only then", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  world.seedOwnerConversation("Hi Workbot");
  world.seedOwnerSpreadsheet();
  await step("opening Budget.xlsx from the reply shows its rows", async () => {
    await user.navigate(`${world.url}?assistant=off`);
    await user.see({ text: "Here is the budget." });
    await user.click({ role: "button", label: /Budget\.xlsx/, nth: 0 });
    await user.see({ text: "Catering" });
    await user.see({ text: "Venue" });
    const cells = await probe.dom("table td");
    evidence.recordAssertionEvidence("The Office reader still works when loaded on demand", "Budget.xlsx rows render in the preview", cells.elements.some(cell => cell.text === "Catering"));
    await user.screenshot();
  });
});
