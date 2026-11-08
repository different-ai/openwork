import { expect } from "vitest";
import { spec, type Probe } from "@openwork/testkit";
import { workbotWorkspace } from "../worlds/workbot-workspace.ts";

const test = spec.world(workbotWorkspace, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

/** Chat surfaces that are actually on screen: a hidden Home keeps its composer mounted, so count only drawn ones. */
async function shownChat(probe: Probe) {
  const shown = async (selector: string) => (await probe.dom(selector)).elements.filter(element => element.rect.width > 0 && element.rect.height > 0).length;
  return {
    composers: await shown('textarea[aria-label="Message Workbot"]'),
    floating: await shown("[data-workbot-workspace-assistant], [data-workbot-workspace-chat]"),
    pills: await shown('[data-testid="workbot-view-context"]'),
  };
}

test("the chat shows only in the chat view; Ask Workbot brings an open document into it", async ({ world, user, probe, step, evidence }) => {
  world.seedOwnerConversation("How can I do one phone");
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("Documents on desktop shows its own title and no chat, composer or context pills", async () => {
    await user.navigate(`${world.url}documents?guided=on&sideChats=on`);
    await user.see({ role: "button", label: "My Drive" });
    await user.see({ role: "heading", label: "Documents", nth: 0 });
    await user.notSee({ text: "How can I do one phone" });
    await user.notSee({ role: "button", label: /workspace chat/ });
    const chat = await shownChat(probe);
    expect(chat).toEqual({ composers: 0, floating: 0, pills: 0 });
    expect((await probe.dom("[data-workbot-page-header] h1")).elements.map(element => element.text)).toEqual(["Documents"]);
    evidence.recordAssertionEvidence("No chat over Documents", JSON.stringify(chat), chat.composers + chat.floating + chat.pills === 0);
    await user.screenshot();
  });
  await step("Calendar is the same: its own title, no chat", async () => {
    await user.navigate(`${world.url}calendar?guided=on`);
    await user.see({ role: "heading", label: "Calendar", nth: 0 });
    expect(await shownChat(probe)).toEqual({ composers: 0, floating: 0, pills: 0 });
    await user.screenshot();
  });
  await step("an open document offers one Ask Workbot action, which switches to the chat with it attached", async () => {
    await user.navigate(`${world.url}documents?guided=on`);
    await user.notSee({ role: "button", label: "Ask Workbot" });
    await user.click({ role: "button", label: "Project brief.txt", nth: 0 });
    await user.see({ role: "textbox", label: "Document text" });
    expect(await shownChat(probe)).toEqual({ composers: 0, floating: 0, pills: 0 });
    await user.click({ role: "button", label: "Ask Workbot" });
    await user.see({ testId: "workbot-attached-context", text: /Project brief\.txt · Read-only/ });
    await user.see({ text: "How can I do one phone" });
    expect(new URL(await probe.url()).pathname).toBe("/");
    await probe.eventually(() => probe.dom('textarea[aria-label="Message Workbot"]'), { within: 3000, label: "the chat's composer takes focus", until: layout => layout.elements.some(element => element.focused) });
    await user.screenshot();
  });
  await step("the next message carries that document, once", async () => {
    await user.type({ role: "textbox", label: "Message Workbot" }, "Summarize this");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "the question carries the document", until: values => values.length === 1 });
    expect(sent[0]).toMatchObject({ text: "Summarize this", context: { kind: "document", fileId: "file_brief", title: "Project brief.txt" } });
    await user.notSee({ testId: "workbot-attached-context" });
    await user.type({ role: "textbox", label: "Message Workbot" }, "And something else");
    await user.press("Enter");
    const next = await probe.eventually(() => world.messages(), { within: 5000, label: "the follow-up is plain", until: values => values.length === 2 });
    expect(next[1]).not.toHaveProperty("context");
    evidence.recordAssertionEvidence("Ask Workbot attaches the open document to one message", JSON.stringify(next), next[0]?.context !== undefined && !("context" in next[1]!));
    await user.screenshot();
  });
  await step("the attached document can be removed before sending", async () => {
    await user.click({ role: "button", label: "Documents", nth: 0 });
    await user.click({ role: "button", label: "Ask Workbot" });
    await user.click({ role: "button", label: "Remove Project brief.txt" });
    await user.notSee({ testId: "workbot-attached-context" });
    await user.type({ role: "textbox", label: "Message Workbot" }, "Never mind the file");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "the message goes without the document", until: values => values.length === 3 });
    expect(sent[2]).not.toHaveProperty("context");
  });
  await step("on a phone, Documents is full width with no chat sheet or composer", async () => {
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await user.navigate(`${world.url}documents?guided=on`);
    await user.see({ role: "heading", label: "Documents", nth: 0 });
    await user.see({ text: "Project brief.txt", nth: 0 });
    const chat = await shownChat(probe);
    expect(chat).toEqual({ composers: 0, floating: 0, pills: 0 });
    const page = await probe.dom("[data-workbot-page-header]");
    expect(page.documentWidth).toBeLessThanOrEqual(page.viewportWidth);
    evidence.recordAssertionEvidence("No chat sheet over Documents on a phone", JSON.stringify(chat), chat.composers + chat.floating + chat.pills === 0);
    await user.screenshot();
  });
});
