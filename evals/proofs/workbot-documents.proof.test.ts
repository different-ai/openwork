import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotWorkspace } from "../worlds/workbot-workspace.ts";

const test = spec.world(workbotWorkspace, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member opens and edits a Drive document while unavailable access stays blocked", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: Documents is locked while the feature is off", async () => {
    await user.navigate(`${world.url}documents?documents=off&assistant=off`);
    await user.see({ text: "Documents is off for your workspace. An admin can turn it on." });
    await user.notSee({ role: "textbox", label: "Document text" });
    await user.notSee({ role: "button", label: /^Documents/ });
    evidence.recordAssertionEvidence("The feature starts off", "The locked state contains no document editor", (await probe.dom(".ow-editor-plain")).elements.length === 0);
    await user.screenshot();
    await user.navigate(`${world.url}calendar?documents=off`);
    await user.click({ role: "button", label: "Open workspace navigation" });
    await user.notSee({ role: "button", label: /^Documents/ });
    await user.notSee({ text: "Recent documents" });
    await user.screenshot();
  });
  await step("after: a connected member opens a recent Drive document in an editable tab", async () => {
    await user.navigate(`${world.url}documents?assistant=off`);
    await user.click({ role: "button", label: "Project brief.txt" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Project overview" });
    await user.type({ role: "textbox", label: "Document text" }, "Revised project overview", { replace: true });
    await user.see({ text: "Unsaved changes" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Revised project overview" });
    expect(world.messages()).toHaveLength(0);
    evidence.recordAssertionEvidence("Drive browsing and editing remain separate from chat", "The file opens as a tab and marks local changes without sending a message", world.messages().length === 0);
    await user.screenshot();
  });
  await step("after: a failed file-list refresh leaves the unsaved document available", async () => {
    world.failListing();
    await user.click({ role: "button", label: /^Files$/ });
    await user.click({ role: "button", label: "Refresh documents" });
    await user.see({ text: "Couldn't load your documents." });
    await user.click({ role: "button", label: "Project brief.txt, unsaved changes" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Revised project overview" });
    await user.see({ text: "Couldn't refresh documents. Your open document is unchanged." });
    evidence.recordAssertionEvidence("A directory outage does not revoke the open file", "The edited text and retry action remain visible in the active tab", (await probe.dom(".ow-editor-plain")).elements.length === 1);
    await user.screenshot();
    world.restoreListing();
    await user.click({ role: "button", label: "Try again" });
    await probe.eventually(() => probe.dom(".ow-documents-workspace > .ow-editor-message"), { within: 5000, label: "the successful refresh has removed the outage notice", until: layout => layout.elements.length === 0 });
    await user.notSee({ text: "Couldn't refresh documents. Your open document is unchanged." });
  });
  await step("turning the feature off locks a draft until fresh access is confirmed after restoration", async () => {
    world.disableDocuments();
    await user.click({ role: "button", label: /^Files$/ });
    await user.click({ role: "button", label: "Refresh documents" });
    await user.see({ text: "Documents is off for your workspace. An admin can turn it on." });
    await user.notSee({ role: "textbox", label: "Document text" });
    world.enableDocuments();
    await user.click({ role: "button", label: "Check access and restore tabs" });
    await user.click({ role: "button", label: "Project brief.txt, unsaved changes" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Revised project overview" });
    evidence.recordAssertionEvidence("A feature restore cannot bypass file authorization", "The edited document survives a feature kill, fresh identity check and file permission check", (await probe.dom(".ow-editor-plain")).elements.length === 1 && world.documentWrites().length === 0);
    await user.screenshot();
  });
});

test("a member recovers a draft after reconnecting only when file authorization is confirmed", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: the authorized member has an unsaved document", async () => {
    await user.click({ role: "button", label: "Project brief.txt" });
    await user.type({ role: "textbox", label: "Document text" }, "Revised project overview", { replace: true });
    await user.see({ text: "Unsaved changes" });
    evidence.recordAssertionEvidence("The draft exists before the connection failure", "The editor contains revised text without a Drive write", world.documentWrites().length === 0 && (await probe.dom(".ow-editor-plain")).elements.length === 1);
    await user.screenshot();
  });
  await step("after: a refreshable connection failure locks cached content without discarding edits", async () => {
    world.revokeDrive();
    await user.click({ role: "button", label: /^Files$/ });
    await user.click({ role: "button", label: "Refresh documents" });
    await user.see({ text: "Google Drive needs a fresh connection." });
    await user.notSee({ role: "textbox", label: "Document text" });
    await user.see({ role: "link", label: "Reconnect Google Drive" });
    await user.notSee({ text: "Project brief.txt" });
    await user.notSee({ text: "Budget notes.txt" });
    await user.notSee({ text: "Revised project overview" });
    evidence.recordAssertionEvidence("A fresh connection is not a discard instruction", "Cached filenames, content and chat context are masked; a bounded recovery action remains", (await probe.dom(".ow-editor-plain")).elements.length === 0);
    await user.screenshot();
  });
  await step("a restored directory connection cannot reveal a file whose permission is still denied", async () => {
    world.restoreDrive();
    world.denyFile();
    await user.click({ role: "button", label: "Check access and restore tabs" });
    await user.see({ text: "Some documents are still locked. Check or discard them individually." });
    await user.notSee({ role: "textbox", label: "Document text" });
    await user.notSee({ text: "Project brief.txt" });
    evidence.recordAssertionEvidence("File authorization is checked separately", "A successful list read and a denied file read keep the retained draft locked", (await probe.dom(".ow-editor-plain")).elements.length === 0);
    await user.screenshot();
  });
  await step("after: fresh file authorization restores the unsaved draft rather than silently discarding it", async () => {
    world.allowFile();
    await user.click({ role: "button", label: "Check access and restore tabs" });
    await user.click({ role: "button", label: "Project brief.txt, unsaved changes" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Revised project overview" });
    evidence.recordAssertionEvidence("Only the same authorized identity recovers the draft", "Fresh editor permission restores the unsaved text; no write was replayed", world.documentWrites().length === 0 && world.editorReads().filter(id => id === "file_brief").length >= 3);
    await user.screenshot();
  });
});

test("a member handles a document request needing sign-in without replacing its retained draft", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: the member has an unsaved document in this workspace", async () => {
    await user.click({ role: "button", label: "Project brief.txt" });
    await user.type({ role: "textbox", label: "Document text" }, "Retained through sign-in", { replace: true });
    await user.see({ text: "Unsaved changes" });
    evidence.recordAssertionEvidence("The unsaved document precedes sign-in expiry", "The draft is present and no document write was sent", world.documentWrites().length === 0);
    await user.screenshot();
  });
  await step("after: a sign-in failure locks the document and offers sign-in without navigating it away", async () => {
    world.expireSession();
    await user.click({ role: "button", label: /^Files$/ });
    await user.click({ role: "button", label: "Refresh documents" });
    await user.see({ text: "Sign in again to restore document access." });
    await user.see({ role: "link", label: "Sign in again" });
    await user.notSee({ role: "textbox", label: "Document text" });
    expect(await probe.url()).toContain("/documents");
    expect((await probe.dom('a[target="_blank"][href^="/auth/login"]')).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("The actual host does not redirect away from recovery", "The workspace stays on Documents and its existing sign-in flow opens separately", (await probe.url()).includes("/documents"));
    await user.screenshot();
  });
  await step("a different signed-in person cannot reveal the retained draft even with file access", async () => {
    world.restoreSession();
    world.useOtherIdentity();
    await user.click({ role: "button", label: "Check access and restore tabs" });
    await user.see({ text: "The signed-in account or workspace changed. Retained documents are locked." });
    await user.notSee({ role: "textbox", label: "Document text" });
    await user.notSee({ text: "Project brief.txt" });
    world.restoreIdentity();
    world.useOtherOrganization();
    await user.click({ role: "button", label: "Check sign-in" });
    await probe.eventually(() => world.identityScopes(), { within: 5000, label: "the current sign-in is the original person in another workspace", until: values => values.some(value => value.principalId === "user_example" && value.organizationId === "org_other") });
    await probe.eventually(() => probe.dom('main[aria-label="Workspace sign-in recovery"][aria-busy="false"]'), { within: 5000, label: "the different workspace's identity check has settled", until: layout => layout.elements.length === 1 });
    await user.see({ text: "The signed-in account or workspace changed. Retained documents are locked." });
    await user.notSee({ role: "textbox", label: "Document text" });
    evidence.recordAssertionEvidence("Fresh identity is separate from file permissions", "The file service permits reads, but neither another person nor the same person in another workspace can restore the original draft", (await probe.dom(".ow-editor-plain")).elements.length === 0);
    await user.screenshot();
  });
  await step("after: restored sign-in still requires a fresh file check before the draft returns", async () => {
    world.restoreIdentity();
    world.restoreOrganization();
    await user.click({ role: "button", label: "Check sign-in" });
    await user.see({ role: "button", label: "Check access and restore tabs" });
    await user.click({ role: "button", label: "Check access and restore tabs" });
    await user.click({ role: "button", label: "Project brief.txt, unsaved changes" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Retained through sign-in" });
    evidence.recordAssertionEvidence("Sign-in recovery does not discard or replay changes", "The original draft returns after authorization, with zero document writes", world.documentWrites().length === 0);
    await user.screenshot();
  });
});
