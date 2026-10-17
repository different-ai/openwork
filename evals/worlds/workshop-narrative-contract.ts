import { createHash } from "node:crypto";
import { comparisonRequirements } from "./workshop-comparison-semantics.ts";

/** Pure observer contract. This module never starts a world, calls a service, or writes business state. */
export const WORKSHOP_INITIAL_LOCAL = "2026-10-16T08:55:00";
export const WORKSHOP_TIME_ZONE = "America/Los_Angeles";
export const WORKSHOP_INITIAL_INSTANT = "2026-10-16T15:55:00.000Z";
export const WORKSHOP_MODEL_ORDER = ["gpt-sol-fast", "qwen-27b"];
export const WORKSHOP_LIMITS = Object.freeze({ sceneMs: 180_000, matrixMs: 1_800_000, sceneToolCalls: 120, sceneAssistantTurns: 60, sceneCostUsd: 8, matrixCostUsd: 60, sceneTokens: 2_000_000, matrixTokens: 16_000_000 });
export const WORKSHOP_TOOL_PERMISSIONS = Object.freeze({ skill: "allow", webfetch: "deny", websearch: "deny", "browser_*": "deny" });
export type SceneId = "T10" | "T01" | "T02" | "T03" | "T04" | "T05" | "T06" | "T07" | "T09" | "T08" | "T11" | "T12";
export interface WorkshopScene { id: SceneId; title: string; prompt: string; limitMs: number }
const preamble = "This is an authorized fictional Acme Robotics workshop. The workshop starts Friday October 16, 2026, 08:55 America/Los_Angeles; the observer may advance the simulated clock, so use its current time thereafter. Use discovered connected services and their actual source content, not invented results or literal-return scripts. Cite sources. Do not send mail. If a required capability is unavailable, explain the blocker rather than claiming success. ";
const scene = (id: SceneId, title: string, prompt: string): WorkshopScene => Object.freeze({ id, title, prompt: preamble + prompt, limitMs: WORKSHOP_LIMITS.sceneMs });
/** Shared verbatim across both models; scene failures do not prevent later scenes. */
export const WORKSHOP_SCENES: readonly WorkshopScene[] = Object.freeze([
  scene("T10", "09:00 news digest", "Register a daily 09:00 America/Los_Angeles job using the connected isolated news scheduler. Its model-authored saved instructions must produce a digest from the fictional news corpus covering France, United States, Germany and Japan, with titles, summaries, outlet, country and links. The job must save the digest into a OneDrive Morning news folder and create an unsent Outlook draft. Do NOT generate or deliver the digest before 09:00. The operator will advance the isolated clock and dispatch your saved job instructions to this real paid agent when due. Label this an isolated simulated schedule, not a production Automation. Verify the registered job; never use external news services."),
  scene("T01", "Grounded customer comparison", "Find and read the complete latest customer-related Inbox message in Outlook, including internal staff correspondence about the customer; do not require a customer-authored sender. Search Confluence for the Atlas 2 and Atlas Lift datasheets, then read both full pages, not search excerpts. Compare the products against every material requirement in that customer-related message with page citations. Include a compact table with separate Atlas 2 and Atlas Lift columns and payload, top speed and runtime rows; distinguish verified product facts from the customer's unconfirmed safety and site requirements. Save a comparison in OneDrive and create an unsent threaded Outlook reply linking it. Verify the saved document and draft."),
  scene("T02", "Save and rerun a native Workflow", "Turn the customer comparison into a saved native OpenWork Workflow named Acme product comparison with a customerRequest input. Every Workflow output must assess both Atlas 2 and Atlas Lift, with each product's verified payload and source citation, even when customerRequest names only one product; explain which product is a documented match and which is not. The Workflow must evaluate customerRequest against documented use cases and limits, not just echo it or copy raw datasheets. Support different documented use cases beyond the two test inputs; matching must handle case, punctuation and hyphenation, and distinguish a documented use-case match from still-unconfirmed site requirements. Test it using 'Compare Atlas 2 and Atlas Lift for warehouse picking', retain the successful test receipt, and save its version. Rerun that same saved version with the different input 'Compare Atlas Lift for cold-storage pallet moves'. Verify the persisted Workflow, both execution receipts and the different inputs. Leave and verify the cold-storage rerun as the Workflow's latest saved result, rather than executing the warehouse-picking example again afterward. A chat answer, local script or skill is not a saved native Workflow."),
  scene("T03", "Recipient execution of a shared Workflow", "Share the saved Acme product comparison Workflow with the fictional Acme teammate Nora Patel (nora@acme.test) as a viewer allowed to execute, not an owner. Have that recipient execute the saved version with 'Compare Atlas 2 for line-side replenishment'. Verify the actual grant and recipient execution provenance. Do not substitute an owner run; if recipient execution is unavailable report that blocker."),
  scene("T04", "Account intelligence", "Read the full existing Confluence account plans for Northwind Logistics and Blue Harbor Foods. Compare annual recurring revenue, number and value of orders in the last 12 months, relationship strength, growth potential and churn risk. Preserve exact financial values and distinguish ARR from order revenue. Cite each account plan and ground the relationship, growth and churn assessment in the pages. Save this grounded report as 'Acme account analysis.md' in OneDrive and read it back to verify its actual content."),
  scene("T05", "Generate a real account-analysis PowerPoint", "Read the preceding report 'Acme account analysis.md' from OneDrive and both full original Confluence account plans for Northwind Logistics and Blue Harbor Foods. Turn that report into an actual PowerPoint with at least three slides preserving the exact ARR, order counts and values, relationship, growth potential, churn risk and account-plan citations. Save the generated PPTX bytes as 'Acme account analysis.pptx' in OneDrive and report its file ID or path. Generate the binary and invoke the connected upload programmatically within existing code/script execution; do not hand-emit or transcribe long base64 through a model tool-call argument. For a binary file_write, pass content_base64 and omit content entirely—never provide both or a placeholder content value. If constructing OOXML yourself, /ppt/presentation.xml must use the standard main content type application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml; a ZIP with presentationml.presentation+xml is not a valid PowerPoint package. Check the package structure before uploading. A product-only comparison, renamed text file, slide outline or seed deck is not enough. The observer will independently open the actual downloaded bytes with python-pptx and inspect the ZIP and slide content; this is not an Office UI rendering claim."),
  scene("T06", "Assigned documentation ticket", "Create a Jira Task in the DOC project titled 'Update documentation for Project XYZ', assigned to the fictional Acme teammate Nora Patel. Discover and resolve the actual assignee, create the ticket, then read it back to verify project, summary and assignee."),
  scene("T07", "Windows password reset", "I am locked out of my Windows login. Read the internal IT guidance, inspect the IT Service Desk request types and the required fields and valid Application options for Reset a password. Create the ITSD password-reset request with the actual required Windows login Application option, not merely Windows in the description. Verify its request type and custom field through the connected Jira APIs, then finish with the issue key, request type and verified Application value. Use connected APIs only; do not open a browser, list browser tabs, fetch a linked portal page, or invoke webfetch/web search. Never request or include a password."),
  scene("T09", "Honest missing-policy answer", "Can I bring my dog to the Acme office? Search the internal Confluence handbook and office policy and read relevant full pages. If no dog policy exists, say that you could not find one and ask People Ops rather than inventing permission or a prohibition. You do not have approval to invoke any external search, browsing or other external tool."),
  scene("T08", "Persist real UI feedback", "Use the product's actual feedback UI to record this negative feedback on the preceding dog-policy answer: 'Not helpful: the missing-policy uncertainty and next step were not clear enough.' Do not claim it was saved unless the real UI persisted it; a chat response, local file or Jira ticket is not product feedback. If the UI is inaccessible, explain that blocker."),
  scene("T11", "Create and reschedule a meeting", "Inspect my Outlook calendar. Create 'Acme Atlas review' for October 19, 2026, 10:00–10:30 America/Los_Angeles, with Nora Patel (nora@acme.test) and Priya Shah (priya@acme.test) as required attendees, location 'Acme lab B', body 'Review Atlas 2 and Atlas Lift comparison.' Then reschedule that same meeting to October 20, 2026, 11:00–11:45 America/Los_Angeles, keeping both attendees, location and body. Verify the final calendar state. Do not create a second meeting to simulate rescheduling."),
  scene("T12", "Update Confluence and draft a reply", "Read the full Confluence 'Working at the office' page and its actual version. Preserve the current content and append 'Workshop review: office guidance checked on 2026-10-16; dog-policy confirmation remains with People Ops.' Save a real incremented page version and add the comment 'Workshop review complete; please confirm the dog-policy gap with People Ops.' Find and read the latest customer-related Inbox message in Outlook, including internal staff correspondence about the customer, and create an unsent threaded reply draft referencing the updated page link, new version and review comment. Read back the page, comment and draft. Do not send mail or invent a dog policy."),
]);

