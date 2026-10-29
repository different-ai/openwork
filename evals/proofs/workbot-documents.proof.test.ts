import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotWorkspace } from "../worlds/workbot-workspace.ts";

const test = spec.world(workbotWorkspace, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member opens and edits a Drive document while unavailable access stays blocked", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: Documents is locked while the feature is off", async () => {
    await user.navigate(`${world.url}documents?documents=off&assistant=off`);
    await user.see({ role: "button", label: "Check browsing access" });
    expect(await probe.text()).toContain("Documents is off for your workspace. An admin can turn it on.");
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
    await user.click({ role: "button", label: /^Edit$/ });
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
    await user.see({ text: "Locked recovery is kept in this tab for up to 15 minutes." });
    expect(await probe.text()).toContain("Documents is off for your workspace. An admin can turn it on.");
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
    await user.click({ role: "button", label: /^Edit$/ });
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
    await user.see({ role: "button", label: "Reconnect Google Drive" });
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
    await user.click({ role: "button", label: /^Edit$/ });
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
    // The document's 401 may already have started the parent's identity check.
    // Use its visible recovery action if it has masked the retained workspace.
    await user.click({ role: "button", label: /^(?:Check access and restore tabs|Check sign-in)$/ });
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

test("a Google Sheet opens and saves in place instead of as an Excel copy", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: a Google Sheet sits among the member's Drive files", async () => {
    await user.navigate(`${world.url}documents?assistant=off`);
    await user.see({ role: "button", label: "Trigger phrases" });
    await user.screenshot();
  });
  await step("after: the sheet opens in place with Open in Google Sheets and no Excel copy", async () => {
    await user.click({ role: "button", label: "Trigger phrases" });
    await user.see({ role: "textbox", label: "A1" }, { value: "Trigger phrase" });
    await user.see({ role: "link", label: "Open in Google Sheets" });
    await user.notSee({ text: /Excel copy|Save creates a new file/ });
    expect(world.officeRequests()).toHaveLength(0);
    evidence.recordAssertionEvidence("Google files never reach the Office editor", "The sheet opens from the Google Sheets API with zero Office editor requests", world.officeRequests().length === 0);
    await user.screenshot();
  });
  await step("after: saving writes the change to the original sheet", async () => {
    await user.click({ role: "button", label: /^Edit$/ });
    await user.type({ role: "textbox", label: "A2" }, "schedule a call", { replace: true });
    await user.see({ text: "Unsaved changes" });
    await user.click({ role: "button", label: "Save to Drive" });
    await user.see({ text: "Saved to Drive" });
    expect(world.documentWrites()).toEqual(["file_sheet"]);
    evidence.recordAssertionEvidence("A save updates the original file", "One in-place write to the sheet, no new file and no Office request", world.documentWrites().length === 1 && world.officeRequests().length === 0);
    await user.screenshot();
  });
});

test("a member previews Office files without a computer and starts editing only when enabled and requested", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: editing is off and an Office file opens as a read-only preview", async () => {
    await user.navigate(`${world.url}documents?assistant=off&editing=off`);
    await user.click({ role: "button", label: "Analysis.xlsx" });
    await user.see({ role: "textbox", label: "A1" }, { value: "Trigger phrase" });
    await user.notSee({ role: "button", label: /^Edit$/ });
    expect((await probe.dom('input[aria-label="A1"][readonly]')).elements).toHaveLength(1);
    expect(world.officeRequests()).toHaveLength(0);
    evidence.recordAssertionEvidence("Preview needs no editor session", "The Office preview is read-only with zero Office requests and no Edit action", world.officeRequests().length === 0);
    await user.screenshot();
  });
  await step("after: enabling editing offers Edit while opening still makes no Office request", async () => {
    await user.navigate(`${world.url}documents?assistant=off&editing=on`);
    await user.click({ role: "button", label: "Analysis.xlsx" });
    await user.see({ role: "button", label: /^Edit$/ });
    expect(world.officeRequests()).toHaveLength(0);
    evidence.recordAssertionEvidence("Enabling editing does not start it", "An Edit action appears beside the same preview; Office requests remain zero", world.officeRequests().length === 0);
    await user.screenshot();
  });
  await step("after: choosing Edit starts the workspace while the file stays visible", async () => {
    world.startOfficeSlowly();
    await user.click({ role: "button", label: /^Edit$/ });
    await user.see({ role: "progressbar", label: "Starting document editor" });
    await user.see({ text: "Starting your workspace for editing…" });
    await user.see({ role: "textbox", label: "A1" }, { value: "Trigger phrase" });
    expect(world.officeOpens().length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("The slow startup is actually exercised", `Office startup attempts=${world.officeOpens().length}; the spreadsheet preview remains visible`, world.officeOpens().length > 0);
    await user.screenshot();
  });
  await step("after: the loaded editor replaces the preview and can return to it", async () => {
    world.makeOfficeAvailable();
    await user.see({ role: "button", label: /^Preview$/ }, { timeoutMs: 20_000 });
    await user.notSee({ role: "progressbar", label: "Starting document editor" });
    expect(world.officeLaunches()).toHaveLength(1);
    await user.screenshot();
    await user.click({ role: "button", label: /^Preview$/ });
    await user.see({ role: "button", label: /^Edit$/ });
    await user.see({ role: "textbox", label: "A1" }, { value: "Trigger phrase" });
    await probe.eventually(() => world.officeCloses(), { within: 5000, label: "the editing session closes on return to preview", until: values => values.length === 1 });
    evidence.recordAssertionEvidence("Only the requested session ran", "One synthetic editor launch and one close; the read-only preview is available again", world.officeLaunches().length === 1 && world.officeCloses().length === 1);
    await user.screenshot();
  });
  await step("after: an unavailable editor leaves the preview and a way back", async () => {
    world.makeOfficeUnavailable();
    await user.click({ role: "button", label: /^Edit$/ });
    await user.see({ text: "The document service isn't available." });
    await user.see({ role: "button", label: "Try editor again" });
    await user.see({ role: "textbox", label: "A1" }, { value: "Trigger phrase" });
    evidence.recordAssertionEvidence("An editor failure does not prevent reading", "The preview stays visible alongside retry, Open in Drive and Cancel editing", world.officeLaunches().length === 1);
    await user.screenshot();
    await user.click({ role: "button", label: "Cancel editing" });
    await user.see({ role: "button", label: /^Edit$/ });
  });
});


