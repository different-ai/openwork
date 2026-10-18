import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotWorkspace } from "../worlds/workbot-workspace.ts";

const test = spec.world(workbotWorkspace, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

for (const fault of [
  { status: 401, title: "a member retains document owners when workspace sign-in expires during reconnect", message: "Sign in again to restore this workspace." },
  { status: 503, title: "a member retains document owners when identity verification temporarily fails", message: "Couldn't verify this workspace. Retained documents are locked." },
]) {
  test(fault.title, async ({ world, user, probe, step, evidence }) => {
    let closes = 0;
    let launches = 0;
    await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await step("before: the member has a text draft and an open Office session", async () => {
      world.makeOfficeAvailable();
      await user.click({ role: "button", label: "Project brief.txt" });
      await user.type({ role: "textbox", label: "Document text" }, "Retained owner draft", { replace: true });
      await user.click({ role: "button", label: "Analysis.xlsx", nth: 0 });
      await probe.eventually(() => world.officeLaunches(), { within: 5000, label: "the Office session was posted into its frame", until: values => values.length > 0 });
      closes = world.officeCloses().length;
      launches = world.officeLaunches().length;
      evidence.recordAssertionEvidence("The risky editor owner exists before revalidation", `Office launch receipts=${launches}; frame count=${(await probe.dom(".ow-office-frame")).elements.length}; text writes=${world.documentWrites().length}. The peer is synthetic, not an engine-fidelity proof.`, launches > 0 && (await probe.dom(".ow-office-frame")).elements.length === 1);
      await user.screenshot();
    });
    await step("after: real parent identity revalidation masks rather than removes those owners", async () => {
      if (fault.status === 401) world.expireIdentity(); else world.failIdentity();
      await world.reconnectAfterStaleMinute();
      await probe.eventually(() => world.identityReads(), { within: 5000, label: "the parent identity request really failed", until: values => values.includes(fault.status) });
      const documentStatus = await world.documentReadStatus();
      expect(documentStatus).toBe(200);
      // Wait for either the old failure surface or the retained recovery, so a
      // base failure witnesses owner removal rather than only changed copy.
      await user.see({ text: fault.status === 401 ? /Sign in again to restore this workspace\.|Workspace sign-in fixture/ : /Couldn't verify this workspace\.|Workbot can't reach OpenWork right now\./ });
      expect((await probe.dom(".ow-office-frame")).elements).toHaveLength(1);
      expect(world.officeCloses()).toHaveLength(closes);
      await user.see({ text: fault.message });
      await probe.eventually(() => probe.dom('main[aria-label="Workspace sign-in recovery"] button:not(:disabled)'), { within: 5000, label: "identity revalidation has settled without removing the owner", until: layout => layout.elements.length === 1 });
      expect((await probe.dom("[data-workbot-retained-owner][hidden] .ow-office-frame")).elements).toHaveLength(1);
      await user.notSee({ role: "textbox", label: "Document text" });
      await user.notSee({ text: "Project brief.txt" });
      evidence.recordAssertionEvidence("Parent revalidation does not invoke Office-session discard", `Identity response=${fault.status}; document response=${documentStatus}; Office close attempts before/after=${closes}/${world.officeCloses().length}; the mounted owner is hidden.`, documentStatus === 200 && world.officeCloses().length === closes);
      await user.screenshot();
    });
    await step("after: fresh identity and file checks restore the draft without reopening Office", async () => {
      world.restoreIdentityService();
      await user.click({ role: "button", label: "Check sign-in" });
      await user.see({ role: "button", label: "Check access and restore tabs" });
      await user.click({ role: "button", label: "Check access and restore tabs" });
      await user.click({ role: "button", label: "Project brief.txt, unsaved changes" });
      await user.see({ role: "textbox", label: "Document text" }, { value: "Retained owner draft" });
      expect(world.officeCloses()).toHaveLength(closes);
      expect(world.officeLaunches()).toHaveLength(launches);
      evidence.recordAssertionEvidence("The same owner resumes after authorization", `Office launches=${world.officeLaunches().length} (unchanged); closes=${world.officeCloses().length} (unchanged); document writes=${world.documentWrites().length}. Unsent engine edits remain outside this proof.`, world.officeLaunches().length === launches && world.officeCloses().length === closes && world.documentWrites().length === 0);
      await user.screenshot();
    });
  });
}

test("a different signed-in person cannot see a retained owner's open portal", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: the member has a draft and an open workspace navigation dialog", async () => {
    await user.navigate(`${world.url}documents`);
    await user.click({ role: "button", label: "Project brief.txt", nth: 0 });
    await user.type({ role: "textbox", label: "Document text" }, "Private owner draft", { replace: true });
    await user.click({ role: "button", label: "Open workspace navigation" });
    await user.see({ role: "button", label: "Open Project brief.txt" });
    evidence.recordAssertionEvidence("The portal really contains the original owner's metadata", "The navigation dialog is open with the document's filename", (await probe.dom('[role="dialog"]')).elements.length === 1);
    await user.screenshot();
  });
  await step("after: a different account masks the portal as well as the retained document", async () => {
    world.useOtherIdentity();
    await world.reconnectAfterStaleMinute();
    await user.see({ text: "The signed-in account or workspace changed. Retained documents are locked." });
    await user.notSee({ role: "button", label: "Open Project brief.txt" });
    await user.notSee({ role: "textbox", label: "Document text" });
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Portals cannot escape the masked owner's scope", "The dialog DOM is retained but invisible and inert; another account sees no cached filename or draft", world.identityScopes().some(value => value.principalId === "user_other" && value.status === 200));
    await user.screenshot();
  });
  await step("after: the original account can use recovery without an old modal trapping it", async () => {
    world.restoreIdentity();
    await user.click({ role: "button", label: "Check sign-in" });
    await user.see({ role: "button", label: "Close workspace navigation" });
    await user.click({ role: "button", label: "Close workspace navigation" });
    await probe.eventually(() => probe.dom('[role="dialog"]'), { within: 5000, label: "the restored navigation dialog has finished closing", until: layout => layout.elements.length === 0 });
    await user.notSee({ role: "button", label: "Close workspace navigation" });
    await user.click({ role: "button", label: "Check access and restore tabs" });
    await user.click({ role: "button", label: "Project brief.txt, unsaved changes" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Private owner draft" });
    evidence.recordAssertionEvidence("Restoration returns only the same owner's existing work", "The restored modal can close, the draft survives, and no document write was replayed", world.documentWrites().length === 0);
    await user.screenshot();
  });
});

