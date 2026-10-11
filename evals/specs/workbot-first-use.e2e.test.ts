import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotThreadWorld } from "../worlds/workbot-thread.ts";
import { workbotFirstUse, workbotGreetingRecovery, workbotModelGreetingRecovery } from "../worlds/workbot-first-use.ts";

const test = spec.world(workbotFirstUse, { resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 900_000 });
const composer = { label: "Message Workbot" };

test("a member understands Workbot and keeps chatting while a real background job runs", async ({ world, user, probe, seed, step, evidence }) => {
  await step("before: the member has no conversation or work in progress", async () => {
    await user.navigate(world.url);
    await user.see({ text: "I'm Workbot." });
    expect(world.witness().greetingRequests).toBe(0);
    await user.screenshot();
    evidence.recordAssertionEvidence("The member sees what Workbot does before any automatic lookup", "The welcome names connected apps and longer jobs; the model has not been called.", true);
  });
  await step("the member chooses their apps before Workbot checks their day", async () => {
    await probe.eventually(async () => (await probe.dom("button:not([disabled])")).elements.some((button) => button.text === "Get started"), { within: 30_000, label: "The connection choice is ready" });
    await user.click("Get started");
    await user.see({ text: "You're all connected" });
    await probe.eventually(async () => world.witness().greetingRequests > 0, { within: 30_000, label: "With all apps connected, the greeting starts while the member reads the next screen" });
    await user.click("Start chatting");
    await user.see({ text: world.hello }, { timeoutMs: 60_000 });
    await user.see(composer, { editable: true });
    expect(world.witness().greetingWritesRejected).toBe(true);
    expect(world.witness().greetingLocalWritesRejected).toBe(true);
    expect(world.witness().tokenEscalationBlocked).toBe(true);
    expect(await world.anonymousStatus()).toBe(401);
    await user.screenshot();
    evidence.recordAssertionEvidence("The first greeting is durable and cannot change apps or memory", "The model's attempted connected-app and memory writes were rejected, the greeting is visible, and an unsigned visitor cannot read the conversation.", true);
  });
  await step("after: a job stays visible while the member asks another question", async () => {
    await user.type(composer, world.job);
    await user.click({ role: "button", label: "Send" });
    await user.see({ text: world.title }, { timeoutMs: 60_000 });
    await user.see({ role: "button", text: "Stop" });
    await user.type(composer, "What is two plus two?");
    await user.click({ role: "button", label: "Send" });
    await probe.eventually(async () => {
      const pane = (await probe.dom(".workbot-scroll")).elements[0];
      const reply = (await probe.dom('ol[aria-label="Conversation"] > li:last-child')).elements[0];
      return !!pane && !!reply && reply.text.includes("Four.") && reply.rect.bottom <= pane.rect.bottom + 1;
    }, { label: "The latest reply stays in the thread", within: 30_000 });
    await user.see({ text: "Four." });
    expect(await probe.text()).toContain(world.hello);
    await user.see({ text: world.title });
    expect(world.witness().taskRequests).toBeGreaterThan(0);
    expect(world.witness().titleStayedOutOfSystem).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence("Background work is real and leaves the conversation usable", "The runner started a task; a second question was answered with the task and first greeting still visible. Task titles remained outside system instructions.", true);
  });
  await step("the finished job delivers a file and survives a reload", async () => {
    await user.see({ text: "Your launch brief is ready." }, { timeoutMs: 90_000 });
    await user.notSee({ role: "button", text: "Stop" });
    expect(JSON.stringify(await world.files())).toContain("launch-brief.md");
    expect(world.witness().reportWritesRejected).toBe(true);
    await user.reload();
    await user.see({ text: world.hello });
    await user.see({ text: "Your launch brief is ready." });
    await user.notSee({ role: "button", text: "Get started" });
    await user.screenshot();
    evidence.recordAssertionEvidence("The result remains available without granting a report permission to act", "The saved launch-brief.md and completion message remain; a write attempted by the report turn was refused. Reload preserves the greeting.", true);
  });
  await step("the member stops another job without losing their saved result", async () => {
    await user.type(composer, world.job);
    await user.click({ role: "button", label: "Send" });
    await user.see({ role: "button", text: "Stop" }, { timeoutMs: 30_000 });
    await user.see({ text: "I'm drafting the launch brief." });
    await user.click({ role: "button", text: "Stop" });
    await user.see({ text: "Stopped" }, { timeoutMs: 30_000 });
    await user.notSee({ role: "button", text: "Stop" });
    expect(JSON.stringify(await world.thread())).toContain('"status":"stopped"');
    expect(JSON.stringify(await world.files())).toContain("launch-brief.md");
    await user.screenshot();
    evidence.recordAssertionEvidence("Stop changes the actual job state and preserves earlier work", "The runner reports stopped, the running control disappears, and the completed launch brief remains available.", true);
  });
  await step("a failed job stays visible with an honest outcome", async () => {
    await user.type(composer, "Draft another brief with the unavailable provider.");
    await user.click({ role: "button", label: "Send" });
    await user.see({ text: "Couldn't finish" }, { timeoutMs: 60_000 });
    await user.see({ text: "I couldn't finish the brief." });
    expect(JSON.stringify(await world.thread())).toContain('"status":"failed"');
    await user.see(composer, { editable: true });
    await user.screenshot();
    evidence.recordAssertionEvidence("The UI reports failure from runner state", "The unavailable model produced a failed task and an explanation, while the conversation stayed usable.", true);
  });
  await step("the member retries the failed job from its card", async () => {
    await probe.eventually(async () => (await probe.dom("button:not([disabled])")).elements.some((button) => button.text === "Try again"), { within: 30_000, label: "The failed job can be retried" });
    await user.click({ role: "button", text: "Try again" });
    await user.see({ text: "Retry the brief" }, { timeoutMs: 30_000 });
    await user.see({ role: "button", text: "Stop" });
    await user.see({ text: "I'm trying the brief again." });
    await user.screenshot();
    evidence.recordAssertionEvidence("Retry starts a new job from the member's explicit action", "The failed card's action sent the retry request and a new runner task is visible with Stop.", true);
  });
  await step("a workspace with Workbot disabled does not expose its connections", async () => {
    await user.click({ role: "button", text: "Stop" });
    const disabled = await seed.api(world.den.admin, `/v1/admin/organizations/${world.orgId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { workbot: false, headlessAutomations: false } }) });
    expect(disabled.response.ok).toBe(true);
    const connections = await world.denConnections();
    expect(connections.status).toBe(403);
    expect(JSON.stringify(connections.body)).not.toContain('"connections"');
    await probe.eventually(() => world.appConnectionsStatus(), { within: 45_000, until: (status) => status === 409, label: "The Workbot host refreshes the workspace's disabled state" });
    await user.reload();
    await user.see({ text: "Workbot isn't on for your organization yet." });
    await user.screenshot();
    evidence.recordAssertionEvidence("Disabled Workbot refuses connection discovery before loading facts", "The member's Den request returns 403 with no connection data; the host returns 409 and shows the workspace as disabled.", true);
  });
});

/** Both ways the hello can fail end the same: the drawn greeting, then this one line. */
const helloFailed = "I couldn't check your day just now.";
const drawnGreeting = "What can I take off your plate today?";

const modelRecovery = spec.world(workbotModelGreetingRecovery, { resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 900_000 });
modelRecovery("a member retries a greeting that failed after it started", async ({ world, user, probe, step, evidence }) => {
  await step("before: the greeting starts but its model cannot answer", async () => {
    await user.navigate(world.url);
    await probe.eventually(async () => (await probe.dom("button:not([disabled])")).elements.some((button) => button.text === "Get started"), { within: 30_000, label: "The connection choice is ready" });
    await user.click("Get started");
    await user.click("Start chatting");
    await user.see({ role: "button", text: "Try again" }, { timeoutMs: 60_000 });
    await user.see({ text: helloFailed });
    await user.see({ text: drawnGreeting });
    expect(world.witness().rejectedGreetingModels).toBe(1);
    await user.screenshot();
    evidence.recordAssertionEvidence("A greeting that failed after starting reads like one that couldn't start", "The runner accepted the turn and its model failed; the drawn greeting stays, with one short line saying the hello didn't work and a Try again button.", true);
  });
  await step("the member retries the failed greeting", async () => {
    await user.click({ role: "button", text: "Try again" });
    await user.see({ text: world.hello }, { timeoutMs: 60_000 });
    await user.notSee({ role: "button", text: "Try again" });
    await user.notSee({ text: helloFailed });
    await user.screenshot();
    evidence.recordAssertionEvidence("The retry runs a fresh read-only greeting", "The failed greeting was replaced by a successful one and the attempted connected-app write was refused.", world.witness().greetingWritesRejected);
  });
  await step("after: the recovered greeting remains after reload", async () => {
    await user.reload();
    await user.see({ text: world.hello });
    await user.see(composer, { editable: true });
    expect(JSON.stringify(await world.thread()).split(world.hello)).toHaveLength(2);
    await user.screenshot();
    evidence.recordAssertionEvidence("The recovered conversation has one durable greeting", "Reload shows one greeting and a usable composer, without another onboarding screen.", true);
  });
});

const recovery = spec.world(workbotGreetingRecovery, { resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 900_000 });
recovery("a member retries a failed greeting without losing the conversation", async ({ world, user, probe, step, evidence }) => {
  await step("before: the runner cannot accept the member's first greeting", async () => {
    await user.navigate(world.url);
    await probe.eventually(async () => (await probe.dom("button:not([disabled])")).elements.some((button) => button.text === "Get started"), { within: 30_000, label: "The connection choice is ready" });
    await user.click("Get started");
    await user.click("Start chatting");
    await user.see({ text: helloFailed }, { timeoutMs: 60_000 });
    await user.see({ text: drawnGreeting });
    await user.see({ role: "button", text: "Try again" });
    await user.see(composer, { editable: true });
    expect(world.witness().rejectedStarts).toBe(1);
    await user.screenshot();
    evidence.recordAssertionEvidence("A failed start offers recovery in a usable conversation", "The runner refused the turn after creating an empty session; the drawn greeting stays with one short line and Try again, and the member can still type.", true);
  });
  await step("the member retries from the same conversation", async () => {
    await user.click({ role: "button", text: "Try again" });
    await user.see({ text: world.hello }, { timeoutMs: 60_000 });
    await user.notSee({ text: helloFailed });
    await user.screenshot();
    evidence.recordAssertionEvidence("An existing empty session can start its greeting", "Retry reused the session and produced the greeting instead of an endless typing state.", true);
  });
  await step("after: reload keeps one greeting and no repeated welcome", async () => {
    await user.reload();
    await user.see({ text: world.hello });
    await user.notSee({ role: "button", text: "Get started" });
    expect(JSON.stringify(await world.thread()).split(world.hello)).toHaveLength(2);
    await user.screenshot();
    evidence.recordAssertionEvidence("Recovery does not duplicate the greeting", "There is one stored greeting after retry and reload, and the welcome does not return.", true);
  });
});


const threadUI = spec.world(workbotThreadWorld, { resources: { surfaces: ["appWeb"], services: [] }, needs: { placement: "local" }, timeout: 120_000 });
threadUI("a member explicitly runs a stopped job again without changing its stopped history", async ({ world, user, probe, step, evidence }) => {
  await step("before: a stopped task stays final with Calendar polish off", async () => {
    world.respond("brief", "done");
    await user.navigate(world.url);
    await user.see({ role: "button", text: "Stop" });
    await user.click({ role: "button", text: "Stop" });
    await user.see({ text: "Stopped" });
    await user.notSee({ role: "button", text: "Run again" });
    expect(world.taskWitness()).toHaveLength(2);
    await user.screenshot();
    evidence.recordAssertionEvidence("The off switch keeps Stop final and offers no restart", "Two historical tasks remain; the stopped Meeting notes task has no Run again control.", true);
  });
  await step("after: a stopped task offers a quiet explicit Run again action", async () => {
    world.setCalendarPolish(true);
    await user.reload();
    await user.see({ role: "button", text: "Run again" });
    await user.see({ text: "Stopped" });
    expect((await probe.dom('[data-workbot-task] button button')).elements).toHaveLength(0);
    expect(world.taskWitness()).toHaveLength(2);
    await user.screenshot();
    evidence.recordAssertionEvidence("Turning on polish does not restart any stopped task", "Run again appears beside Stopped; task count remains two until the member acts.", true);
  });
  await step("the member runs the same job again and its old stopped card remains untouched", async () => {
    await user.click({ role: "button", text: "Run again" });
    await user.see({ text: 'Try the "Meeting notes" background task again.' });
    await user.see({ role: "button", text: "Stop" });
    const tasks = world.taskWitness();
    expect(tasks).toHaveLength(3);
    expect(tasks.find((task) => task.id === "notes")?.status).toBe("stopped");
    expect(tasks.at(-1)?.status).toBe("working");
    expect(tasks.at(-1)?.id).not.toBe("notes");
    expect(tasks.at(-1)?.request).toBe('Try the "Meeting notes" background task again.');
    await user.screenshot();
    evidence.recordAssertionEvidence("Run again sends the same job request as Try again and creates a separate task", `${tasks.length} fixture API tasks; original notes is stopped; new ${tasks.at(-1)?.id} is working under the explicit retry message. This proves real client submission and fixture task creation, not live runner execution.`, true);
  });
  await step("turning polish off hides Run again without interrupting the new job", async () => {
    world.setCalendarPolish(false);
    await user.reload();
    await user.notSee({ role: "button", text: "Run again" });
    await user.see({ role: "button", text: "Stop" });
    expect(world.taskWitness().at(-1)?.status).toBe("working");
    await user.screenshot();
    evidence.recordAssertionEvidence("The kill switch restores presentation without mutating work", "The new task is still working; the old stopped task has no restart action.", true);
  });
});

threadUI("a member keeps task cards in their original turn until all work finishes", async ({ world, user, probe, step, evidence }) => {
  let briefNode = 0;
  const dots = '[aria-label="Workbot is processing"] .workbot-typing-dot';
  await step("before: two jobs are still processing after Workbot has replied", async () => {
    await user.navigate(world.url);
    await user.see({ text: "Launch brief" });
    await user.see({ text: "Meeting notes" });
    expect((await probe.dom('ol > li:first-child [data-workbot-task]')).elements).toHaveLength(2);
    briefNode = await world.cardNode("brief");
    expect(briefNode).toBeGreaterThan(0);
    await user.notSee({ text: "Working on it in the background" });
    await user.notSee({ text: "Working on 2 things in the background" });
    expect((await probe.dom(dots)).elements).toHaveLength(0);
    await user.screenshot();
    evidence.recordAssertionEvidence("Running and queued cards stay with their request and carry their own progress", "Both cards are in the first conversation turn and show their own status. Workbot isn't writing anything, so there are no typing dots and no duplicate background message. API responses are synthetic; this proves the real UI, not runner execution.", true);
  });
  await step("the member keeps chatting while the first task remains in place", async () => {
    await user.type(composer, "What is two plus two?");
    await user.click({ role: "button", label: "Send" });
    await user.see({ text: "Four." });
    expect((await probe.dom('ol > li:first-child [data-workbot-task]')).elements).toHaveLength(2);
    expect(await world.cardNode("brief")).toBe(briefNode);
    expect((await probe.dom(dots)).elements).toHaveLength(0);
    await user.screenshot();
    evidence.recordAssertionEvidence("A later reply does not move running cards", "The newer reply is below the original turn, both task cards remain there, the first DOM node is unchanged, and no typing dots linger once the answer is in.", true);
  });
  await step("after: finishing one task keeps its card while the other resumes", async () => {
    world.respond("brief", "done");
    world.respond("notes", "paused");
    await user.see({ text: "Picking it back up" });
    await user.see({ text: "Done" });
    expect(await world.cardNode("brief")).toBe(briefNode);
    expect((await probe.dom('ol > li:first-child [data-workbot-task]')).elements).toHaveLength(2);
    expect((await probe.dom(dots)).elements).toHaveLength(0);
    await user.screenshot();
    evidence.recordAssertionEvidence("Completed cards remain anchored while another task resumes", "The completed brief uses the same DOM node in the first turn, and the paused task's own card says it is picking back up; background work adds no typing dots.", true);
  });
  await step("after: failed or stopped work keeps its card", async () => {
    world.respond("notes", "failed");
    await user.see({ text: "Couldn't finish" });
    world.respond("notes", "stopped");
    await user.see({ text: "Stopped" });
    expect((await probe.dom('[data-workbot-task]')).elements).toHaveLength(2);
    expect((await probe.dom(dots)).elements).toHaveLength(0);
    await user.screenshot();
    evidence.recordAssertionEvidence("Terminal outcomes keep the history in place", "Failure and Stop both leave two cards in the conversation, with no typing dots.", true);
  });
  await step("after: a foreground reply shows the dots only until its text arrives", async () => {
    world.startReply();
    const dotCount = async () => (await probe.dom(dots)).elements.length;
    await probe.eventually(dotCount, { within: 3_000, label: "Typing dots while the reply has nothing written", until: (count) => count === 3 });
    await user.screenshot();
    world.streamReply();
    await user.see({ text: "I'm still checking." });
    await probe.eventually(dotCount, { within: 3_000, label: "Streamed text replaces the typing dots", until: (count) => count === 0 });
    await user.screenshot();
    world.finishReply();
    await user.see({ text: "Four. Checked." });
    expect(await dotCount()).toBe(0);
    evidence.recordAssertionEvidence("The dots mean a reply is coming, not that something is running", "With a reply started and nothing written, three typing dots show; once its text streams the dots go, and completion leaves none.", true);
  });
  await step("the member sees Edit only when hovering their message and no Delete action", async () => {
    await user.hover(composer);
    await probe.eventually(() => world.editHidden(), { within: 2_000, label: "The edit icon fades out away from its message" });
    await user.notSee({ role: "button", label: "Edit message" });
    await user.notSee({ role: "button", label: "Delete message" });
    await user.hover({ text: "Draft the brief and meeting notes." });
    await user.see({ role: "button", label: "Edit message" });
    await user.screenshot();
    await user.click({ role: "button", label: "Edit message", nth: 0 });
    await user.see({ label: "Edit your message" }, { editable: true });
    await user.click({ role: "button", text: "Cancel" });
    await user.hover(composer);
    await probe.eventually(() => world.editHidden(), { within: 2_000, label: "The edit icon fades out away from its message" });
    await user.notSee({ role: "button", label: "Edit message" });
    await user.screenshot();
    evidence.recordAssertionEvidence("Editing is discoverable on hover and deletion is absent", "The edit icon is hidden away from the message, appears on its hover, opens the inline editor, and hides again after Cancel; no Delete message button exists.", true);
  });
  await step("a failed edit puts the message back and says why", async () => {
    await user.hover({ text: "What is two plus two?" });
    // Only the hovered message's Edit control is visible on desktop.
    await user.click({ role: "button", label: "Edit message" });
    await user.type({ label: "Edit your message" }, "What is three plus three?", { replace: true });
    await user.press("Enter");
    await user.see({ text: "That didn't send." });
    await user.see({ text: "What is two plus two?" });
    await user.notSee({ text: "What is three plus three?" });
    expect(world.editAttempts()).toBe(1);
    await user.screenshot();
    evidence.recordAssertionEvidence("A failed edit is explained, not silent", "The edit request failed; the original message returned and its reason shows under it.", true);
  });
  await step("on a phone, Edit rests under each of the member's messages without hovering", async () => {
    await world.phone();
    await user.see({ role: "button", label: "Edit message" });
    const layout = await probe.eventually(() => world.editLayout(), { within: 2_000, label: "Edit finishes fading in under each message", until: (edits) => edits.every((edit) => edit.shown) });
    const shownUnder = { shown: true, underTrailingEdge: true, tapTarget: 44 };
    expect(layout).toEqual([shownUnder, shownUnder]);
    await user.screenshot();
    await user.click({ role: "button", label: "Edit message", nth: 0 });
    await user.see({ label: "Edit your message" }, { editable: true });
    await user.click({ role: "button", text: "Cancel" });
    await user.see({ text: "Draft the brief and meeting notes." });
    evidence.recordAssertionEvidence("Touch shows Edit at rest, under each message", "With touch input at phone width and no hover, both Edit icons are visible under their bubbles' trailing edges with 44px tap targets, and a tap opens the inline editor.", true);
  });
});

threadUI("a member can read why attachments are blocked without opening a file picker, even at 320px", async ({ world, user, probe, step, evidence }) => {
  const attach = { label: "Attach files. Files aren't set up on this server; your admin can turn them on." };
  const reason = { text: "Files aren't set up on this server. Your admin can turn them on." };
  const triggerSelector = 'button[aria-disabled="true"][aria-label^="Attach files."]';
  const tooltipLayout = async (height: number) => {
    // The previous in-place hint had role=tooltip; Base UI's visual-only Tooltip has the source marker instead.
    const snapshot = await probe.dom('[data-workbot-attachment-hint], [role="tooltip"]');
    const rect = snapshot.elements[0]?.rect;
    const overflowing = snapshot.documentWidth > snapshot.viewportWidth ? await world.overflowingElements() : [];
    return {
      fits: snapshot.elements.length === 1 && Boolean(rect && rect.width > 0 && rect.height > 0
        && rect.left >= 7 && rect.top >= 7 && rect.right <= snapshot.viewportWidth - 7 && rect.bottom <= height - 7),
      noSidewaysScroll: snapshot.documentWidth <= snapshot.viewportWidth,
      description: `${snapshot.viewportWidth}×${height}; page ${snapshot.documentWidth}px${overflowing.length ? ` (past the edge: ${overflowing.join(", ")})` : ""}; tooltip ${rect ? `${Math.round(rect.left)},${Math.round(rect.top)}–${Math.round(rect.right)},${Math.round(rect.bottom)}` : "missing"}`,
    };
  };
  // notSee proves stable absence from now on; first let a dismissed hint stop painting.
  const hintCloses = (label: string) => probe.eventually(async () => (await probe.dom('[data-workbot-attachment-hint], [role="tooltip"]')).elements.filter((hint) => hint.rect.width > 0 && hint.rect.height > 0).length, {
    within: 10_000, label, until: (painted) => painted === 0,
  });
  const noFileAction = () => {
    const witness = world.fileAccessWitness();
    return witness.nativePickers.ready && witness.nativePickers.opened === 0 && witness.fileWrites.length === 0 && witness.allWrites.length === 0;
  };

  await step("before: files are unavailable but the member can still discover the attachment control", async () => {
    await user.navigate(world.url);
    await user.see(composer, { editable: true });
    await user.see(attach);
    await user.notSee({ role: "button", text: "Files" });
    const state = await world.blockedAttachmentState();
    const witness = world.fileAccessWitness();
    evidence.recordAssertionEvidence("the server's blocked file state reaches the real composer", `filesEnabled ${witness.filesEnabled}; ${witness.threadReads} thread reads; blocked control ${state.blocked}; ${state.nativeFileInputs} native file inputs; picker monitor ready ${witness.nativePickers.ready}`, !witness.filesEnabled && witness.threadReads > 0 && state.blocked && state.nativeFileInputs === 0 && noFileAction());
    expect(witness.filesEnabled).toBe(false);
    expect(witness.threadReads).toBeGreaterThan(0);
    expect(state.blocked).toBe(true);
    expect(state.nativeFileInputs).toBe(0);
    expect(noFileAction()).toBe(true);
    await user.screenshot();
  });

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 320, height: 568 }]) {
    await step(`hover shows the full blocked attachment reason at ${viewport.width}×${viewport.height}`, async () => {
      await user.resizeViewport({ ...viewport, deviceScaleFactor: 1 });
      expect((await probe.dom("html")).viewportWidth).toBe(viewport.width - 15);
      await user.hover(attach);
      await user.see(reason);
      await user.screenshot();
      if (viewport.width === 320) {
        const browser = await world.browserLayout();
        const fits = browser.documentWidth <= browser.clientWidth && browser.sendRight <= browser.composerRight - 7;
        evidence.recordAssertionEvidence("the narrow composer fits with a real classic scrollbar", `page ${browser.documentWidth}px; client ${browser.clientWidth}px; root gutter ${browser.rootScrollbarWidth}px; conversation gutter ${browser.scrollbarWidth}px; Send right ${browser.sendRight}px; composer right ${browser.composerRight}px; language ${browser.language}; locale ${browser.locale}`, fits && browser.rootScrollbarWidth === 15 && browser.scrollbarWidth > 0 && browser.language === "en-US" && browser.locale === "en-US");
        expect(browser.rootScrollbarWidth).toBe(15);
        expect(browser.clientWidth).toBe(305);
        expect(browser.scrollbarWidth).toBeGreaterThan(0);
        expect(browser.language).toBe("en-US");
        expect(browser.locale).toBe("en-US");
        expect(browser.documentWidth).toBeLessThanOrEqual(browser.clientWidth);
        expect(browser.sendRight).toBeLessThanOrEqual(browser.composerRight - 7);
      }
      const layout = await tooltipLayout(viewport.height);
      const state = await world.blockedAttachmentState();
      evidence.recordAssertionEvidence("the hover hint is portaled, matches its accessible label and stays entirely on screen", `${layout.description}; portaled ${state.portaled}; reason in the control's accessible name ${state.reasonInAccessibleName}; native picker opens ${world.fileAccessWitness().nativePickers.opened}`, layout.fits && layout.noSidewaysScroll && state.portaled && state.reasonInAccessibleName && noFileAction());
      expect(layout.fits && layout.noSidewaysScroll).toBe(true);
      expect(state.portaled && state.reasonInAccessibleName).toBe(true);
      expect(noFileAction()).toBe(true);
      await user.press("Escape");
      await hintCloses("Escape dismisses the hover hint");
      await user.notSee(reason);
      await user.see(composer, { editable: true });
    });

    await step(`keyboard focus shows the same attachment reason at ${viewport.width}×${viewport.height}`, async () => {
      await user.hover(composer);
      await user.click(composer);
      await user.press("Shift+Tab");
      await user.see(reason);
      const focused = (await probe.dom(triggerSelector)).elements[0]?.focused === true;
      await user.screenshot();
      const layout = await tooltipLayout(viewport.height);
      const state = await world.blockedAttachmentState();
      await user.press("Escape");
      await hintCloses("Escape dismisses the attachment hint");
      await user.notSee(reason);
      const after = await world.blockedAttachmentState();
      evidence.recordAssertionEvidence("Escape dismisses the keyboard hint without moving focus or accessing files", `${layout.description}; blocked control focused before ${focused}, after Escape ${after.focused}; ${state.nativeFileInputs} native file inputs; ${world.fileAccessWitness().fileWrites.length} file writes`, layout.fits && layout.noSidewaysScroll && focused && state.reasonInAccessibleName && after.focused && noFileAction());
      expect(layout.fits && layout.noSidewaysScroll).toBe(true);
      expect(focused && state.reasonInAccessibleName && after.focused).toBe(true);
      expect(noFileAction()).toBe(true);
    });

    await step(`clicking the blocked attachment control explains why at ${viewport.width}×${viewport.height}`, async () => {
      await user.hover(composer);
      await user.click(composer);
      await hintCloses("moving to the composer hides the attachment hint");
      await user.notSee(reason);
      const before = world.fileAccessWitness().blockedPointerClicks;
      const inputKind = viewport.width === 320 ? "touch" : "mouse";
      // The fixture's narrow trusted-input helper intentionally clicks this aria-disabled explanation control;
      // normal user.click correctly refuses disabled actions. The phone tap has no preceding hover, and no
      // ARIA attributes or DOM nodes are modified.
      await world.clickBlockedAttachment(inputKind);
      await user.see(reason);
      await user.screenshot();
      const layout = await tooltipLayout(viewport.height);
      const state = await world.blockedAttachmentState();
      await user.press("Escape");
      await hintCloses("Escape dismisses the attachment hint");
      await user.notSee(reason);
      const after = await world.blockedAttachmentState();
      const witness = world.fileAccessWitness();
      evidence.recordAssertionEvidence("the real blocked-control click opens only its reason, never a picker or upload", `${layout.description}; trusted ${inputKind} clicks ${before}→${witness.blockedPointerClicks}; focused after Escape ${after.focused}; picker opens ${witness.nativePickers.opened}; file writes ${witness.fileWrites.length}; all writes ${witness.allWrites.length}`, layout.fits && layout.noSidewaysScroll && state.blocked && state.reasonInAccessibleName && after.focused && witness.blockedPointerClicks === before + 1 && noFileAction());
      expect(layout.fits && layout.noSidewaysScroll).toBe(true);
      expect(state.blocked && state.reasonInAccessibleName && after.focused).toBe(true);
      expect(witness.blockedPointerClicks).toBe(before + 1);
      expect(witness.nativePickers).toEqual({ ready: true, opened: 0 });
      expect(witness.fileWrites).toEqual([]);
      expect(witness.allWrites).toEqual([]);
      expect(after.nativeFileInputs).toBe(0);
    });
  }

  await step("after: the member keeps writing without enabling files or changing their running work", async () => {
    await user.type(composer, "Keep this draft while attachments are unavailable");
    await user.see(composer, { value: "Keep this draft while attachments are unavailable" });
    await user.notSee(reason);
    await user.see({ text: "Launch brief" });
    await user.see({ text: "Meeting notes" });
    const tasks = (await probe.dom('[data-workbot-task]')).elements.length;
    const witness = world.fileAccessWitness();
    evidence.recordAssertionEvidence("the attachment hint leaves the conversation and file policy unchanged", `${tasks} original task cards; ${witness.blockedPointerClicks} trusted blocked-control clicks; native picker opens ${witness.nativePickers.opened}; file writes ${witness.fileWrites.length}; conversation writes ${witness.allWrites.length}; filesEnabled ${witness.filesEnabled}`, tasks === 2 && witness.blockedPointerClicks === 2 && !witness.filesEnabled && noFileAction());
    expect(tasks).toBe(2);
    expect(witness.blockedPointerClicks).toBe(2);
    expect(witness.filesEnabled).toBe(false);
    expect(noFileAction()).toBe(true);
    await user.screenshot();
  });
});
