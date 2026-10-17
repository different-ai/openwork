import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Surface } from "@openwork/testkit";
import { workshopNarrative, type NarrativeRow } from "../worlds/workshop-narrative.ts";
import { WORKSHOP_SCENES, WORKSHOP_LIMITS, verifyWorkshopScene, type SceneEvidence } from "../worlds/workshop-narrative-contract.ts";
import { observedServiceCalls, observedNativeWorkflowCalls, sharingWitness, workflowWitness } from "../worlds/workshop-narrative-witnesses.ts";
import type { WorkflowWitnessContext } from "../worlds/workshop-workflow-witness.ts";
import { WORKSHOP_SHOT_IDS } from "../docs-shots/shots/workshop.ts";
import { workshopTurnTerminal as terminal } from "../worlds/workshop-turn-diagnostics.ts";
import { workshopWorkflowFrame } from "../worlds/workshop-workflow-frame.ts";

const test = spec.world(workshopNarrative, {
  timeout: 420_000,
  needs: { placement: "local", commands: ["bun", "infisical"], optIn: ["OPENWORK_WORKSHOP_NARRATIVE"] },
  resources: { surfaces: ["appWeb", "web"], services: ["den"] },
});
const profile = process.env.OPENWORK_WORKSHOP_PROFILE ?? "gpt-sol-fast";
const recipientPrompt = "As Nora Patel, discover the saved Acme product comparison Workflow shared with me. Run its actual saved version with customerRequest 'Compare Atlas 2 for line-side replenishment'. Its saved comparison output must assess both Atlas 2 and Atlas Lift even though this request focuses on Atlas 2. Verify its real execution receipt and output, including that its latest saved result is this line-side execution. Do not create another Workflow, impersonate Alex, or claim an owner run as mine. Use only our connected fictional services; do not send mail.";
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}; }