test("a member cannot see a denied cached folder when a later refresh is only unavailable", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: the member browses a folder without opening any editor", async () => {
    await user.click({ role: "button", label: "My Drive" });
    await user.click({ role: "button", label: "Team folder" });
    await user.see({ role: "button", label: "Folder secret.txt" });
    expect((await probe.dom(".ow-document-editor")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("The cached folder exists without an editor owner", "Folder secret.txt is visible and there are zero document editors", (await probe.dom(".ow-document-editor")).elements.length === 0);
    await user.screenshot();
  });
  await step("a denied recent read masks the cached folder while its own refresh is held", async () => {
    world.holdFolder(); world.denyRecent();
    await user.click({ role: "button", label: "Refresh documents" });
    await probe.eventually(() => world.listingReads(), { within: 5000, label: "the recent read really denied access", until: values => values.some(value => value.view === "recent" && value.status === 403) });
    await user.notSee({ text: "Folder secret.txt" });
    evidence.recordAssertionEvidence("A real authorization denial is latched without a draft", `Recent response=403; held folder reads=${world.pendingFolders()}; editors=0`, world.pendingFolders() > 0);
    await user.screenshot();
  });
  await step("after: a later unavailable response cannot turn the old denial into permission", async () => {
    world.failRecent();
    await user.click({ role: "button", label: /^(?:Try again|Check browsing access)$/ });
    await probe.eventually(() => world.listingReads(), { within: 5000, label: "the later recent read is unavailable, not authorized", until: values => values.some(value => value.view === "recent" && value.status === 503) });
    await user.notSee({ text: "Folder secret.txt" });
    world.releaseFailedFolder();
    await probe.eventually(() => probe.dom(".ow-editor-message button:not(:disabled)"), { within: 5000, label: "the failed folder refresh has settled", until: layout => layout.elements.length > 0 });
    await user.notSee({ text: "Folder secret.txt" });
    evidence.recordAssertionEvidence("Unknown does not erase denied access", "Recent changed from 403 to 503, the held folder also failed, and cached contents stayed masked", world.listingReads().some(value => value.view === "folder" && value.status === 503));
    await user.screenshot();
  });
  await step("after: only a fresh authorized scope read reveals the folder again", async () => {
    world.restoreRecent(); world.restoreFolder();
    await user.click({ role: "button", label: "Check browsing access" });
    await user.see({ role: "button", label: "Folder secret.txt" });
    evidence.recordAssertionEvidence("The denial clears on fresh authorization, not on an error transition", "The folder returned after successful identity and folder reads", world.listingReads().filter(value => value.view === "folder" && value.folder === "folder_private" && value.status === 200).length >= 2);
    await user.screenshot();
  });
});

