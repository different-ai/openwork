import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotWorkspace } from "../worlds/workbot-workspace.ts";

const test = spec.world(workbotWorkspace, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("Workbot offers a document it mentions and the conversation stays open beside it", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  // The member's main chat on Home, past its first-run welcome.
  world.seedOwnerConversation("Hi Workbot");
  await step("before: opening a linked document from the main chat shows it in Documents", async () => {
    await user.navigate(world.url);
    await user.type({ role: "textbox", label: "Message Workbot" }, "Where are the budget notes?");
    await user.press("Enter");
    await user.see({ role: "link", label: "Budget notes", nth: 0 });
    await user.notSee({ testId: "workbot-document-offer" });
    await user.click({ role: "link", label: "Budget notes", nth: 0 });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Budget overview" });
    expect(await probe.url()).toContain("/documents");
    evidence.recordAssertionEvidence("Without guided navigation the link still opens the document", "Budget notes opened in Documents", (await probe.url()).includes("/documents"));
    await user.screenshot();
  });
  await step("after: from the main chat, Workbot's Open action shows the document with the same conversation open beside it", async () => {
    await user.navigate(`${world.url}?guided=on`);
    await user.see({ role: "button", label: "Open Budget notes", nth: 0 });
    await user.notSee({ role: "button", label: "Open Restricted document" });
    expect(await probe.url()).not.toContain("/documents");
    evidence.recordAssertionEvidence("The main chat offers one document, quietly, under the reply", "One Open action; the second link stays inline", (await probe.dom("[data-workbot-document-offer]")).elements.length >= 1);
    await user.screenshot();
    await user.click({ role: "button", label: "Open Budget notes", nth: 0 });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Budget overview" });
    const chat = await probe.eventually(() => probe.dom("[data-workbot-workspace-chat]"), { within: 3000, label: "the conversation opens beside the document", until: layout => layout.elements.length === 1 });
    await user.see({ testId: "workbot-view-context", text: /Budget notes\.txt · Read-only context/ });
    await user.see({ text: "Where are the budget notes?" });
    expect(await probe.url()).toContain("/documents");
    evidence.recordAssertionEvidence("The same conversation is open beside the opened document", "Earlier question visible in the floating chat; context chip names Budget notes.txt", chat.elements.length === 1);
    await user.screenshot();
  });
  await step("the next question carries the document the member is now looking at", async () => {
    const before = world.messages().length;
    await user.type({ role: "textbox", label: "Message Workbot" }, "What changed here?");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "the follow-up carries the opened document", until: values => values.length === before + 1 });
    expect(sent.at(-1)).toMatchObject({ text: "What changed here?", context: { kind: "document", fileId: "file_budget", title: "Budget notes.txt" } });
    await user.see({ text: "What changed here?" });
    await user.notSee({ role: "button", label: "Open Budget notes" });
    evidence.recordAssertionEvidence("The follow-up refers to the document Workbot offered", JSON.stringify(sent.at(-1)), JSON.stringify(sent.at(-1)).includes("file_budget"));
    await user.screenshot();
  });
  await step("a link the member cannot open does not replace the open document", async () => {
    await user.notSee({ role: "button", label: "Open Restricted document" });
    await user.click({ role: "link", label: "Restricted document", nth: 0 });
    await user.see({ text: "Couldn't open this document. Check your Drive connection and access." });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Budget overview" });
    evidence.recordAssertionEvidence("Den still decides access when a linked document is chosen", world.opened().join(","), !world.opened().includes("file_private"));
    await user.screenshot();
  });
  await step("before: a reply that used Workbot's computer offers nothing without guided navigation", async () => {
    await user.navigate(`${world.url}?computer=on`);
    await user.type({ role: "textbox", label: "Message Workbot" }, "Check the budget site on your computer");
    await user.press("Enter");
    await user.see({ text: "I checked the budget site on my computer." });
    await user.notSee({ role: "button", label: "Open Computer" });
    await user.screenshot();
  });
  await step("after: the latest reply that used the computer opens it with the same conversation beside it", async () => {
    await user.navigate(`${world.url}?guided=on&computer=on`);
    await user.see({ role: "button", label: "Open Computer" });
    evidence.recordAssertionEvidence("Only the newest reply that used the computer offers it", "One Open Computer action", (await probe.dom("[data-workbot-computer-offer]")).elements.length === 1);
    await user.screenshot();
    await user.click({ role: "button", label: "Open Computer" });
    const chat = await probe.eventually(() => probe.dom("[data-workbot-workspace-chat]"), { within: 3000, label: "the conversation opens beside the computer", until: layout => layout.elements.length === 1 });
    await user.see({ text: "Check the budget site on your computer" });
    await user.notSee({ role: "button", label: "Open Computer" });
    expect(await probe.url()).toContain("/browser");
    evidence.recordAssertionEvidence("The same conversation is open beside Workbot's computer", "Earlier question visible in the floating chat on /browser, the computer's Browser view", chat.elements.length === 1);
    await user.screenshot();
  });
  await step("after: asking Workbot to open a document shows it opening, then says it opened, beside the same conversation", async () => {
    await user.navigate(`${world.url}documents?guided=on`);
    world.holdDocumentMetadata();
    await user.type({ role: "textbox", label: "Message Workbot" }, "Open the project brief for me");
    await user.press("Enter");
    await user.see({ testId: "document-opening" });
    await user.see({ text: "Opening in Documents…" });
    // Until it loads, the chip claims no document: the next message would not reference the wrong one.
    await user.notSee({ testId: "workbot-view-context", text: /Project brief/ });
    // The conversation renders on Home (hidden) and beside the document, so count at least one.
    const openingShown = (await probe.dom('[data-workbot-document-navigation="opening"]')).elements.length >= 1;
    expect(openingShown).toBe(true);
    evidence.recordAssertionEvidence("A requested document reads as opening until Drive answers", "Skeleton and 'Opening in Documents…' while metadata is held", openingShown);
    await user.screenshot();
    world.releaseDocumentMetadata();
    await user.see({ role: "textbox", label: "Document text" }, { value: "Project overview" });
    await user.see({ text: "Opened in Documents" });
    await user.see({ testId: "workbot-view-context", text: /Project brief\.txt · Read-only context/ });
    expect((await probe.dom("[data-workbot-workspace-chat]")).elements).toHaveLength(1);
    // The conversation renders on Home (hidden) and beside the document, so count at least one.
    const openedShown = (await probe.dom('[data-workbot-document-navigation="opened"]')).elements.length >= 1;
    expect(openedShown).toBe(true);
    evidence.recordAssertionEvidence("Opened is only said once the document is on screen", "Project brief shown; status 'Opened in Documents'; conversation still open", openedShown);
    await user.screenshot();
  });
  await step("reloading the conversation never replays an earlier request to open a document", async () => {
    const opens = world.opened().filter(id => id === "file_brief").length;
    await user.reload();
    // The conversation is shown by default, so the earlier request is visible straight away.
    await user.see({ role: "button", label: "Hide workspace chat" });
    await user.see({ text: "Open the project brief for me" });
    await user.notSee({ text: "Opening in Documents…" });
    expect((await probe.dom('.ow-document-tabs [data-document-id="file_brief"]')).elements).toHaveLength(0);
    expect(world.opened().filter(id => id === "file_brief")).toHaveLength(opens);
    evidence.recordAssertionEvidence("History shows the request without following it again", `file_brief metadata reads: ${opens} before and after reload`, world.opened().filter(id => id === "file_brief").length === opens);
    await user.screenshot();
  });
  await step("opening another document on request keeps the member's unsaved draft", async () => {
    await user.click({ role: "button", label: "Budget notes.txt", nth: 0 });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Budget overview" });
    await user.click({ role: "button", label: /^Edit$/ });
    await user.type({ role: "textbox", label: "Document text" }, "Unsaved budget draft", { replace: true });
    await user.see({ testId: "workbot-view-context", text: /Unsaved edits excluded/ });
    await user.type({ role: "textbox", label: "Message Workbot" }, "Open the project brief for me");
    await user.press("Enter");
    await user.see({ role: "textbox", label: "Document text" }, { value: "Project overview" });
    await user.click({ role: "button", label: "Budget notes.txt, unsaved changes" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Unsaved budget draft" });
    evidence.recordAssertionEvidence("The draft is still there after Workbot opened another document", "Budget notes tab still holds 'Unsaved budget draft'", world.documentWrites().length === 0);
    await user.screenshot();
  });
  await step("a late answer does not pull the member away once they have moved on", async () => {
    world.holdDocumentMetadata();
    await user.type({ role: "textbox", label: "Message Workbot" }, "Open the trigger phrases for me");
    await user.press("Enter");
    await user.see({ testId: "document-opening" });
    await user.click({ role: "button", label: "Project brief.txt" });
    world.releaseDocumentMetadata();
    await user.see({ role: "textbox", label: "Document text" }, { value: "Project overview" });
    // Choosing a tab behind the conversation does not minimize it.
    await user.see({ text: "Not opened, because you moved on." });
    expect((await probe.dom('.ow-document-tabs [data-document-id="file_sheet"]')).elements).toHaveLength(0);
    // The conversation renders on Home (hidden) and beside the document, so count at least one.
    const setAsideShown = (await probe.dom('[data-workbot-document-navigation="superseded"]')).elements.length >= 1;
    expect(setAsideShown).toBe(true);
    evidence.recordAssertionEvidence("The member's own choice wins over a slower request", "Project brief stays on screen; no Trigger phrases tab; status offers Open", setAsideShown);
    await user.screenshot();
  });
  await step("a document the member cannot open is reported as not opened and the current one stays", async () => {
    await user.type({ role: "textbox", label: "Message Workbot" }, "Open the restricted document for me");
    await user.press("Enter");
    await user.see({ text: "Couldn't open this document. Check your Drive access." });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Project overview" });
    expect(world.opened()).not.toContain("file_private");
    evidence.recordAssertionEvidence("Navigation never grants access: Den refuses and Workbot says so", world.opened().join(","), !world.opened().includes("file_private"));
    await user.screenshot();
  });
});
