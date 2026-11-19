import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { attachSurface, browserScript, probeAppStateOnSurface } from "../evals/packages/cdp/src/index.ts";
import type { Surface } from "../evals/packages/cdp/src/index.ts";
import { defaultDaytonaExec } from "../evals/packages/hosts/src/daytona.ts";
import { parsePrivatePreview } from "../evals/packages/hosts/src/private-web-preview.ts";
import { control, evalIn, waitFor } from "../evals/packages/behaviors/src/desktop.ts";
import { readComposerState, sendComposerMessage, waitForAssistantReply } from "../evals/packages/behaviors/src/composer.ts";
import { engineSessionProbe } from "../evals/packages/behaviors/src/engine-session-probe.ts";
import type { EngineSessionProbePart } from "../evals/packages/behaviors/src/engine-session-probe.ts";
import { guestLabel, foregroundWorkshopDesktop, WORKPLACE_ORIGIN } from "./lib/workshop-browser.ts";
import { redactWorkshopDiagnostic } from "./lib/workshop-redaction.ts";
import { unlockWorkshopDesktop } from "./lib/workshop-unlock.ts";
import { typeThroughWorkshopViewer } from "./lib/workshop-viewer.ts";
import { freshComposer } from "./workshop-fleet.ts";
import { readWorkshopAudit, validateAuditedPilotRead } from "./lib/workshop-pilot-audit.ts";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function rows(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter(record) : []; }
async function attach(id: string, port: number, kind: "chrome" | "electron") {
  const result = await defaultDaytonaExec(["preview-url", id, "-p", String(port), "--expires", "3600"], { timeoutMs: 30_000 });
  assert.equal(result.code, 0, "Private control endpoint could not be minted");
  const cdpUrl = parsePrivatePreview(result.stdout, id, port).browserOrigin;
  return attachSurface({ name: `workshop-proof-${kind}`, hostKind: "daytona", sandboxId: id, kind, cdpUrl });
}
async function navigate(surface: Surface, path: string) {
  await evalIn(surface, browserScript((url) => { location.href = url; return true; }, [`${WORKPLACE_ORIGIN}${path}`]));
  await waitFor(surface, browserScript((path) => location.pathname === path && document.readyState === "complete", [path]), { timeoutMs: 60_000, label: "workshop page navigation" });
}
async function state(surface: Surface, service: string): Promise<Record<string, unknown>> {
  const value = await evalIn(surface, browserScript(async (service) => {
    const response = await fetch(`/_workshop/state/${service}`);
    if (!response.ok) throw new Error(`Independent readback HTTP ${response.status}`);
    return response.json();
  }, [service]));
  assert.ok(record(value)); return value;
}
async function capture(surface: Surface, path: string) {
  const image = await surface.client.send("Page.captureScreenshot", { format: "png" });
  assert.ok(record(image) && typeof image.data === "string");
  await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
}
function canonical(value: unknown): string { return JSON.stringify(value); }
function businessState(value: Record<string, unknown>) { const { audit, ...business } = value; return business; }
function instant(value: unknown): number {
  assert.ok(record(value) && typeof value.dateTime === "string");
  return Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(value.dateTime) ? value.dateTime : value.dateTime + (value.timeZone === "UTC" ? "Z" : "-07:00"));
}