test("a fictional team rehearses every workshop scene without hidden task writes", { timeout: 1_800_000 }, async ({ world, user, agent, probe, step, evidence }) => {
  const matrixStarted = Date.now();
  try {
    if (!world.ready) {
      for (const scene of WORKSHOP_SCENES) await step(`${scene.id}: ${scene.title} is blocked by the exact-model prerequisite`, async () => {
        const row: NarrativeRow = { id: scene.id, title: scene.title, status: "BLOCKED", reason: world.blockedReason, latencyMs: 0 };
        world.recordRow(row);
        evidence.recordAssertionEvidence(`${scene.id} exact model prerequisite`, row.reason, false);
      });
    } else {
      const appUser = user.on(world.app);
      const appAgent = agent.on(world.app);
      await appUser.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
      await appAgent.createSession("Acme workshop narrative");
      await appUser.see("composer");
      for (const scene of WORKSHOP_SCENES) {
        await step(`${scene.id}: ${scene.title}`, async () => {
          const started = Date.now();
          let row: NarrativeRow;
          try {
            if (Date.now() - matrixStarted > WORKSHOP_LIMITS.matrixMs) {
              row = { id: scene.id, title: scene.title, status: "BLOCKED", reason: "Common per-model matrix time budget exhausted", latencyMs: 0 };
            } else if (scene.id === "T08") {
              const before = await world.observe();
              const policyMessage = (Array.isArray(before.messages) ? before.messages : []).map(record).filter((message) => record(message.info).role === "assistant").at(-1);
              const messageId = String(record(policyMessage?.info).id ?? "");
              if (!before.sessionId || !messageId) throw new Error("No actual preceding policy answer exists for feedback");
              const negative = "Not helpful: the missing-policy uncertainty and next step were not clear enough.";
              const note = `${negative}\n\nReference: session ${before.sessionId}; response ${messageId}.`;
              const prior = await world.readFeedback();
              await appUser.click({ role: "button", label: "Account menu" });
              await appUser.click({ role: "menuitem", label: "Feedback" });
              const surface = await world.feedbackSurface();
              await user.on(surface).resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
              await user.on(surface).type({ placeholder: "Jane Doe" }, "Alex Chen");
              await user.on(surface).type({ placeholder: "jane@company.com" }, "alex@acme.test");
              await user.on(surface).type({ placeholder: "What were you trying to do? What did you expect? What actually happened?" }, note, { intervalMs: 20 });
              await user.on(surface).see({ placeholder: "Jane Doe" }, { value: "Alex Chen" });
              await user.on(surface).see({ placeholder: "jane@company.com" }, { value: "alex@acme.test" });
              await user.on(surface).see({ placeholder: "What were you trying to do? What did you expect? What actually happened?" }, { value: note });
              await world.assertScreenshotSafe(surface); await user.on(surface).screenshot();
              await user.on(surface).click({ role: "button", label: "Send feedback" });
              await user.on(surface).see({ text: "Feedback sent" }, { timeoutMs: 45000 });
              const persisted = await world.readFeedback();
              await world.retainFeedbackEvidence();
              const thread = persisted.threads.find((item) => !prior.threads.some((old) => old.id === item.id) && item.input.components.some((component) => component.componentPlainText.plainText.includes(note)));
              const after = await world.observe();
              const verdict = verifyWorkshopScene({ id: "T08", before, after, expected: { ...world.expectedModel, sessionId: before.sessionId }, elapsedMs: Date.now() - started, feedback: thread ? { feedbackId: thread.id, sessionId: before.sessionId, messageId, text: negative, submittedText: note, persisted: true, source: "product-ui", observedViaReadback: true, providerOperation: "createThread", openedFromApp: true } : undefined });
              await world.assertScreenshotSafe(surface); await user.on(surface).screenshot();
              await world.docshots.capture("workshop-t08-final", surface, { expect: ["Feedback sent"], never: ["Something went wrong"], route: /\/feedback/ });
              row = { id: scene.id, title: scene.title, status: verdict.status, reason: verdict.reasons.join("; ") || "Actual app-opened form persisted the negative note through the existing backend and owned provider", latencyMs: Date.now() - started, sessionId: before.sessionId, evidence: { feedbackId: thread?.id, referencedMessageId: messageId, providerOperation: "createThread" } };
            } else {
              await world.assertIsolation();
              await appAgent.createSession(`${scene.id} — ${scene.title}`);
              const before = await world.observe();
              const nativeBefore = await world.nativeWorkflows();
              const inferenceStart = before.inference.length;
              const oldIds = new Set((Array.isArray(before.messages) ? before.messages : []).map((message) => record(record(message).info).id));
              await appUser.type("composer", scene.prompt, { replace: true });
              await appUser.click("Run task");
              await appUser.see({ text: scene.prompt });
              let completed = true;
              await probe.eventually(() => world.current(), { within: scene.limitMs, intervalMs: 500, label: `${scene.id} real paid assistant completion`, until: (value) => terminal(value.messages, oldIds) }).catch(async () => {
                completed = false;
                await world.captureTurnDiagnostic(`${scene.id}-before-stop`).catch(() => undefined);
                await appAgent.run("composer.stop").catch(() => undefined);
                world.abortInferenceAfter(inferenceStart + 1);
              });
              let scheduled: { job: Record<string, unknown>; event: Record<string, unknown>; dueWall: number; inferenceStart: number } | undefined;
              let scheduleRegistration: SceneEvidence["scheduleRegistration"];
              if (scene.id === "T10") {
                await world.settleInference();
                scheduleRegistration = await world.observe();
                const clock = record(await world.advanceNewsClock()); // Only advances time and emits due jobs.
                const event = Array.isArray(clock.events) ? clock.events.map(record).find((item) => item.status === "due") : undefined;
                const job = event && Array.isArray(clock.jobs) ? clock.jobs.map(record).find((item) => item.id === event.jobId) : undefined;
                if (job && event && typeof job.instructions === "string" && completed && Date.now() - started < scene.limitMs - 5000) {
                  const dueBefore = await world.current();
                  const dueIds = new Set((Array.isArray(dueBefore.messages) ? dueBefore.messages : []).map((message) => record(record(message).info).id));
                  scheduled = { job, event, dueWall: Date.now(), inferenceStart: (await world.observe()).inference.length };
                  // This dispatcher submits the MODEL'S saved job, never a scripted assistant result or a business write.
                  await appUser.type("composer", `${job.instructions}\n\nThe isolated scheduler has now reached 09:00 America/Los_Angeles on 2026-10-16. Execute this due job using actual connected news/OneDrive/Outlook calls, verify the results, and do not send mail or use external news.`, { replace: true });
                  await appUser.click("Run task");
                  await probe.eventually(() => world.current(), { within: Math.max(1000, scene.limitMs - (Date.now() - started)), intervalMs: 500, label: "09:00 due job actually executes paid inference", until: (value) => terminal(value.messages, dueIds) }).catch(async () => { completed = false; await world.captureTurnDiagnostic(`${scene.id}-due-before-stop`).catch(() => undefined); await appAgent.run("composer.stop").catch(() => undefined); });
                }
              }
              if (!completed) world.abortInferenceAfter(inferenceStart + 1);
              await world.settleInference();
              const ownerAfter = await world.observe();
              let recipientContext: WorkflowWitnessContext["recipient"];
              if (scene.id === "T03" && completed && Date.now() - started < scene.limitMs - 5000) {
                const recipientAgent = agent.on(world.recipientApp);
                await recipientAgent.createSession("Shared comparison as Nora");
                const recipientBefore = await world.observe("recipient");
                const recipientInferenceStart = recipientBefore.inference.length;
                const recipientIds = new Set((Array.isArray(recipientBefore.messages) ? recipientBefore.messages : []).map((message) => record(record(message).info).id));
                await user.on(world.recipientApp).type("composer", recipientPrompt, { replace: true });
                await user.on(world.recipientApp).click("Run task");
                await probe.eventually(() => world.current("recipient"), { within: Math.max(1000, scene.limitMs - (Date.now() - started)), intervalMs: 500, label: "Nora actually runs the shared Workflow", until: (value) => terminal(value.messages, recipientIds) }).catch(async () => { completed = false; await world.captureTurnDiagnostic(`${scene.id}-recipient-before-stop`, "recipient").catch(() => undefined); await recipientAgent.run("composer.stop").catch(() => undefined); world.abortInferenceAfter(recipientInferenceStart + 1); });
                await world.settleInference();
                const recipientAfter = await world.observe("recipient");
                recipientContext = { before: recipientBefore, after: recipientAfter, expected: { ...world.expectedModel, sessionId: recipientAfter.sessionId ?? "" }, inference: { upstreamModel: world.expectedModel.modelID, requests: recipientAfter.inference.slice(recipientInferenceStart) } };
                await world.assertScreenshotSafe(world.recipientApp);
                await user.on(world.recipientApp).screenshot();
              }
              const after = await world.observe();
              const nativeAfter = await world.nativeWorkflows();
              const witnessed = after.inference.slice(inferenceStart);
              const forwarded = witnessed.filter((request) => request.status !== "rejected");
              const knownCost = forwarded.every((request) => request.estimatedUsd !== null) ? forwarded.reduce((sum, request) => sum + (request.estimatedUsd ?? 0), 0) : null;
              const tokens = witnessed.every((request) => request.inputTokens !== null && request.outputTokens !== null) ? witnessed.reduce((sum, request) => sum + (request.inputTokens ?? 0) + (request.outputTokens ?? 0), 0) : undefined;
              const workflowContext: WorkflowWitnessContext = { owner: { before, after: ownerAfter, expected: { ...world.expectedModel, sessionId: ownerAfter.sessionId ?? "" }, inference: { upstreamModel: world.expectedModel.modelID, requests: ownerAfter.inference.slice(inferenceStart) } }, recipient: recipientContext };
              const check: SceneEvidence = { id: scene.id, before, after, expected: { ...world.expectedModel, sessionId: after.sessionId ?? "missing-session" }, elapsedMs: Date.now() - started, costUsd: knownCost, costKind: "estimate", tokens, scheduleRegistration, serviceCalls: [...observedServiceCalls(before, after), ...observedNativeWorkflowCalls(nativeBefore, nativeAfter, workflowContext)], ...(scene.id === "T02" ? { workflow: workflowWitness(nativeBefore, nativeAfter, workflowContext) } : {}), ...(scene.id === "T03" ? { sharing: sharingWitness(nativeBefore, nativeAfter, workflowContext) } : {}) };
              if (scene.id === "T10" && scheduled) {
                const state = record(after.microsoft), prior = record(before.microsoft);
                const oldFiles = new Set((Array.isArray(prior.files) ? prior.files : []).map((item) => record(item).id));
                const oldMails = new Set((Array.isArray(prior.messages) ? prior.messages : []).map((item) => record(item).id));
                const audit = Array.isArray(state.audit) ? state.audit.map(record).filter((entry) => typeof entry.at === "number" && entry.at >= scheduled!.dueWall && entry.status === "completed") : [];
                const digest = Array.isArray(state.files) ? state.files.map(record).find((file) => !oldFiles.has(file.id) && audit.some((entry) => entry.name === "file_write" && record(entry.output).id === file.id) && ["France", "United States", "Germany", "Japan"].every((country) => String(record(file.preview).text ?? "").includes(country))) : undefined;
                const draft = Array.isArray(state.messages) ? state.messages.map(record).find((mail) => !oldMails.has(mail.id) && mail.isDraft === true && mail.parentFolderId === "drafts" && audit.some((entry) => /mail_create_(?:reply_)?draft/.test(String(entry.name)) && record(entry.output).id === mail.id)) : undefined;
                const dueWitness = after.inference.slice(scheduled.inferenceStart).find((request) => request.status === "completed");
                check.schedule = { jobId: String(scheduled.job.id), dueEventId: String(scheduled.event.id), dueAt: String(scheduled.event.dueAt), timeZone: String(scheduled.job.time_zone), clockBefore: String(record(before.news).now), clockAfter: String(record(after.news).now), inferenceExecuted: Boolean(dueWitness), deliveryExecuted: Boolean(digest && draft), digestFileId: digest ? String(digest.id) : "", draftId: draft ? String(draft.id) : "", runnerSessionId: dueWitness ? after.sessionId ?? "" : "" };
                if (dueWitness && digest && draft && after.sessionId) {
                  await world.acknowledgeScheduledExecution({ eventId: String(scheduled.event.id), sessionId: after.sessionId, digestFileId: String(digest.id), draftId: String(draft.id), inferenceWitnessSequence: dueWitness.sequence });
                  after.news = (await world.observe()).news;
                }
              }
              let verdict = verifyWorkshopScene(check);
              if (scene.id === "T05" && verdict.artifactCandidate) {
                const artifact = await world.inspectPptx(verdict.artifactCandidate.fileId, after.sessionId ?? "");
                if ("artifact" in artifact) { check.artifact = artifact.artifact; verdict = verifyWorkshopScene(check); }
                else verdict.reasons.push(artifact.reason);
              }
              if (scene.id === "T10" && !scheduled) verdict = { id: scene.id, status: "BLOCKED", reasons: ["No model-registered isolated due job was available for real paid dispatch at the 09:00 clock boundary; a manually created digest is not scheduled-execution proof.", ...verdict.reasons] };
              await world.retainSceneEvidence(check, { before: nativeBefore, after: nativeAfter }, recipientContext?.after.messages);
              const tierOk = forwarded.some((request) => request.status === "completed") && forwarded.every((request) => profile !== "gpt-sol-fast" || (request.requestedServiceTier === "priority" && (request.status !== "completed" || ["fast", "priority"].includes(request.returnedServiceTier ?? ""))));
              const reasons = [...verdict.reasons, ...(!completed ? ["Real assistant turn exceeded the common time bound or waited for approval; stopped through the product"] : []), ...(!tierOk ? ["Actual inference protocol/Fast tier was not verified for every request"] : [])];
              row = { id: scene.id, title: scene.title, status: !completed || !tierOk ? "FAIL" : verdict.status, reason: reasons.join("; ") || "Actual model calls, backend state and provenance matched", latencyMs: Date.now() - started, sessionId: after.sessionId ?? undefined, evidence: { usage: verdict.usage, requestCount: witnessed.length, rejectedBeforeUpstream: witnessed.filter((request) => request.status === "rejected").map((request) => ({ sequence: request.sequence, reason: request.rejection })), upstreamErrors: forwarded.filter((request) => request.status !== "completed").map((request) => ({ sequence: request.sequence, status: request.status, httpStatus: request.httpStatus })), inputTokens: witnessed.reduce((sum, request) => sum + (request.inputTokens ?? 0), 0), outputTokens: witnessed.reduce((sum, request) => sum + (request.outputTokens ?? 0), 0), estimatedUsd: knownCost, costStatus: knownCost === null ? "unavailable" : "estimated-not-billed", observerBoundServiceCalls: check.serviceCalls?.length ?? 0, artifact: check.artifact ? { fileId: check.artifact.fileId, sha256: check.artifact.sha256, downloadedSha256: check.artifact.downloadedSha256, validZip: check.artifact.validZip, validPresentation: check.artifact.validPresentation, slideCount: check.artifact.slideCount } : null, workflowVerification: record(check.workflow).verification ?? null, sharingVerification: record(check.sharing).verification ?? null, schedule: check.schedule ?? null } };
              await world.assertScreenshotSafe(world.app);
              await appUser.screenshot();
              // Actual browser views accompany state checks; the observer never performs the model's mutations.
              const state = record(after.microsoft), atlassian = record(after.atlassian), jira = record(atlassian.jira);
              let shotSurface: Surface = world.app;
              let shotExpectation = scene.id === "T09" ? "People Ops" : "Acme";
              let workflowPayloads: string[] = [];
              const targets: Array<{ url: string; text: string }> = [];
              const previousIssues = record(record(before.atlassian).jira); const oldIssueIds = new Set((Array.isArray(previousIssues.issues) ? previousIssues.issues : []).map((item) => record(item).id));
              const issue = Array.isArray(jira.issues) ? jira.issues.map(record).find((item) => !oldIssueIds.has(item.id) && (scene.id === "T06" ? item.summary === "Update documentation for Project XYZ" : scene.id === "T07" && item.project === "ITSD")) : undefined;
              if ((scene.id === "T06" || scene.id === "T07") && issue) targets.push({ url: `${world.urls.jira}/browse/${issue.key}`, text: scene.id === "T06" ? "Description" : "Windows login" });
              if (scene.id === "T11") { const meeting = Array.isArray(state.events) ? state.events.map(record).find((event) => event.subject === "Acme Atlas review") : undefined; if (meeting) targets.push({ url: `${world.urls.outlook}?event=${encodeURIComponent(String(meeting.id))}`, text: "Acme Atlas review" }); }
              const previousFiles = record(before.microsoft); const oldFileIds = new Set((Array.isArray(previousFiles.files) ? previousFiles.files : []).map((file) => record(file).id));
              const createdFiles = Array.isArray(state.files) ? state.files.map(record).filter((file) => !oldFileIds.has(file.id) && !file.folder) : [];
              if (["T01", "T04", "T05", "T10"].includes(scene.id)) {
                const file = scene.id === "T05" ? createdFiles.find((file) => /\.pptx$/i.test(String(file.name))) : createdFiles.find((file) => typeof record(file.preview).text === "string");
                if (file) targets.push({ url: `${world.urls.oneDrive}?item=${encodeURIComponent(String(file.id))}`, text: String(file.name) });
              }
              const confluence = record(atlassian.confluence); const pages = Array.isArray(confluence.pages) ? confluence.pages.map(record) : [];
              if (scene.id === "T09" || scene.id === "T12") { const page = pages.find((item) => item.title === "Working at the office"); if (page) targets.push({ url: `${world.urls.confluence}/pages/${page.id}`, text: scene.id === "T12" && verdict.status === "PASS" ? "Workshop review: office guidance checked" : "Working at the office" }); }
              if (["T01", "T12"].includes(scene.id)) {
                const oldMailIds = new Set((Array.isArray(previousFiles.messages) ? previousFiles.messages : []).map((mail) => record(mail).id));
                const draft = Array.isArray(state.messages) ? state.messages.map(record).find((mail) => mail.isDraft && !oldMailIds.has(mail.id)) : undefined;
                if (draft) targets.push({ url: `${world.urls.outlook}?message=${encodeURIComponent(String(draft.id))}`, text: "Edit draft" });
              }
              for (const target of targets) {
                await user.on(world.serviceBrowser).navigate(target.url);
                await user.on(world.serviceBrowser).see({ text: target.text });
                if (scene.id === "T06") {
                  await user.on(world.controlBrowser).navigate(`${world.urls.controlJira}/browse/${issue?.key}`);
                  await user.on(world.controlBrowser).see({ text: "Update documentation for Project XYZ" });
                  const beforeLocated = await user.on(world.controlBrowser).see({ role: "combobox", label: "Assignee" }, { value: "nora.patel", timeoutMs: 1500 }).then(() => true).catch(() => false);
                  expect(beforeLocated, "Recorded baseline must reproduce the accessible-field regression").toBe(false);
                  await world.docshots.capture("workshop-before-regression", world.controlBrowser, { expect: ["Update documentation for Project XYZ", "Assignee"], route: /\/jira\/browse\/DOC-\d+/ });
                  await user.on(world.serviceBrowser).see({ role: "combobox", label: "Assignee" }, { value: "nora.patel" });
                  await world.docshots.capture("workshop-after-regression", world.serviceBrowser, { expect: ["Update documentation for Project XYZ", "Assignee"], route: /\/jira\/browse\/DOC-\d+/ });
                }
                if (scene.id !== "T09") { shotSurface = world.serviceBrowser; shotExpectation = target.text; }
                await world.assertScreenshotSafe(world.serviceBrowser);
                await user.on(world.serviceBrowser).screenshot();
              }
              if (["T02", "T03"].includes(scene.id)) {
                const nativeList = record(nativeAfter.list); const item = Array.isArray(nativeList.items) ? nativeList.items.map(record).find((value) => value.title === "Acme product comparison") : undefined;
                if (item && (scene.id === "T02" || check.sharing)) {
                  const surface = scene.id === "T02" ? world.ownerWeb : world.recipientWeb;
                  await user.on(surface).navigate(`${world.urls.denWeb}/dashboard/library/workflows/${item.configObjectId}`);
                  await user.on(surface).see({ text: "Acme product comparison" });
                  await world.assertScreenshotSafe(surface); await user.on(surface).screenshot();
                  shotSurface = surface; shotExpectation = "Acme product comparison";
                  if (verdict.status === "PASS") {
                    const frame = workshopWorkflowFrame(record(record(record(nativeAfter.details).script).latestSnapshot).value);
                    await world.docshots.capture(scene.id === "T02" ? "workshop-t02-context" : "workshop-t03-context", surface, { expect: ["Acme product comparison", scene.id === "T02" ? "Compare Atlas Lift for cold-storage pallet moves" : "Compare Atlas 2 for line-side replenishment"], route: /\/dashboard\/library\/workflows\// });
                    workflowPayloads = frame.expect;
                    await user.on(surface).see(frame.atlas2);
                    await user.on(surface).see(frame.lift);
                    shotExpectation = "Atlas 2";
                    await world.assertScreenshotSafe(surface); await user.on(surface).screenshot();
                  }
                }
              }
              const shot = WORKSHOP_SHOT_IDS.find((id) => id === `workshop-${scene.id.toLowerCase()}-final`);
              if (shot) await world.docshots.capture(shot, shotSurface, { expect: [shotExpectation, ...workflowPayloads, ...(workflowPayloads.length ? [] : scene.id === "T02" ? ["Compare Atlas Lift for cold-storage pallet moves"] : scene.id === "T03" ? ["Compare Atlas 2 for line-side replenishment"] : [])], never: verdict.status === "PASS" ? ["Request failed", "Unexpected server error"] : [], route: shotSurface === world.app ? /\/workspace\/.+\/session\// : shotSurface === world.ownerWeb || shotSurface === world.recipientWeb ? /\/dashboard\/library\/workflows\// : /\/(?:jira|confluence|outlook|onedrive)(?:\/|\?|$)/ });
              if (verdict.status === "PASS" && !["T02", "T03"].includes(scene.id) && targets.length === 0) throw new Error("Backend claim had no corresponding real browser object to capture");
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 700) : "Observed narrative error";
            row = { id: scene.id, title: scene.title, status: "FAIL", reason, latencyMs: Date.now() - started };
            await appAgent.run("composer.stop").catch(() => undefined);
            world.abortInferenceAfter(0); await world.settleInference().catch(() => undefined);
          }
          world.recordRow(row);
          console.log(`[workshop ${profile}] ${row.id} ${row.status} ${Math.round(row.latencyMs / 1000)}s — ${row.reason.split(". On screen:")[0].slice(0, 240)}`);
          evidence.recordAssertionEvidence(`${scene.id} ${scene.title}`, `${row.status}: ${row.reason}`, row.status === "PASS");
        });
      }
    }
  } finally { await world.finish(); }
  const incomplete = world.rows.filter((row) => row.status !== "PASS");
  expect(incomplete.map((row) => `${row.id} ${row.status}: ${row.reason}`), "Entire workshop is INCOMPLETE unless every scene passes").toEqual([]);
});