test("a member recovers an authorized draft without losing it to another denied or unopened tab", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: two text drafts and an Office tab with a failed initial open exist", async () => {
    await user.click({ role: "button", label: "Project brief.txt" });
    await user.type({ role: "textbox", label: "Document text" }, "Keep this authorized draft", { replace: true });
    await user.click({ role: "button", label: "Budget notes.txt", nth: 0 });
    await user.type({ role: "textbox", label: "Document text" }, "Separate budget draft", { replace: true });
    await user.click({ role: "button", label: "Analysis.xlsx", nth: 0 });
    await user.see({ text: "The document service isn't available." });
    evidence.recordAssertionEvidence("The missing Office session is a real initial-open failure", `Office open attempts=${world.officeOpens().length}; mounted Office frames=${(await probe.dom(".ow-office-frame")).elements.length}`, world.officeOpens().length > 0 && (await probe.dom(".ow-office-frame")).elements.length === 0);
    await user.screenshot();
  });
  await step("after: reconnect restores the authorized draft while the other two tabs stay locked", async () => {
    world.denyBudget(); world.revokeDrive();
    await user.click({ role: "button", label: /^Files$/ });
    await user.click({ role: "button", label: "Refresh documents" });
    await user.see({ text: "Google Drive needs a fresh connection." });
    world.restoreDrive();
    await user.click({ role: "button", label: "Check access and restore tabs" });
    await user.click({ role: "button", label: "Project brief.txt, unsaved changes" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Keep this authorized draft" });
    await user.see({ text: "Some documents are still locked. Restored tabs are available." });
    await user.notSee({ text: "Budget notes.txt" });
    await user.notSee({ text: "Analysis.xlsx" });
    evidence.recordAssertionEvidence("One denied file does not hold every other draft hostage", "The authorized edited text is visible; the denied and never-opened tabs remain individually locked", world.editorReads().includes("file_budget") && (await probe.dom('[aria-label^="Locked document "]')).elements.length === 2);
    await user.screenshot();
  });
  await step("the member can discard only the denied tab and retry only the failed initial open", async () => {
    await user.click({ role: "button", label: "Discard locked document 2" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Keep this authorized draft" });
    const before = world.officeOpens().length;
    world.makeOfficeAvailable();
    await user.click({ role: "button", label: "Check access for locked document 2" });
    await user.see({ role: "button", label: "Analysis.xlsx" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Keep this authorized draft" });
    evidence.recordAssertionEvidence("Selective recovery never discards unrelated work", `Office open attempts increased ${before}→${world.officeOpens().length}; the authorized draft remains; writes=${world.documentWrites().length}. This establishes a missing session, not engine fidelity.`, world.officeOpens().length > before && world.documentWrites().length === 0);
    await user.screenshot();
  });
});

test("discarding retained recovery cannot give the next account the previous conversation cache", async ({ world, user, probe, step, evidence }) => {
  const question = "Private original-account question";
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: the original owner has a draft and a cached conversation", async () => {
    // Seed only the provider's existing conversation, not the client cache or
    // first-run UI. The ordinary thread request must load it into this owner.
    world.seedOwnerConversation(question);
    await user.navigate(`${world.url}documents`);
    await user.click({ role: "button", label: "Project brief.txt", nth: 0 });
    await user.type({ role: "textbox", label: "Document text" }, "Private original-account draft", { replace: true });
    await user.click({ role: "button", label: "Open workspace navigation" });
    await user.click({ role: "button", label: "Home" });
    await user.see({ text: question });
    evidence.recordAssertionEvidence("The old account's server-backed conversation is cached", "Its existing question is visible on Home after a real thread read; the draft has not been saved", world.messages().length === 0 && world.threadRequests().some(request => request.actor === "user_example"));
    await user.screenshot();
  });
  await step("the member must confirm discarding local recovery before switching accounts", async () => {
    world.holdOtherThread(); world.useOtherIdentity();
    await world.reconnectAfterStaleMinute();
    await user.see({ text: "The signed-in account or workspace changed. Retained documents are locked." });
    await user.notSee({ text: question });
    await user.click({ role: "button", label: "Discard retained changes" });
    await user.see({ text: "This only forgets recovery in this browser. It neither changes saved files nor cancels requests already sent." });
    await user.click({ role: "button", label: "Keep recovery" });
    await user.see({ role: "button", label: "Discard retained changes" });
    evidence.recordAssertionEvidence("Keeping recovery does not adopt the new account", "The original owner's recovery stays locked and no new account thread is read", world.threadRequests().every(request => request.actor !== "user_other"));
    await user.screenshot();
    await user.click({ role: "button", label: "Discard retained changes" });
    await user.click({ role: "button", label: "Discard and switch" });
  });
  await step("after: while the new account's response is held, no old cached conversation is visible", async () => {
    await probe.eventually(() => world.pendingOtherThreads(), { within: 5000, label: "the new account's actual thread response is held", until: count => count > 0 });
    expect((await probe.dom('[aria-label="Loading conversation"]')).elements).toHaveLength(1);
    await user.notSee({ text: question });
    await user.notSee({ role: "textbox", label: "Document text" });
    expect((await probe.dom("[data-workbot-retained-owner][hidden]")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("The new owner cannot borrow the previous QueryClient", "The old owner is gone and the new Home shows a skeleton while its own read is pending", world.threadRequests().some(request => request.actor === "user_other" && request.expectedUser === "user_other") && world.documentWrites().length === 0);
    await user.screenshot();
  });
  await step("after: the new account receives only its own conversation", async () => {
    world.releaseOtherThread();
    await user.see({ text: "Other account answer" });
    await user.notSee({ text: question });
    evidence.recordAssertionEvidence("Identity partitions survive the real response", "Only the second account's separately stored conversation is shown; no document write or message replay occurred", world.messages().length === 0 && world.documentWrites().length === 0);
    await user.screenshot();
  });
});