export async function runWorkshopProof(aId: string, bId: string, output: string) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const marker = `WORKSHOP-${Date.now().toString(36)}`;
  const bMarker = `INDEPENDENT-${Date.now().toString(36)}`;
  await using a = await attach(aId, 9825, "electron");
  await using b = await attach(bId, 9825, "electron");
  await using aBrowser = await attach(aId, 9222, "chrome");
  await using bBrowser = await attach(bId, 9222, "chrome");
  await navigate(aBrowser, "/outlook"); await navigate(bBrowser, "/outlook");
  const aGuest = await guestLabel(aBrowser, "outlook"), bGuest = await guestLabel(bBrowser, "outlook");
  assert.notEqual(aGuest, bGuest);
  const baselineMail = await state(aBrowser, "microsoft"), baselineProjects = await state(aBrowser, "atlassian");
  let bMail = await state(bBrowser, "microsoft");
  const bProjects = await state(bBrowser, "atlassian");
  const assertions: { name: string; passed: boolean; detail?: unknown }[] = [];
  const turns: { name: string; text: string; durationMs: number; completedTools: { tool: string; output: string }[] }[] = [];
  let lastParts: EngineSessionProbePart[] = [];
  const report = async () => writeFile(join(output, "workshop-proof.json"), JSON.stringify({ startedAt, updatedAt: new Date().toISOString(), desktopRef: "ef0db73ae009b6904d13bb8b1f5a391db713d86c", hostedRef: "ae6b832a0f95875ec0040a0637653764574e54ed", marker, aId, bId, aGuest, bGuest, assertions, turns }, null, 2), { mode: 0o600 });
  const pass = async (name: string, detail?: unknown) => { assertions.push({ name, passed: true, detail }); await report(); console.log(`Workshop proof PASS: ${name}`); };
  async function turn(name: string, prompt: string, desktop = a, browser = aBrowser) {
    await foregroundWorkshopDesktop(browser, desktop);
    const sessionId = await control(desktop, "session.create_task");
    const app = await probeAppStateOnSurface(desktop);
    assert.ok(app.workspaceId && typeof sessionId === "string");
    const sessions = await control(desktop, "session.list_sessions");
    const previous = rows(sessions).find((session) => record(session.model));
    if (previous && record(previous.model)) {
      const binding = await control(desktop, "session.set_model", { workspaceId: app.workspaceId, sessionId, providerId: previous.model.providerId, modelId: previous.model.modelId, variant: "low" });
      assert.ok(record(binding) && binding.ok === true, "Paid workshop turn did not verify its managed low-effort model binding");
    }
    const start = Date.now();
    await sendComposerMessage(desktop, prompt);
    await waitForAssistantReply(desktop, { timeoutMs: 360_000 });
    await waitFor(desktop, () => {
      const busy = [...document.querySelectorAll("button")].some((button) => /^(stop|stop task|stop generating)$/i.test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()));
      return !busy && !document.querySelector('[data-status="pending"], [data-status="running"]') && !/^Working(?:\.{3}|…)?$/m.test(document.body.innerText);
    }, { timeoutMs: 360_000, label: "completed paid workshop turn" });
    const reply = await waitForAssistantReply(desktop, { timeoutMs: 5_000 });
    assert.ok(reply.text);
    const messages = await engineSessionProbe({ surface: desktop, workspaceId: app.workspaceId, engine: "v2" }).messages(sessionId);
    assert.ok(messages.ok, "Completed engine messages unavailable");
    lastParts = messages.data.flatMap((message) => message.parts);
    const completedTools = lastParts.filter((part) => part.type === "tool" && part.status === "completed" && !part.error).map((part) => ({ tool: part.tool, output: part.output }));
    assert.ok(completedTools.length > 0, "Workshop turn has no completed tool execution");
    turns.push({ name, text: reply.text, durationMs: Date.now() - start, completedTools });
    await capture(desktop, join(output, `${name}.png`)); await report(); return reply.text;
  }
  try {
    await pass("Two actual fleet members own separate guest workspaces");
    const aSeat: unknown = JSON.parse(await readFile(join(dirname(output), "attendee01.control.json"), "utf8"));
    const bSeat: unknown = JSON.parse(await readFile(join(dirname(output), "attendee02.control.json"), "utf8"));
    assert.ok(record(aSeat) && typeof aSeat.viewer === "string" && record(bSeat) && typeof bSeat.viewer === "string");
    await unlockWorkshopDesktop(aId); await unlockWorkshopDesktop(bId);
    await foregroundWorkshopDesktop(aBrowser, a);
    await typeThroughWorkshopViewer(aSeat.viewer, "interactive-attendee-a");
    await waitFor(a, () => (document.querySelector<HTMLElement>('[contenteditable="true"]')?.innerText ?? "").includes("interactive-attendee-a"), { label: "real RFB keyboard reached unlocked attendee A composer" });
    assert.ok(!(await readComposerState(b)).draftText.includes("interactive-attendee-a"));
    await capture(a, join(output, "interactive-attendee-a.png"));
    await foregroundWorkshopDesktop(bBrowser, b);
    await typeThroughWorkshopViewer(bSeat.viewer, "interactive-attendee-b");
    await waitFor(b, () => (document.querySelector<HTMLElement>('[contenteditable="true"]')?.innerText ?? "").includes("interactive-attendee-b"), { label: "real RFB keyboard reached unlocked attendee B composer" });
    assert.ok((await readComposerState(a)).draftText.includes("interactive-attendee-a"));
    await capture(b, join(output, "interactive-attendee-b.png"));
    await control(a, "composer.set_text", { text: "" }); await control(b, "composer.set_text", { text: "" });
    await pass("Signed noVNC viewers accept real keyboard input on two unlocked independent desktops");
    const originalBMail = bMail;
    await turn("00-second-attendee-independent-draft", `Use connected Workshop Outlook to create one UNSENT reply draft in the existing Northwind thread containing the exact text ${bMarker}. Do not send anything or modify other resources. Confirm in under 40 words.`, b, bBrowser);
    bMail = await state(bBrowser, "microsoft");
    const bDrafts = rows(bMail.messages).filter((message) => message.isDraft === true && canonical(message).includes(bMarker));
    assert.equal(bDrafts.length, 1); assert.equal(bDrafts[0]?.conversationId, "thread-northwind");
    assert.equal(rows(bMail.messages).filter((message) => message.parentFolderId === "sentitems").length, rows(originalBMail.messages).filter((message) => message.parentFolderId === "sentitems").length);
    await pass("Second attendee has its own independently created unsent proof draft");
    await foregroundWorkshopDesktop(aBrowser, a);
    await control(a, "session.create_task");
    await sendComposerMessage(a, "Operator controllability check in this disposable workshop VM: first run the harmless shell command sleep 20, then read Northwind status from the connected workshop tools. Do not change files or any connected resource. The operator may stop this run before it completes.");
    await waitFor(a, () => [...document.querySelectorAll("button")].some((button) => /^(stop|stop task|stop generating)$/i.test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()) && !button.disabled), { timeoutMs: 30_000, label: "active run offers the actual Stop control" });
    await control(a, "composer.stop");
    await waitFor(a, () => ![...document.querySelectorAll("button")].some((button) => /^(stop|stop task|stop generating)$/i.test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim())), { timeoutMs: 60_000, label: "owned attendee run stopped" });
    assert.deepEqual(businessState(await state(bBrowser, "microsoft")), businessState(bMail));
    await capture(a, join(output, "owned-stop-turn.png"));
    await pass("Operator stops one real running model turn without altering attendee B");
    const beforeDeliverables = await state(aBrowser, "microsoft");
    const deliverableCursor = Math.max(0, ...rows(beforeDeliverables.audit).map((entry) => Number(entry.sequence)));
    const first = await turn("01-readiness-presentation-draft", `Use the connected Workshop Outlook and Drive tools to review the Northwind pilot email thread and shared pilot brief. Determine whether the pilot is production-ready, citing clickable source links. Create a polished ONE-SLIDE actual PowerPoint (.pptx) with the readiness decision, evidence, blocker and owners. Save it in Drive named ${marker}-readiness.pptx. Create one reply draft in the EXISTING Northwind email thread for review, linking the saved presentation and citing the source facts behind the decision; include ${marker} in the draft body. Do NOT send anything or create an unrelated draft. You may use shell/Python standard library zipfile and XML to generate the real one-slide PPTX, then Drive binary write or upload-session tools to save it. No package installs or external websites. Keep final response under 180 words. Be efficient: read only the relevant email and brief, then write the two deliverables.`);
    const afterMail = await state(aBrowser, "microsoft");
    const deliverableAudit = rows(afterMail.audit).filter((entry) => Number(entry.sequence) > deliverableCursor && entry.status === "completed");
    assert.ok(deliverableAudit.some((entry) => /^mail_(?:search|read)$/.test(String(entry.name)) && /northwind/i.test(canonical(entry.output))), "Presentation lacks an actual Northwind email read");
    assert.ok(deliverableAudit.some((entry) => entry.name === "file_read" && /Northwind-pilot-brief\.docx/i.test(canonical(entry.output))), "Presentation lacks a completed read of the shared Northwind brief");
    assert.ok(deliverableAudit.some((entry) => entry.name === "mail_create_reply_draft"), "Reply draft was not created through the actual Outlook connector");
    assert.ok(deliverableAudit.some((entry) => ["file_write", "file_create_upload_session"].includes(String(entry.name))), "Saved deck lacks an actual Drive connector write/upload session");
    const drafts = rows(afterMail.messages).filter((message) => message.isDraft === true && canonical(message).includes(marker));
    assert.equal(drafts.length, 1); assert.equal(drafts[0]?.conversationId, "thread-northwind");
    const file = rows(afterMail.files).find((file) => file.name === `${marker}-readiness.pptx`); assert.ok(file && typeof file.id === "string");
    const bytes = await evalIn(aBrowser, browserScript(async (id) => {
      const response = await fetch(`/download/${encodeURIComponent(id)}`); if (!response.ok) throw new Error(`PPTX HTTP ${response.status}`);
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    }, [file.id]));
    assert.ok(Array.isArray(bytes));
    const pptx = join(output, "readiness-downloaded.pptx"); await writeFile(pptx, Buffer.from(bytes), { mode: 0o600 });
    const presentation: unknown = JSON.parse(execFileSync("python3", ["-c", `import json,sys,zipfile,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
 names=z.namelist()
 slides=[n for n in names if n.startswith('ppt/slides/slide') and n.endswith('.xml') and '/_rels/' not in n]
 assert '[Content_Types].xml' in names and 'ppt/presentation.xml' in names
 assert len(slides)==1
 text=' '.join(n.text or '' for s in slides for n in E.fromstring(z.read(s)).iter() if n.tag.endswith('}t'))
 print(json.dumps({'slides':len(slides),'text':text,'zipEntries':len(names)}))`, pptx], { encoding: "utf8" }));
    assert.ok(record(presentation));
    assert.match(String(presentation.text), /497/); assert.match(String(presentation.text), /500/); assert.match(String(presentation.text), /99\.4/);
    assert.match(String(presentation.text), /aisle\s*C/i); assert.match(String(presentation.text), /roam|Wi-Fi/i);
    assert.match(String(presentation.text), /pending|not.*ready|not.*production|not yet/i);
    assert.match(String(presentation.text), /Priya|Kenji|Jamal/i);
    assert.ok(canonical(drafts[0]).includes(String(file.webUrl))); assert.match(canonical(drafts[0]), /outlook\?message=|drive\?item=/);
    const sent = (value: Record<string, unknown>) => rows(value.messages).filter((message) => message.parentFolderId === "sentitems").length;
    assert.equal(sent(afterMail), sent(baselineMail)); assert.match(first, /pending|not.*ready|not.*production|not yet/i);
    assert.match(first, /https:\/\/[^\s)]+\/(?:outlook|drive)/);
    await pass("Actual one-slide PPTX independently downloaded and inspected; existing-thread reply stays unsent", presentation);
    await turn("02-engineering-task-preserving-append", `Use connected Workshop Jira and Confluence. Create ONE ordinary engineering Task, NOT an IT service request, to verify aisle C Wi-Fi roaming before the Northwind pilot readiness decision. Discover the existing engineering project from related Northwind issues; I authorize you to use that project based on the evidence rather than guess a key. Include ${marker} in its summary. Find the EXISTING Northwind account plan in Confluence, fetch its body in the stored format, keep the original body string intact, and APPEND a clearly labeled "Workshop pilot follow-up ${marker}" section linking the new task and noting that site acceptance remains pending. Do not create a replacement page or alter unrelated records. No shell or external websites. Final response under 150 words with issue and page links.`);
    const afterProjects = await state(aBrowser, "atlassian");
    assert.ok(rows(afterProjects.audit).some((entry) => entry.name === "jira_create_issue" && entry.status === "completed" && canonical(entry.input).includes(marker)), "Ordinary task lacks an actual Jira connector creation");
    assert.ok(rows(afterProjects.audit).some((entry) => entry.name === "confluence_update_page" && entry.status === "completed" && canonical(entry.input).includes(marker)), "Append lacks an actual Confluence connector update");
    const issues = rows(record(afterProjects.jira) ? afterProjects.jira.issues : []).filter((issue) => canonical(issue).includes(marker));
    assert.equal(issues.length, 1); assert.equal(issues[0]?.issuetype, "Task"); assert.notEqual(issues[0]?.project, "ITSD");
    const pages = rows(record(afterProjects.confluence) ? afterProjects.confluence.pages : []), beforePages = rows(record(baselineProjects.confluence) ? baselineProjects.confluence.pages : []);
    const changed = pages.filter((page) => canonical(page.body).includes(marker)); assert.equal(changed.length, 1);
    const page = changed[0], originalPage = beforePages.find((entry) => entry.id === page?.id); assert.ok(page && originalPage);
    assert.equal(page.title, originalPage.title); assert.equal(Number(page.version), Number(originalPage.version) + 1);
    assert.ok(String(page.body).includes(String(originalPage.body))); assert.ok(String(page.body).includes(String(issues[0]?.key))); assert.equal(pages.length, beforePages.length);
    await pass("Ordinary engineering Task and append preserve existing Confluence page", { issue: issues[0]?.key, page: page.title });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); const date = tomorrow.toISOString().slice(0, 10);
    const original = rows(baselineMail.events).find((event) => event.subject === "Northwind / Blue Harbor customer pilot review"); assert.ok(original);
    const beforeCalendar = await state(aBrowser, "microsoft");
    const calendarCursor = Math.max(0, ...rows(beforeCalendar.audit).map((entry) => Number(entry.sequence)));
    const beforePolicy = await state(aBrowser, "atlassian");
    const policyCursor = Math.max(0, ...rows(beforePolicy.audit).map((entry) => Number(entry.sequence)));
    const answer = await turn("03-calendar-and-missing-policy", `Today in America/Los_Angeles is ${today}. Move my EXISTING Northwind / Blue Harbor customer pilot review to tomorrow ${date} at 14:00 America/Los_Angeles. Keep its duration and ALL attendees; update the existing event, do not create a duplicate. Then check internal office guidance: may I bring my dog to the office? If a dog policy is absent, say you could not find one rather than inventing permission or prohibition, and cite the actual internal guidance with a clickable source link. Use Calendar and Confluence tools, no shell or external sites. Do not send mail or create/edit any other resources. Final response under 180 words.`);
    const calendarAfter = await state(aBrowser, "microsoft");
    const reviews = rows(calendarAfter.events).filter((event) => event.subject === original.subject); assert.equal(reviews.length, 1);
    const updated = reviews[0]; assert.ok(updated); assert.equal(updated.id, original.id);
    assert.equal(instant(updated.start), Date.parse(`${date}T21:00:00Z`)); assert.equal(instant(updated.end) - instant(updated.start), instant(original.end) - instant(original.start));
    assert.deepEqual(updated.attendees, original.attendees); assert.equal(rows(calendarAfter.events).length, rows(baselineMail.events).length);
    assert.deepEqual(rows(calendarAfter.events).filter((event) => event.id !== original.id), rows(baselineMail.events).filter((event) => event.id !== original.id));
    const calendarAudit = rows(calendarAfter.audit).filter((entry) => Number(entry.sequence) > calendarCursor && entry.status === "completed");
    assert.ok(calendarAudit.some((entry) => entry.name === "calendar_update" && record(entry.input) && entry.input.event_id === original.id), "Existing event lacks an actual Calendar connector update");
    assert.ok(!calendarAudit.some((entry) => entry.name === "calendar_create"), "Calendar turn created a duplicate event");
    assert.match(answer, /dog|pet/i); assert.match(answer, /couldn.t find|could not find|didn.t find|did not find|no (?:explicit |specific |published )?(?:dog|pet)|not (?:specified|covered|stated|found)|does(?:n.t| not) (?:mention|address|specify)|does not contain/i);
    assert.doesNotMatch(answer, /dogs? (?:are|is) (?:allowed|permitted|prohibited|banned)|you (?:can|may) bring (?:your |a )?dog/i);
    assert.match(answer, /https:\/\/[^\s)]+\/confluence/);
    const afterPolicy = await state(aBrowser, "atlassian");
    const policyAudit = rows(afterPolicy.audit).filter((entry) => Number(entry.sequence) > policyCursor && entry.status === "completed");
    assert.ok(policyAudit.some((entry) => entry.name === "confluence_search" && /dog|pet|office|policy/i.test(canonical(entry.input))), "Missing-policy answer lacks a real internal search");
    assert.ok(policyAudit.some((entry) => entry.name === "confluence_get_page" && /Working at the office/.test(canonical(entry.output))), "Missing-policy answer lacks a completed office-guidance read");
    assert.deepEqual(businessState(afterPolicy), businessState(beforePolicy), "Calendar/policy turn must not mutate Jira or Confluence");
    await pass("Existing calendar review rescheduled with attendees and duration; absent dog policy not invented", { date, start: updated.start, attendees: updated.attendees });
    assert.ok(!canonical(await state(bBrowser, "microsoft")).includes(marker)); assert.ok(!canonical(await state(bBrowser, "atlassian")).includes(marker));
    assert.deepEqual(businessState(await state(bBrowser, "microsoft")), businessState(bMail)); assert.deepEqual(businessState(await state(bBrowser, "atlassian")), businessState(bProjects));
    await pass("Second attendee retains independent unchanged mail, Drive, calendar, Jira and Confluence");
    await navigate(aBrowser, "/_workshop/reset");
    await waitFor(aBrowser, () => {
      const button = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Reset my sample data");
      if (!button) return false; button.click(); return true;
    }, { label: "actual personal reset confirmation" });
    await waitFor(aBrowser, () => location.pathname === "/", { timeoutMs: 60_000, label: "personal reset completed" });
    assert.equal(await guestLabel(aBrowser, "outlook"), aGuest);
    assert.deepEqual(businessState(await state(aBrowser, "microsoft")), businessState(baselineMail)); assert.deepEqual(businessState(await state(aBrowser, "atlassian")), businessState(baselineProjects));
    assert.deepEqual(businessState(await state(bBrowser, "microsoft")), businessState(bMail)); assert.deepEqual(businessState(await state(bBrowser, "atlassian")), businessState(bProjects));
    await capture(aBrowser, join(output, "04-personal-reset.png"));
    await pass("Personal reset restores all five services, preserves browser identity and leaves B unchanged");
    const resetAuditBefore = await readWorkshopAudit(aBrowser);
    const resetCursor = new Map<string, number>();
    for (const { service, entry } of resetAuditBefore) resetCursor.set(service, Math.max(resetCursor.get(service) ?? 0, Number(entry.sequence) || 0));
    const resetAnswer = await turn("05-paid-read-after-reset", "Use the connected Workshop Outlook or Jira MCP tool to read one Northwind item now. Quote its exact subject/title and end with RESET_OAUTH_READY. Read only; no shell, fetch or website workaround. Under 80 words. If authorization fails, explain honestly without that marker.");
    assert.ok(resetAnswer.includes("RESET_OAUTH_READY"));
    const resetAudit = (await readWorkshopAudit(aBrowser)).filter(({ service, entry }) => Number(entry.sequence) > (resetCursor.get(service) ?? 0));
    validateAuditedPilotRead(lastParts, resetAnswer, [], resetAudit, "RESET_OAUTH_READY");
    await foregroundWorkshopDesktop(aBrowser, a);
    await freshComposer(a);
    await foregroundWorkshopDesktop(bBrowser, b);
    await freshComposer(b);
    await pass("Real model successfully reads through existing OAuth again after personal reset, without reconnect");
    await report();
    return { passed: true, assertions: assertions.length, output };
  } catch (error) {
    assertions.push({ name: "Whole workshop completion", passed: false, detail: redactWorkshopDiagnostic(error instanceof Error ? error.message : String(error), []) });
    await capture(a, join(output, "failure.png")).catch(() => {}); await report(); throw error;
  }
}

if (import.meta.main) {
  const [a, b, output] = process.argv.slice(2); assert.ok(a && b && output);
  try { console.log(await runWorkshopProof(a, b, output)); }
  catch (error) { console.error(redactWorkshopDiagnostic(error instanceof Error ? error.message : String(error), [])); process.exitCode = 1; }
}
