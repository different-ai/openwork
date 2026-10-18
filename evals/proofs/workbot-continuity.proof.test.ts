import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotContinuity } from "../worlds/workbot-continuity.ts";

const test = spec.world(workbotContinuity, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member keeps separate chat drafts and one draft across Home and Documents", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("the member leaves a question unsent in a side chat", async () => {
    await user.type({ role: "textbox", label: "Message Workbot" }, "My unsent planning question");
    await user.click({ role: "button", label: "Open workspace navigation" });
    await user.click({ role: "button", label: "Chats" });
    await user.click({ role: "button", label: /Main chat/ });
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "" });
    evidence.recordAssertionEvidence("The main chat does not inherit the side chat draft", "Main chat composer is empty; neither draft sent", world.attempts().length === 0);
    await user.screenshot();
  });
  await step("after: returning to the side chat restores its unsent question", async () => {
    await user.type({ role: "textbox", label: "Message Workbot" }, "My separate main question");
    await user.click({ role: "button", label: "Open workspace navigation" });
    await user.click({ role: "button", label: "Chats" });
    await user.click({ role: "button", label: /Planning/ });
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "My unsent planning question" });
    evidence.recordAssertionEvidence("The side chat draft survives the keyed screen remount", "My unsent planning question is restored; neither question was sent", world.attempts().length === 0);
    await user.screenshot();
  });
  await step("after: the same question follows the member to Documents without replacing a document draft", async () => {
    await user.click({ role: "button", label: "Open workspace navigation" });
    await user.click({ role: "button", label: "Open Project brief.txt" });
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "My unsent planning question" });
    await user.type({ role: "textbox", label: "Document text" }, "Unsaved project draft", { replace: true });
    await user.type({ role: "textbox", label: "Message Workbot" }, "A follow-up about this view", { replace: true });
    await user.press("Enter");
    await probe.eventually(() => world.attempts(), { within: 5000, label: "the question is accepted", until: attempts => attempts.length === 1 });
    await user.notSee({ role: "button", label: "Hide workspace chat" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Unsaved project draft" });
    expect((await probe.dom('textarea[aria-label="Message Workbot"]')).elements.some(element => element.focused)).toBe(true);
    evidence.recordAssertionEvidence("Sending does not open chat or take focus from the composer", "Document draft stays; chat remains closed; composer keeps focus", (await probe.dom("[data-workbot-workspace-chat]")).elements.length === 0);
    await user.screenshot();
  });
  await step("the member explicitly opens chat and can send another follow-up without closing it", async () => {
    await user.click({ role: "button", label: "Show workspace chat" });
    await user.see({ text: "A follow-up about this view" });
    await user.type({ role: "textbox", label: "Message Workbot" }, "Another follow-up");
    await user.see({ role: "button", label: "Hide workspace chat", nth: 0 });
    await user.press("Enter");
    await user.see({ text: "Another follow-up" });
    await user.see({ role: "button", label: "Hide workspace chat", nth: 0 });
    const attempts = await probe.eventually(() => world.attempts(), { within: 5000, label: "both follow-ups reach the API", until: attempts => attempts.length === 2 });
    expect(attempts).toHaveLength(2);
    evidence.recordAssertionEvidence("Explicit chat disclosure stays open for a follow-up", "Both questions reached the API and are visible; the document draft remains mounted", attempts.length === 2);
    await user.screenshot();
  });
});

