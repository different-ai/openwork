import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { officeLifecycle } from "../worlds/office-lifecycle.ts";

const test = spec.world(officeLifecycle, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member keeps a Google original and its confirmed Office copy independently open", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: the member explicitly creates an Excel copy without changing the Google original", async () => {
    await user.click({ role: "button", label: "Planning" });
    await user.see({ text: "You’re editing an Excel copy. Save creates a new file in My Drive; the Google original stays unchanged." });
    await probe.eventually(() => probe.dom(".ow-document-actions button:not(:disabled)"), { within: 5000, label: "the editing session is ready for an explicit save", until: layout => layout.elements.length === 1 });
    await user.click({ role: "button", label: "Save Excel copy to Drive" });
    await user.see({ text: "Saved to Drive" });
    evidence.recordAssertionEvidence("Only an explicit save creates a copy", `Drive saves: ${world.saves().join(",")}`, world.saves().join(",") === "original");
    await user.screenshot();
  });
  await step("after: the tab, link and shared context all name the confirmed Office copy", async () => {
    await user.see({ role: "button", label: "Planning.xlsx" });
    await user.see({ role: "link", label: "Open saved copy in Drive" });
    await user.see({ testId: "workbot-view-context", text: /Planning.xlsx/ });
    await user.type({ role: "textbox", label: "Message Workbot" }, "Review this saved file");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "the saved copy accompanies the question", until: values => values.length === 1 });
    expect(sent[0]).toMatchObject({ context: { fileId: "saved_copy", title: "Planning.xlsx" } });
    evidence.recordAssertionEvidence("The current resource is the confirmed copy", JSON.stringify(sent[0]), JSON.stringify(sent[0]).includes('"fileId":"saved_copy"'));
    await user.screenshot();
    await user.click({ role: "button", label: "Hide workspace chat" });
  });
  await step("after: the original opens independently while reopening the copy selects its existing tab", async () => {
    await user.click({ role: "button", label: /^Files$/ });
    await user.click({ role: "button", label: "Refresh documents" });
    await user.click({ role: "button", label: "Planning", nth: 0 });
    await user.see({ role: "button", label: "Planning.xlsx" });
    expect((await probe.dom(".ow-document-tab")).elements).toHaveLength(2);
    // StrictMode can abort a session-creation request after the fixture accepts
    // it. Count distinct sessions actually launched into the retained frames,
    // not every POST attempt; keep creation receipts visible as diagnostics.
    await probe.eventually(() => world.launchedSessions().filter(session => session.fileId === "original"), { within: 5000, label: "the original owns an independent launched editing session", until: sessions => sessions.length === 2 });
    expect((await probe.dom(".ow-office-frame")).elements).toHaveLength(2);
    await user.click({ role: "button", label: /^Files$/ });
    await user.click({ role: "button", label: "Planning.xlsx", nth: 0 });
    expect((await probe.dom(".ow-document-tab")).elements).toHaveLength(2);
    evidence.recordAssertionEvidence("Tab identity is not source file identity", `Two tabs and two distinct launched source sessions; reopening the saved copy creates no duplicate tab. Session-creation attempts=${world.sessions().length}; launched=${world.launchedSessions().length}.`, world.launchedSessions().length === 2);
    await user.screenshot();
  });
});

test("a member gets recovery rather than a futile retry after an unconfirmed Office save", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: the member can explicitly save an Office copy", async () => {
    await user.click({ role: "button", label: "Unconfirmed workbook", nth: 0 });
    await probe.eventually(() => probe.dom(".ow-document-actions button:not(:disabled)"), { within: 5000, label: "the editing session is ready for an explicit save", until: layout => layout.elements.length === 1 });
    await user.see({ role: "button", label: "Save Excel copy to Drive" });
    evidence.recordAssertionEvidence("No Drive write happens before the member saves", "The save control is enabled; Drive has received zero writes", world.saves().length === 0);
    await user.screenshot();
  });
  await step("after: a lost save confirmation disables replay and offers the last received copy", async () => {
    await user.click({ role: "button", label: "Save Excel copy to Drive" });
    await user.see({ text: "Save not confirmed. Check Drive before making another save." });
    await user.see({ role: "link", label: "Download last received copy" });
    expect((await probe.dom(".ow-document-actions button:disabled")).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("The risky write really reached Drive once", "The provider received one write, returned no confirmation, and Save is now disabled", world.saves().join(",") === "uncertain");
    await user.screenshot();
  });
  await step("after: returning to the tab keeps the unconfirmed state without another write", async () => {
    await user.click({ role: "button", label: /^Files$/ });
    await user.click({ role: "button", label: "Unconfirmed workbook, unsaved changes" });
    await user.see({ text: "Save not confirmed. Check Drive before making another save." });
    expect((await probe.dom(".ow-document-actions button:disabled")).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("An unconfirmed write is never replayed", "Check Drive and recovery remain available; revisiting does not send another save", world.saves().length === 1);
    await user.screenshot();
  });
});

test("a member can download a received snapshot even after Office editing expires", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: a read-only Office session has a download independent of editing permission", async () => {
    await user.click({ role: "button", label: "Expiring workbook", nth: 0 });
    await user.see({ role: "link", label: "Download last received copy" });
    expect((await probe.dom(".ow-document-actions button:disabled")).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Recovery does not depend on Save or More tools", "The read-only session has a direct last-received download and no Drive writes", world.saves().length === 0);
    await user.screenshot();
  });
  await step("after: expiry disables editing but preserves the bounded recovery action", async () => {
    await user.see({ text: "Session expired" });
    await user.see({ text: "This editing session expired. The last received copy is available for 15 minutes; edits still in the editor may be missing." });
    await user.see({ role: "link", label: "Download last received copy" });
    expect((await probe.dom(".ow-office-canvas[inert]")).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Recovery is smaller than a live engine export", "The expired editor is inert; the action explicitly excludes changes not received by the service", world.saves().length === 0);
    await user.screenshot();
  });
  await step("the member can leave an expired session without any delayed save", async () => {
    await user.click({ role: "button", label: "Close Expiring workbook" });
    await user.see({ role: "button", label: "Refresh documents" });
    await user.notSee({ role: "link", label: "Download last received copy" });
    evidence.recordAssertionEvidence("Closing recovery does not write Drive", "The file list returns and no write has been sent", world.saves().length === 0);
    await user.screenshot();
  });
});