test("a member keeps unsaved text when editing is turned off", async ({ world, user, probe, step, evidence }) => {
  const restoreIfLocked = async (readonly: boolean) => {
    const layout = await probe.eventually(() => probe.dom(`textarea${readonly ? "[readonly]" : ":not([readonly])"}, button`), {
      within: 5000, label: "the refreshed editing policy or its access recovery action is visible",
      until: layout => layout.elements.some(item => item.rect.width > 0 && (item.tag === "textarea" || item.text === "Check access and restore tabs")),
    });
    if (layout.elements.some(item => item.rect.width > 0 && item.text === "Check access and restore tabs")) await user.click({ role: "button", label: "Check access and restore tabs" });
  };
  await step("before: the member explicitly edits a text document", async () => {
    await user.click({ role: "button", label: "Project brief.txt" });
    await user.click({ role: "button", label: /^Edit$/ });
    await user.type({ role: "textbox", label: "Document text" }, "Keep this unsaved draft", { replace: true });
    evidence.recordAssertionEvidence("The draft precedes the editing restriction", "One unsaved text draft; zero Drive writes", world.documentWrites().length === 0);
    await user.screenshot();
  });
  await step("after: turning editing off preserves the draft as read-only", async () => {
    world.disableEditing();
    await world.reconnectAfterStaleMinute();
    await restoreIfLocked(true);
    await user.see({ text: "Editing is off for this workspace. Your draft is kept in this tab." });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Keep this unsaved draft" });
    expect((await probe.dom('textarea[readonly]')).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("An editing restriction does not discard unsaved text", "The retained draft is read-only and has made zero Drive writes", world.documentWrites().length === 0);
    await user.screenshot();
  });
  await step("after: restoring editing allows the same draft to save", async () => {
    world.enableEditing();
    await world.reconnectAfterStaleMinute();
    await restoreIfLocked(false);
    await user.click({ role: "button", label: "Save to Drive" });
    await user.see({ text: "Saved to Drive" });
    expect(world.documentWrites()).toEqual(["file_brief"]);
    evidence.recordAssertionEvidence("Restoration uses the retained draft", "Exactly one explicit save to the original file", world.documentWrites().length === 1);
    await user.screenshot();
  });
});

test("a member reads a document without editing notices and finds editing details beside the tabs", async ({ world, user, probe, step, evidence }) => {
  const notice = "Text editing. Original document layout and other content are retained when you save.";
  await user.resizeViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  await step("before: editing is off and the preview has no explanatory row", async () => {
    await user.navigate(`${world.url}documents?assistant=off&editing=off&notice=on`);
    await user.click({ role: "button", label: "Project brief.txt" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Project overview", editable: false });
    await user.notSee({ text: notice });
    await user.notSee({ role: "button", label: "Document information" });
    await user.notSee({ text: "Read-only. Editing requires write access" });
    expect((await probe.dom(".ow-document-editor > .ow-editor-message")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Preview has no editing notice row", "The read-only preview shows its content with zero notice rows and no editing-information control", world.officeRequests().length === 0);
    await user.screenshot();
  });
  await step("after: an editable document keeps its details in a tooltip beside the tabs", async () => {
    await user.navigate(`${world.url}documents?assistant=off&editing=on&notice=on`);
    await user.click({ role: "button", label: "Project brief.txt" });
    await user.notSee({ role: "button", label: "Document information" });
    await user.click({ role: "button", label: /^Edit$/ });
    await user.see({ role: "button", label: "Document information" });
    await user.notSee({ text: notice });
    await user.hover({ role: "button", label: "Document information" });
    await user.see({ text: notice });
    expect((await probe.dom(".ow-document-editor > .ow-editor-message")).elements).toHaveLength(0);
    const trigger = (await probe.dom(".ow-document-information")).elements[0]!;
    const tabs = (await probe.dom(".ow-document-tabs")).elements[0]!;
    evidence.recordAssertionEvidence("Details are beside the tabs instead of above the document", `Notice rows=0; information button x=${Math.round(trigger.rect.left)}, tab row x=${Math.round(tabs.rect.left)}`, trigger.rect.left > tabs.rect.left);
    await user.screenshot();
  });
  await step("after: the tooltip fits a narrow window and dismisses with Escape", async () => {
    await user.resizeViewport({ width: 600, height: 800, deviceScaleFactor: 1 });
    await user.hover({ role: "button", label: "Document information" });
    await user.see({ text: notice });
    const layout = await probe.dom(".ow-document-information-tooltip");
    const popup = layout.elements[0]!;
    expect(popup.rect.left).toBeGreaterThanOrEqual(0);
    expect(popup.rect.right).toBeLessThanOrEqual(layout.viewportWidth);
    evidence.recordAssertionEvidence("Tooltip placement stays inside the window", `Window=${layout.viewportWidth}px; tooltip left=${Math.round(popup.rect.left)}, right=${Math.round(popup.rect.right)}`, popup.rect.left >= 0 && popup.rect.right <= layout.viewportWidth);
    await user.screenshot();
    await user.press("Escape");
    await probe.eventually(() => probe.dom(".ow-document-information-tooltip"), { within: 5000, label: "the tooltip has finished closing after Escape", until: layout => layout.elements.every(item => item.rect.width === 0) });
    await user.notSee({ text: notice });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Project overview", editable: true });
  });
});

test("document previews avoid connection reloads and keep their viewer stable across file types", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  await step("before: a spreadsheet opens directly into its read-only preview", async () => {
    await user.navigate(`${world.url}documents?assistant=off&editing=off&previews=on`);
    await user.click({ role: "button", label: "Trigger phrases" });
    await user.see({ role: "textbox", label: "A1" }, { value: "Trigger phrase", editable: false });
    // notSee observes the interval, catching the old second-request loading flash.
    await user.notSee({ label: "Opening document" });
    // React development StrictMode may retry the initial request, but selecting
    // its connection must never initiate another read with that connection.
    expect(world.editorConnections().length).toBeGreaterThan(0);
    expect(world.editorConnections().every(connection => connection === null)).toBe(true);
    await user.screenshot();
  });
  await step("after: spreadsheets and documents avoid connection reloads and reuse open previews", async () => {
    for (const name of ["Analysis.xlsx", "Project plan.docx", "Project plan"]) {
      await user.click({ role: "button", label: /^Files$/ });
      await user.click({ role: "button", label: name });
      if (name === "Analysis.xlsx") await user.see({ role: "textbox", label: "A1" }, { value: "Trigger phrase", editable: false });
      else await user.see({ text: "A readable project plan" });
      await user.notSee({ label: "Opening document" });
    }
    const readsBeforeReturn = world.editorReads();
    await user.click({ role: "button", label: "Trigger phrases" });
    await user.see({ role: "textbox", label: "A1" }, { value: "Trigger phrase", editable: false });
    await user.notSee({ label: "Opening document" });
    expect(world.editorReads()).toEqual(readsBeforeReturn);
    for (const id of ["file_sheet", "file_office", "file_docx", "file_doc"]) expect(world.editorReads().filter(read => read === id).length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("Previews do not reopen after selecting a connection", "Sheets, XLSX, Docs and DOCX made no connection-triggered reload; returning to a tab sent no request", world.editorConnections().every(connection => connection === null));
    await user.screenshot();
  });
  await step("after: PDF, Slides and images keep one mounted viewer while protected bytes arrive", async () => {
    for (const [id, name, label] of [["file_pdf", "Project plan.pdf", "PDF"], ["file_slides", "Project slides", "PDF"], ["file_image", "Project image.png", "image"]]) {
      world.holdPreviewContent();
      await user.click({ role: "button", label: /^Files$/ });
      await user.click({ role: "button", label: name });
      await user.see({ text: `Loading ${label} preview…` });
      await probe.eventually(() => world.contentReads(), { within: 5000, label: "the protected preview request has started", until: values => values.includes(id) });
      expect((await probe.dom('.ow-editor-binary[aria-busy="true"]')).elements).toHaveLength(1);
      await user.screenshot();
      world.releasePreviewContent();
      await probe.eventually(() => probe.dom('.ow-editor-binary[aria-busy="true"]'), { within: 10_000, label: "the preview viewer has finished loading", until: layout => layout.elements.length === 0 });
      await user.notSee({ text: `Loading ${label} preview…` });
      expect(await probe.text()).not.toContain("Couldn't load this preview.");
      expect(world.editorReads().filter(read => read === id).length).toBeGreaterThan(0);
      expect(world.contentReads().filter(read => read === id)).toHaveLength(1);
    }
    evidence.recordAssertionEvidence("Binary previews stay mounted during loading", "PDF, native Slides PDF export and PNG each used one content read; zero Office requests or writes", world.officeRequests().length === 0 && world.documentWrites().length === 0);
    await user.screenshot();
  });
});