test("a member retries a refused correction without losing earlier messages or the correction", async ({ world, user, probe, step, evidence }) => {
  await step("the member corrects an earlier question while both earlier replies stay visible", async () => {
    await user.see({ text: "Use Monday" });
    await user.click({ role: "button", label: /^(Correct|Edit) message$/, nth: 0 });
    await user.see({ text: "Correcting: Use Monday" });
    await user.type({ role: "textbox", label: /^(Correct|Edit) your message$/ }, "Use Friday", { replace: true });
    await user.click({ role: "button", label: /^(Send correction|Send)$/, nth: 0 });
    await user.see({ text: "Use Monday" });
    await user.see({ text: "Earlier question 2" });
    evidence.recordAssertionEvidence("Correcting does not hide earlier conversation", "Both original messages remain visible", (await probe.dom('ol[aria-label="Conversation"] > li')).elements.length >= 2);
    await user.screenshot();
  });
  await step("after: a refused correction remains visible with Send again", async () => {
    await user.see({ role: "button", label: "Send again" });
    await user.see({ text: "Use Friday" });
    const references = await probe.dom("[data-workbot-correction-reference]");
    expect(references.elements).toHaveLength(1);
    expect(references.elements[0]?.text).toContain("Use Monday");
    expect(await probe.text()).not.toContain("wb_message0000");
    const attempts = world.attempts();
    expect(attempts).toHaveLength(1);
    evidence.recordAssertionEvidence("The refusal was exercised and the correction is recoverable", "One correction request refused; its replacement text remains visible", attempts.length === 1);
    await user.screenshot();
  });
  await step("after: Send again accepts the same correction once and preserves the original replies", async () => {
    await user.click({ role: "button", label: "Send again" });
    await user.see({ text: "Reply 231" });
    await user.notSee({ role: "button", label: "Send again" });
    await user.see({ text: "Use Monday" });
    await user.see({ text: "Earlier question 2" });
    const attempts = await probe.eventually(() => world.attempts(), { within: 5000, label: "the same correction is retried", until: attempts => attempts.length === 2 });
    expect(attempts[1]?.newId).toBe(attempts[0]?.newId);
    expect((await probe.dom('ol[aria-label="Conversation"] > li')).elements).toHaveLength(3);
    evidence.recordAssertionEvidence("Retry keeps one correction identity", `Two attempts share ${attempts[0]?.newId}; three conversation messages remain`, attempts[1]?.newId === attempts[0]?.newId);
    await user.screenshot();
  });
});

test("a member retries a message after its file uploaded without uploading or sending duplicate copies", async ({ world, user, probe, step, evidence }) => {
  await step("the member sends a selected file while it is still uploading", async () => {
    await user.navigate(`${world.url}?assistant=off&chat=sidechat000000001`);
    await user.see({ role: "textbox", label: "Message Workbot" });
    await user.attachFiles('input[type="file"]', [world.notesPath]);
    await user.type({ role: "textbox", label: "Message Workbot" }, "Read my notes");
    await user.press("Enter");
    await user.see({ text: "Uploading your files" });
    evidence.recordAssertionEvidence("The upload really outlives the composer tray", "The pending message shows Uploading your files; no send has been attempted", world.attempts().length === 0);
    await user.screenshot();
  });
  await step("after: the uploaded file stays attached when sending is refused", async () => {
    await user.see({ role: "button", label: "Send again" });
    await user.see({ text: "Read my notes" });
    expect(world.uploads()).toBe(1);
    expect(world.attempts()[0]?.attachments).toEqual(["file_notes"]);
    evidence.recordAssertionEvidence("The send refusal follows a successful upload", "One upload completed; the refused send includes file_notes", world.uploads() === 1 && world.attempts().length === 1);
    await user.screenshot();
  });
  await step("after: Send again reuses the message and saved file identities", async () => {
    await user.click({ role: "button", label: "Send again" });
    await user.see({ text: "Reply 231" });
    await user.notSee({ role: "button", label: "Send again" });
    await user.see({ text: "Read my notes" });
    const attempts = await probe.eventually(() => world.attempts(), { within: 5000, label: "one retry is accepted", until: attempts => attempts.length === 2 });
    expect(attempts[1]?.id).toBe(attempts[0]?.id);
    expect(attempts[1]?.attachments).toEqual(["file_notes"]);
    expect(world.uploads()).toBe(1);
    expect((await probe.dom('ol[aria-label="Conversation"] > li')).elements).toHaveLength(3);
    evidence.recordAssertionEvidence("Successful files and accepted messages are not replayed", "Two send attempts share an id and file_notes; one upload; one new conversation message", world.uploads() === 1);
    await user.screenshot();
  });
});