export type JsonRecord = { [key: string]: unknown };
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const obj = (value: unknown): JsonRecord => isRecord(value) ? value : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string => typeof value === "string" ? value : "";
const json = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value) ?? "";
const parse = (value: unknown): unknown => { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } };
const text = (value: unknown): string => json(value).replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|#160);/g, " ").replace(/\s+/g, " ").trim();

export interface ObserverSnapshot {
  messages: unknown;
  atlassian: unknown;
  microsoft: unknown;
  /** Exact response from the Den Workflow GET, not an assistant's description. */
  workflows: unknown;
  news?: unknown;
}
/** Only observer-captured service invocations, never parsed from model code/stdout.
 * Used when a Code Mode outer tool hides actual provider calls. callId must bind to a completed assistant tool part. */
export interface ObservedServiceCall { callId: string; name: string; input: unknown; output: unknown; status: "completed" | "error"; service: "atlassian" | "microsoft" | "news" | "den" | "external" }
export interface WorkflowWitness {
  workflowId: string; versionId: string; savedNativeWorkflow: boolean;
  test: { receiptId: string; workflowId: string; versionId: string; status: string; input: unknown };
  rerun: { receiptId: string; workflowId: string; versionId: string; status: string; input: unknown };
  /** Observer obtains receipt/version from native Den GETs. */
  observedViaDenGet: boolean;
}
export interface SharingWitness {
  workflowId: string; versionId: string; grantId: string; role: string; recipientEmail: string;
  ownerMemberId: string; recipientMemberId: string; executionMemberId: string;
  receiptId: string; status: string; observedViaDenGet: boolean;
}
export interface ScheduleWitness {
  jobId: string; dueEventId: string; dueAt: string; timeZone: string;
  clockBefore: string; clockAfter: string; inferenceExecuted: boolean; deliveryExecuted: boolean;
  digestFileId: string; draftId: string; runnerSessionId: string;
}
export interface FeedbackWitness {
  feedbackId: string; sessionId: string; messageId: string; text: string;
  persisted: boolean; source: "product-ui"; observedViaReadback: boolean;
  submittedText?: string;
  providerOperation?: "createThread";
  openedFromApp?: boolean;
}
export interface ArtifactWitness {
  fileId: string; sha256: string; validZip: boolean; validPresentation: boolean;
  slideCount: number; extractedText: string; generatedBySessionId: string;
  /** Hash of downloaded actual bytes, not a filename or Graph preview. */
  downloadedSha256: string;
}
export interface SceneEvidence {
  id: SceneId; before: ObserverSnapshot; after: ObserverSnapshot;
  expected: { providerID: string; modelID: string; agent?: string; sessionId: string };
  elapsedMs: number;
  /** Optional observed cost; proxy estimates must use costKind=estimate, never billed. Unknown stays null. */
  costUsd?: number | null;
  costKind?: "billed" | "estimate";
  /** Observer total overrides message token totals; does not depend on billing availability. */
  tokens?: number;
  serviceCalls?: readonly ObservedServiceCall[];
  workflow?: WorkflowWitness; sharing?: SharingWitness; schedule?: ScheduleWitness;
  feedback?: FeedbackWitness; artifact?: ArtifactWitness;
  scheduleRegistration?: ObserverSnapshot;
}
export interface SceneVerdict {
  id: SceneId; status: "PASS" | "FAIL" | "BLOCKED"; reasons: string[];
  artifactCandidate?: { fileId: string; path: string };
  usage?: { costUsd: number | null; costKind: "billed" | "estimate" | "observed-unclassified" | "unavailable"; tokens: number | null };
}
interface Call { callId: string; name: string; input: unknown; output: unknown; service?: ObservedServiceCall["service"] }
function messages(snapshot: ObserverSnapshot) { return arr(snapshot.messages).map(obj); }
function assistants(snapshot: ObserverSnapshot) { return messages(snapshot).filter((m) => obj(m.info).role === "assistant"); }
function toolParts(snapshot: ObserverSnapshot) { return assistants(snapshot).flatMap((m) => arr(m.parts).map(obj).filter((p) => p.type === "tool")); }
const forbiddenSource = /(?:execute_capability_script|\bexecute_script\b|(?:^|[._-])(?:execute|shell|bash|python|javascript|eval)$)/i;
export function observedWorkshopCalls(evidence: SceneEvidence): Call[] {
  const completed = toolParts(evidence.after).filter((p) => obj(p.state).status === "completed");
  const direct = completed.flatMap((p): Call[] => {
    const state = obj(p.state); const input = obj(state.input);
    // Code strings and their stdout are never evidence of a downstream source read.
    // Only the generic dispatcher stores operation identity in input.name.
    // Direct provider tools may use name for an ordinary business field (e.g.
    // the schedule title); that must neither hide nor forge a tool operation.
    const dispatched = /(?:^|[_:.])execute_capability$/.test(str(p.tool));
    const name = dispatched && typeof input.name === "string" ? input.name : str(p.tool);
    if (forbiddenSource.test(name) || typeof input.code === "string" || /search_capabilities/.test(name)) return [];
    return [{ callId: str(p.callID), name, input: dispatched ? input.body ?? input.arguments ?? input : input, output: state.output }];
  });
  const witnessed = (evidence.serviceCalls ?? []).filter((c) => c.status === "completed" && c.callId.length > 0 && completed.some((p) => p.callID === c.callId));
  return [...direct, ...witnessed];
}
function matches(call: Call, operation: string) { return call.name === operation || call.name.endsWith(`:${operation}`) || call.name.endsWith(`_${operation}`) || call.name.endsWith(`.${operation}`); }
function callsFor(calls: Call[], operation: string) { return calls.filter((c) => matches(c, operation)); }
function containsId(value: unknown, id: string): boolean {
  if (!id) return false;
  // Confluence IDs are numeric strings. Compare the real scalar before JSON
  // parsing: parsing "163840002" turns it into a number and used to lose it.
  if ((typeof value === "string" || typeof value === "number") && String(value) === id) return true;
  const parsed = parse(value);
  if (typeof parsed === "string" || typeof parsed === "number") return String(parsed) === id;
  if (Array.isArray(parsed)) return parsed.some((v) => containsId(v, id));
  return Object.entries(obj(parsed)).some(([key, value]) => key !== "code" && containsId(value, id));
}
function allRecords(value: unknown): JsonRecord[] {
  const parsed = parse(value);
  if (Array.isArray(parsed)) return parsed.flatMap(allRecords);
  if (!parsed || typeof parsed !== "object") return [];
  const record = obj(parsed);
  // MCP text envelopes are still provider outputs; code/stdout are not traversed.
  return [record, ...Object.entries(record).filter(([key]) => !["code", "stdout", "script"].includes(key)).flatMap(([, child]) => allRecords(child))];
}
const pages = (snapshot: ObserverSnapshot) => arr(obj(obj(snapshot.atlassian).confluence).pages).map(obj);
const issues = (snapshot: ObserverSnapshot) => arr(obj(obj(snapshot.atlassian).jira).issues).map(obj);
const files = (snapshot: ObserverSnapshot) => arr(obj(snapshot.microsoft).files).map(obj);
const mails = (snapshot: ObserverSnapshot) => arr(obj(snapshot.microsoft).messages).map(obj);
const events = (snapshot: ObserverSnapshot) => arr(obj(snapshot.microsoft).events).map(obj);
function newItems(before: JsonRecord[], after: JsonRecord[]) { return after.filter((item) => !before.some((old) => old.id === item.id)); }
function sourceText(value: unknown): string {
  const raw = typeof value === "string" ? value : json(obj(value).value ?? value);
  // Markdownify emits setext headings. Remove only whole marker lines before collapsing whitespace;
  // factual equals signs (e.g. an equation in the source) must remain significant.
  return text(raw.replace(/^[ \t]*(?:={2,}|-{2,})[ \t]*\r?$/gm, ""))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[|#*_`]/g, " ").replace(/(?:^|\s)-+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
}
function fullPageRead(calls: Call[], page: JsonRecord): boolean {
  const body = sourceText(page.body);
  return body.length > 0 && callsFor(calls, "confluence_get_page").some((c) => allRecords(c.output).some((r) => {
    const candidateBody = obj(obj(r.body).storage).value ?? obj(r.body).value ?? r.content ?? r.body;
    return String(r.id ?? r.page_id ?? "") === String(page.id) && sourceText(candidateBody) === body;
  }));
}
function completeMailRead(calls: Call[], mail: JsonRecord): boolean {
  return calls.filter((c) => matches(c, "mail_read") || matches(c, "mail_search")).some((c) => allRecords(c.output).some((r) => r.id === mail.id && typeof obj(mail.body).content === "string" && obj(r.body).content === obj(mail.body).content));
}
function latestInbox(snapshot: ObserverSnapshot) { return mails(snapshot).filter((m) => m.parentFolderId === "inbox").sort((a, b) => str(b.receivedDateTime).localeCompare(str(a.receivedDateTime)))[0]; }
function wrote(calls: Call[], operation: string, item: JsonRecord) { return callsFor(calls, operation).some((c) => containsId(c.output, str(item.id)) || containsId(c.output, str(item.key))); }
function readBack(calls: Call[], operation: string, item: JsonRecord) { return wrote(calls, operation, item); }
function assistantText(snapshot: ObserverSnapshot) { return assistants(snapshot).flatMap((m) => arr(m.parts).map(obj).filter((p) => p.type === "text").map((p) => str(p.text))).join("\n"); }
function fileText(file: JsonRecord) { return str(obj(file.preview).text); }
function bodyContent(item: JsonRecord) { return str(obj(item.body).content); }
function pageLink(page: JsonRecord) { return str(page.url || page.webUrl || obj(page._links).webui) || `/pages/${str(page.id)}`; }
function accountAnswer(answer: string, name: string, other: string): string {
  const sections: string[] = [];
  let start = answer.indexOf(name);
  while (start >= 0) {
    const otherStart = answer.indexOf(other, start + name.length);
    sections.push(answer.slice(start, otherStart < 0 ? undefined : otherStart));
    start = answer.indexOf(name, start + name.length);
  }
  const prose = sections.join("\n");
  const rows = answer.split("\n").filter((line) => line.includes("|")).map((line) => line.split("|").map((cell) => cell.trim()));
  const header = rows.findIndex((cells) => cells.some((cell) => cell.includes(name)) && cells.some((cell) => cell.includes(other)));
  if (header < 0) return prose;
  const column = rows[header].findIndex((cell) => cell.includes(name));
  const table = rows.slice(header + 1).map((cells) => `${cells.find((cell) => cell.length > 0) ?? ""}: ${cells[column] ?? ""}`).join("\n");
  return `${prose.split("\n").filter((line) => !line.includes("|")).join("\n")}\n${table}`;
}

const accountPages = (snapshot: ObserverSnapshot) => pages(snapshot).filter((p) => /Account plan: (?:Northwind Logistics|Blue Harbor Foods)$/.test(str(p.title)));
function accountFactFailures(report: string, accounts: JsonRecord[]): string[] {
  const failures: string[] = [];
  const check = (condition: unknown, reason: string) => { if (!condition) failures.push(reason); };
  const north = accountAnswer(report, "Northwind", "Blue Harbor");
  const blue = accountAnswer(report, "Blue Harbor", "Northwind");
  check(accounts.length === 2 && accounts.every((p) => report.includes(str(p.id))), "Cite both existing account plans");
  check(/1\.1(?:0)?\s*M|1,100,000/i.test(north) && /4\s*(?:orders|\|)|orders[^\n]{0,40}\b4\b/i.test(north) && /1\.38\s*M|1,380,000/i.test(north), "Northwind exact facts: ARR $1.10M; 4 orders worth $1.38M");
  check(/1\.46\s*M|1,460,000/i.test(blue) && /2\s*(?:orders|\|)|orders[^\n]{0,40}\b2\b/i.test(blue) && /0?\.41\s*M|410,000|410\s*k/i.test(blue), "Blue Harbor exact facts: ARR $1.46M; 2 orders worth $0.41M");
  check(/strong/i.test(north) && /high/i.test(north) && /low/i.test(north) && /Stockton|third site/i.test(north) && /SSO|dashboard/i.test(north), "Northwind relationship strong, growth high, churn low with expansion dependencies");
  check(/mixed/i.test(blue) && /medium/i.test(blue) && /medium(?:[ –—-]| to )high/i.test(blue) && /charging|trust/i.test(blue) && /reliability|cold.storage/i.test(blue) && /renewal|competitor/i.test(blue), "Blue Harbor mixed relationship, medium growth, medium-high churn with cited reasons");
  return failures;
}
function completeFileRead(calls: Call[], file: JsonRecord): boolean {
  const expected = fileText(file);
  return expected.length > 0 && callsFor(calls, "file_read").some((c) => containsId(c.output, str(file.id)) && allRecords(c.output).some((r) => (typeof r.content === "string" && r.content === expected) || obj(r.preview).text === expected || r.text === expected));
}

/** Snapshot deltas + successful call provenance are mandatory; model claims never satisfy a write. */
export function verifyWorkshopScene(evidence: SceneEvidence): SceneVerdict {
  // Feedback is a human UI action, not another model turn. It must be read back
  // from the real form's provider transport and name the actual preceding answer.
  if (evidence.id === "T08") {
    const feedback = evidence.feedback;
    const base = "Not helpful: the missing-policy uncertainty and next step were not clear enough.";
    if (evidence.elapsedMs > WORKSHOP_LIMITS.sceneMs || (evidence.costUsd != null && evidence.costUsd > WORKSHOP_LIMITS.sceneCostUsd) || (evidence.tokens != null && evidence.tokens > WORKSHOP_LIMITS.sceneTokens)) return { id: evidence.id, status: "FAIL", reasons: ["Feedback scene time, token or observed cost budget exceeded"] };
    if (!feedback?.persisted || !feedback.observedViaReadback || feedback.source !== "product-ui" || !feedback.feedbackId || !feedback.openedFromApp || feedback.providerOperation !== "createThread") return { id: evidence.id, status: "BLOCKED", reasons: ["Actual app-opened feedback form and provider/disk persistence were not verified"] };
    const valid = feedback.sessionId === evidence.expected.sessionId && feedback.messageId.length > 0 && feedback.text === base && feedback.submittedText?.startsWith(base) && feedback.submittedText.includes(feedback.sessionId) && feedback.submittedText.includes(feedback.messageId) && messages(evidence.before).some((message) => obj(message.info).id === feedback.messageId && obj(message.info).role === "assistant");
    return { id: evidence.id, status: valid ? "PASS" : "FAIL", reasons: valid ? [] : ["Feedback must contain the requested negative note and reference the actual preceding session/message"] };
  }
  // A reused session must not reuse earlier source calls to satisfy a later scene.
  const previousMessageIds = new Set(messages(evidence.before).map((m) => str(obj(m.info).id)).filter(Boolean));
  evidence = { ...evidence, after: { ...evidence.after, messages: messages(evidence.after).filter((m) => !previousMessageIds.has(str(obj(m.info).id))) } };
  const failures: string[] = []; const blockers: string[] = [];
  const need = (condition: unknown, reason: string) => { if (!condition) failures.push(reason); };
  const block = (condition: unknown, reason: string) => { if (!condition) blockers.push(reason); };
  const before = evidence.before; const after = evidence.after; const calls = observedWorkshopCalls(evidence);
  const assistant = assistants(after); const last = assistant.at(-1); const info = obj(last?.info);
  need(assistant.length > 0 && assistant.every((m) => {
    const i = obj(m.info);
    return !i.error && i.providerID === evidence.expected.providerID && i.modelID === evidence.expected.modelID && i.agent === (evidence.expected.agent ?? "openwork") && i.sessionID === evidence.expected.sessionId;
  }), "Every assistant message must have matching role/model/provider/agent/session provenance and be error-free");
  need(info.finish === "stop" && typeof obj(info.time).completed === "number", "Assistant must finish normally");
  need(!toolParts(after).some((p) => ["pending", "running"].includes(str(obj(p.state).status))), "Unfinished tool or approval");
  need(evidence.elapsedMs >= 0 && evidence.elapsedMs <= WORKSHOP_LIMITS.sceneMs, "Scene time budget exceeded");
  need(toolParts(after).length <= WORKSHOP_LIMITS.sceneToolCalls && assistant.length <= WORKSHOP_LIMITS.sceneAssistantTurns, "Scene tool/turn budget exceeded");
  const cost = evidence.costUsd ?? null;
  need(cost === null || (Number.isFinite(cost) && cost >= 0 && cost <= WORKSHOP_LIMITS.sceneCostUsd), "Scene observed cost budget exceeded or invalid");
  const messageTokenTotals = assistant.map((m) => {
    const tokens = obj(obj(m.info).tokens);
    const components = [tokens.input, tokens.output, tokens.reasoning, obj(tokens.cache).read, obj(tokens.cache).write].filter((v): v is number => typeof v === "number");
    return components.length ? components.reduce((sum, value) => sum + value, 0) : null;
  });
  const messageTokens = messageTokenTotals.some((value) => value !== null) ? messageTokenTotals.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const tokens = evidence.tokens === undefined ? messageTokens : Math.max(evidence.tokens, messageTokens ?? 0);
  need((evidence.tokens === undefined || (Number.isFinite(evidence.tokens) && evidence.tokens >= 0)) && messageTokenTotals.every((value) => value === null || (Number.isFinite(value) && value >= 0)) && (tokens === null || (Number.isFinite(tokens) && tokens >= 0 && tokens <= WORKSHOP_LIMITS.sceneTokens)), "Scene token budget exceeded or invalid");
  need(callsFor(calls, "mail_send").length === 0 && !(evidence.serviceCalls ?? []).some((c) => /(?:^|[:._])mail_send$/.test(c.name)) && !toolParts(after).some((p) => /(?:^|[:._])mail_send$/.test(str(obj(obj(p.state).input).name) || str(p.tool))) && !mails(after).some((m) => m.parentFolderId === "sentitems" && !mails(before).some((old) => old.id === m.id && old.parentFolderId === "sentitems")), "Mail must never be sent");
  const answer = assistantText(after);
  const productPages = pages(before).filter((p) => /datasheet/i.test(str(p.title)) && /Atlas (?:2|Lift)/.test(str(p.title)));
  const requireProducts = () => need(productPages.length === 2 && productPages.every((p) => fullPageRead(calls, p)), "Both complete Confluence product bodies must be read via actual source calls, not snippets or script literals");
  let candidate: SceneVerdict["artifactCandidate"];
  switch (evidence.id) {
    case "T01": {
      requireProducts();
      const source = latestInbox(before); need(source && completeMailRead(calls, source), "Read the complete latest Inbox request (full-body mail_search is valid)");
      const document = newItems(files(before), files(after)).find((f) => /Atlas\s*2/i.test(fileText(f)) && /Atlas\s*Lift/i.test(fileText(f)) && productPages.every((p) => fileText(f).includes(str(p.id))));
      need(document && wrote(calls, "file_write", document) && completeFileRead(calls, document), "Comparison must be created and fully read back in OneDrive with product citations");
      if (document && source) for (const reason of comparisonRequirements(fileText(document), bodyContent(source))) failures.push(reason);
      const draft = newItems(mails(before), mails(after)).find((m) => m.isDraft === true && m.parentFolderId === "drafts" && m.conversationId === source?.conversationId && document && (bodyContent(m).includes(str(document.webUrl)) || bodyContent(m).includes(str(document.id))));
      need(draft && wrote(calls, "mail_create_reply_draft", draft) && readBack(calls, "mail_read", draft), "Create and read back an unsent threaded reply linking the document");
      break;
    }
    case "T02": {
      const w = evidence.workflow;
      block(w?.savedNativeWorkflow && w.observedViaDenGet && containsId(after.workflows, w.workflowId) && containsId(after.workflows, w.versionId), "No persisted native Workflow/version verified through Den GET");
      if (w) {
        block(w.test.receiptId && w.rerun.receiptId, "Native test and rerun receipts unavailable");
        need(w.test.receiptId !== w.rerun.receiptId && w.test.status === "succeeded" && w.rerun.status === "succeeded" && [w.test, w.rerun].every((r) => r.workflowId === w.workflowId && r.versionId === w.versionId) && json(w.test.input) !== json(w.rerun.input), "Native saved version must execute twice with distinct inputs and successful durable receipts");
        need(calls.some((c) => /workflow.*(?:save|create)|(?:save|create).*workflow/i.test(c.name) && containsId(c.output, w.workflowId)), "Model must actually save the native Workflow");
        need(calls.some((c) => (/workflow.*(?:run|execute)|(?:run|execute).*workflow/i.test(c.name) || c.name.includes(w.workflowId)) && containsId(c.output, w.rerun.receiptId)), "Model must actually rerun the saved native Workflow");
      }
      break;
    }
    case "T03": {
      const w = evidence.sharing;
      block(w?.observedViaDenGet && w.grantId && w.receiptId, "Actual viewer grant and recipient execution receipt unavailable");
      if (w) {
        need(w.role === "viewer" && w.recipientEmail === "nora@acme.test" && w.recipientMemberId.length > 0 && w.ownerMemberId !== w.recipientMemberId && w.executionMemberId === w.recipientMemberId && w.status === "succeeded", "Sharing must prove a viewer recipient ran the saved version, never an owner fallback");
        need(containsId(after.workflows, w.workflowId) && containsId(after.workflows, w.versionId), "Shared execution must reference an actual saved native Workflow version");
        need(calls.some((c) => /share|grant|access/i.test(c.name) && containsId(c.output, w.grantId)), "Model must make the actual sharing call");
      }
      break;
    }
    case "T04": {
      const accounts = accountPages(before);
      need(accounts.length === 2 && accounts.every((p) => fullPageRead(calls, p)), "Read both full existing account plans through actual source calls");
      const report = newItems(files(before), files(after)).find((f) => f.name === "Acme account analysis.md");
      need(report && wrote(calls, "file_write", report) && completeFileRead(calls, report), "Create and read back the actual OneDrive report Acme account analysis.md");
      for (const reason of accountFactFailures(report ? fileText(report) : "", accounts)) failures.push(`Saved account report: ${reason}`);
      break;
    }
    case "T05": {
      const accounts = accountPages(before);
      need(accounts.length === 2 && accounts.every((p) => fullPageRead(calls, p)), "Read both full original account plans for the account-analysis presentation");
      const report = files(before).find((f) => f.name === "Acme account analysis.md");
      need(report && completeFileRead(calls, report), "Read the complete preceding T04 OneDrive account report, not a product comparison or outline");
      if (report) for (const reason of accountFactFailures(fileText(report), accounts)) failures.push(`Source account report: ${reason}`);
      const file = newItems(files(before), files(after)).find((f) => f.name === "Acme account analysis.pptx" && wrote(calls, "file_write", f));
      need(file, "Model must generate and upload a new Acme account analysis.pptx, not reuse a seed deck");
      if (file) {
        candidate = { fileId: str(file.id), path: str(file.path) || str(file.name) };
        const a = evidence.artifact;
        block(a, "PPTX candidate requires independent downloaded-byte ZIP/python-pptx validation; extension/preview is insufficient and no Office UI render is claimed");
        if (a) {
          need(a.fileId === file.id && a.generatedBySessionId === evidence.expected.sessionId && /^[a-f0-9]{64}$/i.test(a.sha256) && a.sha256 === a.downloadedSha256 && a.validZip && a.validPresentation && a.slideCount >= 3, "Downloaded generated account-analysis PPTX must be a valid presentation with at least three real slides");
          for (const reason of accountFactFailures(a.extractedText, accounts)) failures.push(`PPTX slide content: ${reason}`);
        }
      }
      break;
    }
    case "T06": {
      const issue = newItems(issues(before), issues(after)).find((i) => i.summary === "Update documentation for Project XYZ");
      need(issue && issue.project === "DOC" && /^DOC-\d+$/.test(str(issue.key)) && issue.assignee === "nora" && wrote(calls, "jira_create_issue", issue) && readBack(calls, "jira_get_issue", issue), "Actual new DOC task must be assigned to nora, created and read back");
      need(calls.some((c) => /user|assign/.test(c.name) && /nora/i.test(json(c.output))), "Resolve Nora through actual connected user discovery");
      break;
    }
    case "T07": {
      need(!toolParts(after).some((part) => /web.?fetch|web.?search|browser_|exa|bing|google_search|playwright/i.test(str(part.tool)) || /execute_capability$/.test(str(part.tool)) && /web.?fetch|web.?search|browser_|exa|bing|google_search|playwright/i.test(str(obj(obj(part.state).input).name))), "T07 must finish through connected APIs without browsing or external fetch/search attempts");
      const guidance = pages(before).find((p) => p.title === "IT and security");
      need(guidance && fullPageRead(calls, guidance), "Read complete internal IT guidance");
      const typeCalls = calls.filter((c) => /request.?types?|request.?fields?|request_type_fields/.test(c.name));
      const records = typeCalls.flatMap((c) => allRecords(c.output));
      const appField = records.find((r) => r.name === "Application" && r.required === true && arr(r.validValues ?? r.valid_values).some((v) => obj(v).label === "Windows login"));
      const option = arr(appField?.validValues ?? appField?.valid_values).map(obj).find((v) => v.label === "Windows login");
      need(records.some((r) => r.name === "Reset a password") && appField && option, "Inspect actual request types and required Application valid values before creating");
      const issue = newItems(issues(before), issues(after)).find((i) => i.project === "ITSD");
      const resetType = records.find((r) => r.name === "Reset a password");
      need(issue && String(issue.requestType) === String(resetType?.id) && resetType?.id !== undefined, "ITSD request must have the discovered Reset a password request type");
      const fieldId = str(appField?.fieldId ?? appField?.field_id);
      const actualOption = obj(issue?.customFields)[fieldId] ?? obj(issue?.fields)[fieldId] ?? obj(issue)[fieldId] ?? issue?.application;
      need(issue && fieldId && option && [option.value, option.label].some((v) => v !== undefined && (actualOption === v || obj(actualOption).value === v || obj(actualOption).id === v)), "ITSD must persist the real required Windows login Application custom field");
      need(issue && (wrote(calls, "jira_create_request", issue) || calls.some((c) => /create.*(?:service|request)|(?:service|request).*create/.test(c.name) && containsId(c.output, str(issue.key)))) && readBack(calls, "jira_get_issue", issue), "Create and read back an actual password-reset service request");
      break;
    }
    case "T09": {
      const office = pages(before).filter((p) => ["Employee Handbook", "Working at the office"].includes(str(p.title)));
      need(callsFor(calls, "confluence_search").length > 0 && office.length === 2 && office.every((p) => fullPageRead(calls, p)), "Search and read the internal handbook and office page");
      need(/(?:no|not|couldn.t|cannot|unable|missing|doesn.t)[\s\S]{0,100}(?:dog|pet|policy)|(?:dog|pet|policy)[\s\S]{0,100}(?:not found|no policy|missing|not specify)/i.test(answer) && /People Ops/i.test(answer), "Explicitly acknowledge missing dog policy and defer to People Ops");
      need(!/(?:dogs?|pets?) (?:are |is )?(?:allowed|permitted|welcome|prohibited|banned)|(?:may|can) bring (?:your |a )?dog/i.test(answer.replace(/[^.!?\n]*\?/g, "").replace(/(?:cannot confirm|can.t confirm|not evidence that)[^.]*\./gi, "")), "Do not fabricate permission or prohibition");
      need(!calls.some((c) => c.service === "external" || /web.?search|web.?fetch|browse|exa|google_search|bing|playwright/i.test(c.name)) && !(evidence.serviceCalls ?? []).some((c) => c.service === "external"), "No external tools without explicit approval (including failed invocations)");
      need(!toolParts(after).some((p) => /web.?search|web.?fetch|browse|exa|google_search|bing|playwright/i.test(str(p.tool)) || /web.?search|web.?fetch|browse|exa|google_search|bing|playwright/i.test(str(obj(obj(p.state).input).name))), "External tool invocation/attempt is not approved");
      break;
    }
    case "T10": {
      block(evidence.schedule, "09:00 simulated scheduling plus actual inference/delivery witness unavailable");
      const s = evidence.schedule;
      if (s?.inferenceExecuted && s.deliveryExecuted) {
        const registered = evidence.scheduleRegistration;
        block(registered, "A pre-09:00 business-state observation is required to rule out premature delivery");
        if (registered) {
          need(!newItems(files(before), files(registered)).some((file) => !file.folder), "No digest file may be generated or delivered before 09:00");
          need(!mails(registered).some((mail) => !mails(before).some((old) => old.id === mail.id && bodyContent(old) === bodyContent(mail) && old.parentFolderId === mail.parentFolderId)), "No new or modified mail may be delivered before 09:00");
          const previousAudit = arr(obj(before.microsoft).audit).map(obj);
          need(!arr(obj(registered.microsoft).audit).map(obj).some((call) => call.status === "completed" && !previousAudit.some((old) => old.sequence === call.sequence) && /^(?:file_write|mail_create_draft|mail_create_reply_draft|mail_send)$/.test(str(call.name))), "No transient pre-clock delivery write may be hidden by deleting its object");
        }
      }
      if (s) {
        block(s.inferenceExecuted && s.deliveryExecuted && s.runnerSessionId, "Scheduler due event alone is not execution or delivery");
        need(s.timeZone === WORKSHOP_TIME_ZONE && s.dueAt === "2026-10-16T16:00:00.000Z" && Date.parse(s.clockBefore) < Date.parse(s.dueAt) && Date.parse(s.clockAfter) >= Date.parse(s.dueAt), "Witness the simulated 09:00 Los Angeles boundary exactly");
        const news = obj(after.news);
        need(arr(news.jobs).some((j) => obj(j).id === s.jobId) && arr(news.events).some((e) => obj(e).id === s.dueEventId && obj(e).jobId === s.jobId), "Schedule and due event must be in actual observer news state");
        need(calls.some((c) => /schedule.*create|automation.*create|create.*automation/.test(c.name) && containsId(c.output, s.jobId)), "Model must actually register the observed schedule");
        const digest = files(after).find((f) => f.id === s.digestFileId);
        const draft = mails(after).find((m) => m.id === s.draftId && m.isDraft === true && m.parentFolderId === "drafts");
        block(digest && draft, "Scheduled digest file and unsent draft have not been persisted");
        if (digest && draft && s.inferenceExecuted && s.deliveryExecuted) {
          need(["France", "United States", "Germany", "Japan"].every((country) => fileText(digest).includes(country)), "Actual due-run digest must cover all four countries");
          const sourceCalls = calls.filter((call) => ["news_list", "news_search", "news_read"].some((operation) => matches(call, operation)));
          const usedArticles = arr(news.articles).map(obj).filter((article) => fileText(digest).includes(str(article.url)) && fileText(digest).includes(str(article.title)) && fileText(digest).includes(str(article.outlet)));
          need(["France", "United States", "Germany", "Japan"].every((country) => usedArticles.some((article) => article.country === country && sourceCalls.some((call) => containsId(call.output, str(article.id))))), "Every country needs a real source title, outlet, country and link in the delivered digest");
          need(usedArticles.every((article) => str(article.summary).toLowerCase().split(/\W+/).filter((word) => word.length > 4).filter((word) => fileText(digest).toLowerCase().includes(word)).length >= 4), "Delivered news summaries must retain source content, not only titles and links");
          need(Boolean(str(digest.webUrl) && bodyContent(draft).includes(str(digest.webUrl))) || (usedArticles.length > 0 && usedArticles.every((article) => bodyContent(draft).includes(str(article.url)))), "The actual unsent draft must link the delivered digest or contain all selected source links, not just a placeholder");
          const folder = files(after).find((file) => file.folder && str(file.name).toLowerCase() === "morning news");
          need(folder && obj(digest.parentReference).id === folder.id, "Digest must actually be saved inside the requested OneDrive folder");
          if (s.inferenceExecuted && s.deliveryExecuted) need(wrote(calls, "file_write", digest) && (wrote(calls, "mail_create_draft", draft) || wrote(calls, "mail_create_reply_draft", draft)), "Correlate due-run digest and draft with actual successful service writes");
        }
      }
      need(calls.some((call) => ["news_list", "news_search", "news_read"].some((operation) => matches(call, operation))), "Actual news source calls required, not invented digest text");
      break;
    }
    case "T11": {
      need(callsFor(calls, "calendar_list").length > 0, "Read actual calendar before creating");
      const meetings = newItems(events(before), events(after)).filter((e) => e.subject === "Acme Atlas review");
      const e = meetings[0]; need(meetings.length === 1 && e, "Exactly one new meeting, not create-again rescheduling");
      const start = obj(e?.start); const end = obj(e?.end);
      need([WORKSHOP_TIME_ZONE, "Pacific Standard Time"].includes(str(start.timeZone)) && start.timeZone === end.timeZone && start.dateTime === "2026-10-20T11:00:00" && end.dateTime === "2026-10-20T11:45:00", "Final Graph start/end and Pacific timezone must match the requested reschedule exactly");
      const attendees = arr(e?.attendees).map(obj);
      need(attendees.length === 2 && ["nora@acme.test", "priya@acme.test"].every((address) => attendees.some((a) => a.type === "required" && obj(a.emailAddress).address === address)), "Retain both exact required attendees");
      need(obj(e?.location).displayName === "Acme lab B" && bodyContent(obj(e)) === "Review Atlas 2 and Atlas Lift comparison.", "Preserve exact meeting location and body");
      const creation = e && callsFor(calls, "calendar_create").find((c) => containsId(c.output, str(e.id)));
      need(creation && allRecords(creation.output).some((r) => obj(r.start).dateTime === "2026-10-19T10:00:00" && obj(r.end).dateTime === "2026-10-19T10:30:00"), "Prove original requested creation times in actual tool result");
      need(e && wrote(calls, "calendar_update", e) && (readBack(calls, "calendar_read", e) || readBack(calls, "calendar_get", e) || readBack(calls, "calendar_list", e)), "Update and read back the same real Graph meeting");
      break;
    }
    case "T12": {
      const old = pages(before).find((p) => p.title === "Working at the office");
      const updated = pages(after).find((p) => p.id === old?.id);
      const addition = "Workshop review: office guidance checked on 2026-10-16; dog-policy confirmation remains with People Ops.";
      const commentText = "Workshop review complete; please confirm the dog-policy gap with People Ops.";
      need(old && fullPageRead(calls, old), "Read original full page/version before editing");
      need(old && updated && updated.version === Number(old.version) + 1 && text(updated.body).includes(text(old.body)) && text(updated.body).includes(addition) && wrote(calls, "confluence_update_page", updated) && fullPageRead(calls, updated), "Persist and read back actual incremented Confluence version/body, preserving original content");
      const comment = newItems(arr(old?.comments).map(obj), arr(updated?.comments).map(obj)).find((c) => text(c.body) === commentText);
      need(comment && wrote(calls, "confluence_add_comment", comment), "Persist a real new review comment on the updated page");
      const source = latestInbox(before); need(source && completeMailRead(calls, source), "Read complete latest customer request");
      const sourceLinks = updated ? callsFor(calls, "confluence_get_page").flatMap((call) => allRecords(call.output)).filter((item) => String(item.id ?? "") === String(updated.id)).map((item) => str(item.url || item.webUrl || obj(item._links).webui)).filter(Boolean) : [];
      const draft = newItems(mails(before), mails(after)).find((m) => m.isDraft === true && m.parentFolderId === "drafts" && m.conversationId === source?.conversationId && updated && [pageLink(updated), ...sourceLinks].some((link) => bodyContent(m).includes(link)) && new RegExp(`version\\s*${String(updated.version)}\\b`, "i").test(bodyContent(m)) && (bodyContent(m).includes(commentText) || Boolean(comment && bodyContent(m).includes(str(comment.id)))));
      need(draft && wrote(calls, "mail_create_reply_draft", draft) && readBack(calls, "mail_read", draft), "Actual unsent threaded Outlook draft must reference updated page, version and comment");
      break;
    }
  }
  return { id: evidence.id, status: failures.length ? "FAIL" : blockers.length ? "BLOCKED" : "PASS", reasons: [...failures, ...blockers], usage: { costUsd: cost, costKind: cost === null ? "unavailable" : evidence.costKind ?? "observed-unclassified", tokens }, ...(candidate ? { artifactCandidate: candidate } : {}) };
}

/** Stable seed hash: sort object keys only; preserve array order, facts, business IDs and dates.
 * Only exact owned URL origins and narrowly named transport/auth/session fields are ignored.
 * Unknown IDs, timestamps, titles, amounts and URL paths/query strings remain significant. */
export function seedSemanticHash(value: unknown, ownedOrigins: readonly string[] = []): string {
  const origins = ownedOrigins.map((origin) => new URL(origin).origin).sort((a, b) => b.length - a.length);
  const ignored = new Set(["authorization", "accessToken", "refreshToken", "authToken", "sessionID", "sessionId"]);
  function normalize(input: unknown): unknown {
    if (typeof input === "string") {
      let result = input;
      for (const origin of origins) result = result.split(origin).join("<owned-origin>");
      return result;
    }
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") return Object.fromEntries(Object.entries(obj(input)).filter(([key]) => !ignored.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    return input;
  }
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export function verifyWorkshopMatrix(runs: readonly { model: string; scenes: readonly SceneVerdict[]; elapsedMs: number; costUsd?: number | null; tokens?: number }[]): { status: "PASS" | "FAIL" | "BLOCKED"; reasons: string[]; usage: { observedCostUsd: number | null; runsWithCost: number; tokens: number | null } } {
  const reasons: string[] = [];
  if (runs.length !== 2 || runs.some((run, i) => run.model !== WORKSHOP_MODEL_ORDER[i])) reasons.push("Run exact GPT Sol Fast then Qwen 27B order without model fallback");
  for (const run of runs) if (run.scenes.length !== WORKSHOP_SCENES.length || run.scenes.some((verdict, i) => verdict.id !== WORKSHOP_SCENES[i]?.id)) reasons.push(`${run.model}: execute every scene in shared order, continuing after failures`);
  if (runs.reduce((total, run) => total + run.elapsedMs, 0) > WORKSHOP_LIMITS.matrixMs) reasons.push("Matrix time budget exceeded");
  const observedCosts = runs.flatMap((run) => {
    const sceneCosts = run.scenes.flatMap((s) => s.usage?.costUsd === undefined || s.usage.costUsd === null ? [] : [s.usage.costUsd]);
    const reported = run.costUsd === undefined || run.costUsd === null ? [] : [run.costUsd];
    return sceneCosts.length || reported.length ? [Math.max(...reported, ...(sceneCosts.length ? [sceneCosts.reduce((sum, cost) => sum + cost, 0)] : []))] : [];
  });
  const observedCostUsd = observedCosts.length ? observedCosts.reduce((sum, value) => sum + value, 0) : null;
  if (runs.some((run) => !Number.isFinite(run.elapsedMs) || run.elapsedMs < 0 || (run.costUsd !== undefined && run.costUsd !== null && (!Number.isFinite(run.costUsd) || run.costUsd < 0))) || observedCosts.some((cost) => !Number.isFinite(cost) || cost < 0) || (observedCostUsd !== null && observedCostUsd > WORKSHOP_LIMITS.matrixCostUsd)) reasons.push("Matrix observed cost/usage budget exceeded or invalid");
  const tokenCounts = runs.flatMap((run) => run.tokens !== undefined ? [run.tokens] : run.scenes.flatMap((s) => s.usage?.tokens === undefined || s.usage.tokens === null ? [] : [s.usage.tokens]));
  const tokens = tokenCounts.length ? tokenCounts.reduce((sum, value) => sum + value, 0) : null;
  if (tokenCounts.some((count) => !Number.isFinite(count) || count < 0) || (tokens !== null && tokens > WORKSHOP_LIMITS.matrixTokens)) reasons.push("Matrix token budget exceeded or invalid");
  return { status: reasons.length || runs.some((run) => run.scenes.some((s) => s.status === "FAIL")) ? "FAIL" : runs.some((run) => run.scenes.some((s) => s.status === "BLOCKED")) ? "BLOCKED" : "PASS", reasons, usage: { observedCostUsd, runsWithCost: observedCosts.length, tokens } };
}
