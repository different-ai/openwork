import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workshopNarrative, type NarrativeRow } from "../worlds/workshop-narrative.ts";
import { WORKSHOP_SCENES, WORKSHOP_LIMITS, verifyWorkshopScene, type SceneEvidence } from "../worlds/workshop-narrative-contract.ts";
import { observedServiceCalls, sharingWitness, workflowWitness } from "../worlds/workshop-narrative-witnesses.ts";

const test = spec.world(workshopNarrative, {
  timeout: 420_000,
  needs: { placement: "local", commands: ["bun", "infisical"], optIn: ["OPENWORK_WORKSHOP_NARRATIVE"] },
  resources: { surfaces: ["appWeb", "web"], services: ["den"] },
});
const profile = process.env.OPENWORK_WORKSHOP_PROFILE ?? "gpt-sol-fast";
const recipientPrompt = "As Nora Patel, discover the saved Acme product comparison Workflow shared with me. Run its actual saved version with customerRequest 'Compare Atlas 2 for line-side replenishment'. Verify its real execution receipt and output. Do not create another Workflow, impersonate Alex, or claim an owner run as mine. Use only our connected fictional services; do not send mail.";
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}; }
function terminal(messages: unknown, oldIds: Set<unknown>) {
  const fresh = Array.isArray(messages) ? messages.map(record).filter((message) => record(message.info).role === "assistant" && !oldIds.has(record(message.info).id)) : [];
  const last = fresh.at(-1); const info = record(last?.info);
  return Boolean(last && (info.error || (info.finish === "stop" && typeof record(info.time).completed === "number")));
}

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
              // The real app has only an external landing/Plain feedback form. Do not counterfeit persistence.
              await appUser.click({ role: "button", label: "Account menu" });
              await probe.eventually(() => probe.on(world.app).dom('[role="menu"]'), { within: 5000, label: "actual account menu opens", until: (value) => value.elements.some((element) => element.rect.width > 0 && element.rect.height > 0) });
              await world.assertScreenshotSafe(world.app);
              await appUser.screenshot();
              await appUser.press("Escape");
              row = { id: scene.id, title: scene.title, status: "BLOCKED", reason: "Actual app feedback entry is visible, but the owned world has no isolated landing/Plain persistence surface. Negative feedback was NOT submitted; no external send was attempted.", latencyMs: Date.now() - started };
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
                await appAgent.run("composer.stop").catch(() => undefined);
              });
              let scheduled: { job: Record<string, unknown>; event: Record<string, unknown>; dueWall: number; inferenceStart: number } | undefined;
              if (scene.id === "T10") {
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
                  await probe.eventually(() => world.current(), { within: Math.max(1000, scene.limitMs - (Date.now() - started)), intervalMs: 500, label: "09:00 due job actually executes paid inference", until: (value) => terminal(value.messages, dueIds) }).catch(async () => { completed = false; await appAgent.run("composer.stop").catch(() => undefined); });
                }
              }
              if (scene.id === "T03" && completed && Date.now() - started < scene.limitMs - 5000) {
                const recipientAgent = agent.on(world.recipientApp);
                await recipientAgent.createSession("Shared comparison as Nora");
                const recipientBefore = await world.current("recipient");
                const recipientIds = new Set((Array.isArray(recipientBefore.messages) ? recipientBefore.messages : []).map((message) => record(record(message).info).id));
                await user.on(world.recipientApp).type("composer", recipientPrompt, { replace: true });
                await user.on(world.recipientApp).click("Run task");
                await probe.eventually(() => world.current("recipient"), { within: Math.max(1000, scene.limitMs - (Date.now() - started)), intervalMs: 500, label: "Nora actually runs the shared Workflow", until: (value) => terminal(value.messages, recipientIds) }).catch(async () => { completed = false; await recipientAgent.run("composer.stop").catch(() => undefined); });
                await world.assertScreenshotSafe(world.recipientApp);
                await user.on(world.recipientApp).screenshot();
              }
              const after = await world.observe();
              const nativeAfter = await world.nativeWorkflows();
              const witnessed = after.inference.slice(inferenceStart);
              const forwarded = witnessed.filter((request) => request.status !== "rejected");
              const knownCost = forwarded.every((request) => request.estimatedUsd !== null) ? forwarded.reduce((sum, request) => sum + (request.estimatedUsd ?? 0), 0) : null;
              const tokens = witnessed.every((request) => request.inputTokens !== null && request.outputTokens !== null) ? witnessed.reduce((sum, request) => sum + (request.inputTokens ?? 0) + (request.outputTokens ?? 0), 0) : undefined;
              const check: SceneEvidence = { id: scene.id, before, after, expected: { ...world.expectedModel, sessionId: after.sessionId ?? "missing-session" }, elapsedMs: Date.now() - started, costUsd: knownCost, costKind: "estimate", tokens, serviceCalls: observedServiceCalls(before, after), ...(scene.id === "T02" ? { workflow: workflowWitness(nativeBefore, nativeAfter) } : {}), ...(scene.id === "T03" ? { sharing: sharingWitness(nativeBefore, nativeAfter) } : {}) };
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
                const artifact = await world.inspectPptx(verdict.artifactCandidate.path, after.sessionId ?? "");
                if ("artifact" in artifact) { check.artifact = artifact.artifact; verdict = verifyWorkshopScene(check); }
              }
              if (scene.id === "T10" && !scheduled) verdict = { id: scene.id, status: "BLOCKED", reasons: ["No model-registered isolated due job was available for real paid dispatch at the 09:00 clock boundary; a manually created digest is not scheduled-execution proof.", ...verdict.reasons] };
              const tierOk = forwarded.some((request) => request.status === "completed") && forwarded.every((request) => profile !== "gpt-sol-fast" || (request.requestedServiceTier === "priority" && (request.status !== "completed" || ["fast", "priority"].includes(request.returnedServiceTier ?? ""))));
              const reasons = [...verdict.reasons, ...(!completed ? ["Real assistant turn exceeded the common time bound or waited for approval; stopped through the product"] : []), ...(!tierOk ? ["Actual inference protocol/Fast tier was not verified for every request"] : [])];
              row = { id: scene.id, title: scene.title, status: !completed || !tierOk ? "FAIL" : verdict.status, reason: reasons.join("; ") || "Actual model calls, backend state and provenance matched", latencyMs: Date.now() - started, sessionId: after.sessionId ?? undefined, evidence: { usage: verdict.usage, requestCount: witnessed.length, rejectedBeforeUpstream: witnessed.filter((request) => request.status === "rejected").map((request) => ({ sequence: request.sequence, reason: request.rejection })), upstreamErrors: forwarded.filter((request) => request.status !== "completed").map((request) => ({ sequence: request.sequence, status: request.status, httpStatus: request.httpStatus })), inputTokens: witnessed.reduce((sum, request) => sum + (request.inputTokens ?? 0), 0), outputTokens: witnessed.reduce((sum, request) => sum + (request.outputTokens ?? 0), 0), estimatedUsd: knownCost, costStatus: knownCost === null ? "unavailable" : "estimated-not-billed", sourceCalls: check.serviceCalls?.length ?? 0 } };
              await world.assertScreenshotSafe(world.app);
              await appUser.screenshot();
              // Actual browser views accompany state checks; the observer never performs the model's mutations.
              const state = record(after.microsoft), atlassian = record(after.atlassian), jira = record(atlassian.jira);
              const targets: Array<{ url: string; text: string | RegExp }> = [];
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
                if (scene.id === "T06") await user.on(world.serviceBrowser).see({ role: "combobox", label: "Assignee" }, { value: "nora.patel" });
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
                }
              }
              if (verdict.status === "PASS" && !["T02", "T03"].includes(scene.id) && targets.length === 0) throw new Error("Backend claim had no corresponding real browser object to capture");
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 700) : "Observed narrative error";
            row = { id: scene.id, title: scene.title, status: "FAIL", reason, latencyMs: Date.now() - started };
            await appAgent.run("composer.stop").catch(() => undefined);
          }
          world.recordRow(row);
          evidence.recordAssertionEvidence(`${scene.id} ${scene.title}`, `${row.status}: ${row.reason}`, row.status === "PASS");
        });
      }
    }
  } finally { await world.finish(); }
  const incomplete = world.rows.filter((row) => row.status !== "PASS");
  expect(incomplete.map((row) => `${row.id} ${row.status}: ${row.reason}`), "Entire workshop is INCOMPLETE unless every scene passes").toEqual([]);
});