// This native form fixture verifies the testkit's file-selection boundary, not a substitute Workbot UI.
test("a member's browser honors disabled file pickers while allowing an intentionally hidden picker", async ({ world, user, probe, step, evidence }) => {
  await step("a disabled input and disabled fieldset refuse file selection", async () => {
    await user.navigate(`${world.url}fixture-file-inputs`);
    await user.see({ role: "heading", label: "File input boundaries" });
    await expect(user.attachFiles("#disabled-direct", [world.notesPath])).rejects.toThrow("File input unavailable: disabled");
    await expect(user.attachFiles("#disabled-fieldset", [world.notesPath])).rejects.toThrow("File input unavailable: disabled");
    await user.see({ text: "No file selected" });
    evidence.recordAssertionEvidence("Disabled controls cannot transfer files", "Native disabled input and fieldset were both rejected; no change event selected a file", !(await probe.text()).includes("Selected notes.txt"));
    await user.screenshot();
  });
  await step("a hidden or inert parent surface also refuses selection", async () => {
    await expect(user.attachFiles("#unavailable-parent", [world.notesPath])).rejects.toThrow("File input unavailable: unavailable parent surface");
    await expect(user.attachFiles("#inert-parent", [world.notesPath])).rejects.toThrow("File input unavailable: disabled");
    await user.see({ text: "No file selected" });
    evidence.recordAssertionEvidence("Unavailable surfaces cannot be bypassed by file selection", "Hidden and inert parent surfaces were rejected; no file selected", !(await probe.text()).includes("Selected notes.txt"));
    await user.screenshot();
  });
  await step("an enabled picker may hide its native file input intentionally", async () => {
    await user.attachFiles("#hidden-enabled", [world.notesPath]);
    await user.see({ text: "Selected notes.txt" });
    evidence.recordAssertionEvidence("The ordinary hidden-input picker path still works", "The enabled hidden input emitted its native change event for notes.txt", (await probe.text()).includes("Selected notes.txt"));
    await user.screenshot();
  });
});

test("a member reaches an honest history limit instead of an inert Show earlier button", async ({ world, user, probe, step, evidence }) => {
  await step("the member opens a long conversation that includes background work", async () => {
    await user.navigate(`${world.url}?assistant=off&history=long&chat=sidechat000000001`);
    await user.see({ role: "textbox", label: "Message Workbot" });
    await user.wheelAt({ x: 640, y: 200, deltaY: -100000 });
    await user.see({ role: "button", label: "Show earlier messages" });
    evidence.recordAssertionEvidence("Earlier history exists beyond the initial page", "The fixture has 230 mixed records; the first page requests 30", world.windows().includes(30));
    await user.screenshot();
  });
  await step("the member repeatedly requests earlier messages", async () => {
    for (const window of [60, 90, 120, 150, 180, 200]) {
      await user.click({ role: "button", label: "Show earlier messages" });
      await probe.eventually(() => world.windows(), { within: 5000, label: `history grows to ${window} messages`, until: windows => windows.includes(window) });
      await user.see(window === 200
        ? { text: "History limit reached. Earlier messages aren't available here." }
        : { role: "button", label: "Show earlier messages" });
    }
    evidence.recordAssertionEvidence("Each request grows the window until the supported limit", "30, 60, 90, 120, 150, 180, 200 requested", world.windows().includes(200));
    await user.screenshot();
  });
  await step("after: the limit names the unavailable history and offers no inert action", async () => {
    await user.see({ text: "History limit reached. Earlier messages aren't available here." });
    await user.notSee({ role: "button", label: "Show earlier messages" });
    expect(world.historyPages().at(-1)).toEqual({ records: 200, messages: 100 });
    expect((await probe.dom('ol[aria-label="Conversation"] > li')).elements).toHaveLength(100);
    expect(await probe.text()).not.toContain("latest 200 messages");
    evidence.recordAssertionEvidence("The supported history boundary is honest", "200 mixed records yield 100 conversation messages; no numeric completeness claim or inert Show earlier action remains", (await probe.dom('ol[aria-label="Conversation"] > li')).elements.length === 100);
    await user.screenshot();
  });
});
