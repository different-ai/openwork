import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WORKSHOP_LIMITS, WORKSHOP_SCENES, WORKSHOP_TOOL_PERMISSIONS, WORKSHOP_MODEL_ORDER, WORKSHOP_INITIAL_INSTANT, seedSemanticHash, verifyWorkshopScene, verifyWorkshopMatrix } from "./workshop-narrative-contract.ts";
import type { SceneEvidence, SceneId, SceneVerdict, ObserverSnapshot, JsonRecord } from "./workshop-narrative-contract.ts";

const pageA = { id: "product-a", title: "Atlas 2 – datasheet", body: "<h1>Atlas 2</h1><p>300 kg payload, 10 h runtime.</p>" };
const pageB = { id: "product-b", title: "Atlas Lift – datasheet", body: "<h1>Atlas Lift</h1><p>1,200 kg payload, 8 h runtime.</p>" };
const source = { id: "latest-mail", parentFolderId: "inbox", conversationId: "customer-thread", receivedDateTime: "2026-10-16T15:50:00Z", body: { content: "Compare Atlas 2 and Atlas Lift for our warehouse." } };
function snapshot(): ObserverSnapshot { return { messages: [], atlassian: { confluence: { pages: [pageA, pageB] }, jira: { issues: [] } }, microsoft: { files: [], messages: [source], events: [] }, workflows: [] }; }
function tool(name: string, output: unknown, input: unknown = {}): JsonRecord { return { type: "tool", callID: `call-${name}`, tool: name, state: { status: "completed", input, output: JSON.stringify(output) } }; }
function assistant(parts: unknown[]) { return { info: { role: "assistant", providerID: "provider", modelID: "model", agent: "openwork", sessionID: "session", finish: "stop", time: { completed: 1 } }, parts }; }
function evidence(id: SceneId, parts: unknown[] = []): SceneEvidence { return { id, before: snapshot(), after: { ...snapshot(), messages: [assistant(parts)] }, expected: { providerID: "provider", modelID: "model", sessionId: "session" }, elapsedMs: 1000, costUsd: 0.01 }; }
function productCalls() { return [pageA, pageB].map((p) => tool("confluence_get_page", { metadata: { id: p.id, content: { value: p.body, format: "storage" } } })); }
function comparison(request = source, requirements = "", options: { fileReadText?: string; draftConversationId?: string } = {}): SceneEvidence {
  const file = { id: "comparison-file", name: "comparison.txt", webUrl: "https://owned.test/onedrive/comparison-file", preview: { text: "| Spec | Atlas 2 | Atlas Lift |\n|---|---|---|\n| Payload | 300 kg | 1,200 kg |\n| Top speed | 2.0 m/s | 1.5 m/s |\n| Runtime | 10 h | 8 h |\nAtlas 2 supports warehouse picking; Atlas Lift supports pallet moves. Sources: product-a and product-b." + requirements } };
  const draft = { id: "reply-draft", isDraft: true, parentFolderId: "drafts", conversationId: options.draftConversationId ?? request.conversationId, body: { content: file.webUrl } };
  const e = evidence("T01", [...productCalls(), tool("mail_search", { value: [request] }), tool("file_write", file), tool("file_read", options.fileReadText === undefined ? file : { id: file.id, text: options.fileReadText }), tool("mail_create_reply_draft", draft), tool("mail_read", draft)]);
  e.before.microsoft = { files: [], messages: [request] };
  e.after.microsoft = { files: [file], messages: [request, draft] };
  return e;
}
function replaceParts(e: SceneEvidence, parts: unknown[]) { e.after.messages = [assistant(parts)]; }
const north = { id: "north", title: "Account plan: Northwind Logistics", body: "ARR $1.10M. 4 orders, $1.38M. Strong relationship, high growth, low churn. Third site Stockton depends on SSO dashboard." };
const blue = { id: "blue", title: "Account plan: Blue Harbor Foods", body: "ARR $1.46M. 2 orders, $0.41M. Mixed relationship from charging hurt trust. Medium growth cold-storage if reliability improves. Medium-high churn renewal competitor quote." };
const accountReportText = `${north.title} [north]: ${north.body}\n${blue.title} [blue]: ${blue.body}`;
const accountReport = { id: "account-report", name: "Acme account analysis.md", preview: { text: accountReportText } };
function accountCalls() { return [north, blue].map((page) => tool("confluence_get_page", { metadata: { id: page.id, content: { value: page.body, format: "markdown" } } })); }
function accountPresentation(): SceneEvidence {
  const file = { id: "new-deck", name: "Acme account analysis.pptx", path: "Acme account analysis.pptx", preview: { text: accountReportText } };
  const e = evidence("T05", [...accountCalls(), tool("file_read", { id: accountReport.id, text: accountReportText }), tool("file_write", file)]);
  e.before.atlassian = { confluence: { pages: [north, blue] } };
  e.before.microsoft = { files: [accountReport] };
  e.after.microsoft = { files: [accountReport, file] };
  return e;
}

test("scene order, deterministic clock and model-independent bounded prompts", () => {
  assert.deepEqual(WORKSHOP_SCENES.map((s) => s.id), ["T10", "T01", "T02", "T03", "T04", "T05", "T06", "T07", "T09", "T08", "T11", "T12"]);
  assert.deepEqual(WORKSHOP_MODEL_ORDER, ["gpt-sol-fast", "qwen-27b"]);
  assert.deepEqual(WORKSHOP_TOOL_PERMISSIONS, { skill: "allow", webfetch: "deny", websearch: "deny", "browser_*": "deny" });
  assert.ok(WORKSHOP_SCENES.find((scene) => scene.id === "T07")?.prompt.includes("Use connected APIs only"));
  assert.equal(WORKSHOP_INITIAL_INSTANT, "2026-10-16T15:55:00.000Z");
  assert.ok(WORKSHOP_SCENES.every((s) => s.prompt.includes("workshop starts") && s.prompt.includes("current time thereafter") && !s.prompt.includes("It is Friday")));
  assert.ok(WORKSHOP_SCENES.find((s) => s.id === "T08")?.prompt.includes("negative feedback"));
  assert.ok(WORKSHOP_SCENES.find((s) => s.id === "T02")?.prompt.includes("Every Workflow output must assess both Atlas 2 and Atlas Lift"));
  assert.ok(WORKSHOP_SCENES.find((s) => s.id === "T05")?.prompt.includes("omit content entirely"));
  assert.ok(WORKSHOP_SCENES.find((s) => s.id === "T05")?.prompt.includes("presentationml.presentation.main+xml"));
  assert.ok(WORKSHOP_SCENES.every((s) => s.limitMs === WORKSHOP_LIMITS.sceneMs && !/cob_|plg_|cov_|163840|localhost|127\.0\.0\.1|providerID|modelID/.test(s.prompt)));
});

test("complete-body mail_search is a valid source read, not restricted to mail_read", () => {
  assert.equal(verifyWorkshopScene(comparison()).status, "PASS");
});

const comparisonArtifactReason = "Comparison must be created and fully read back in OneDrive with product citations";
const comparisonDraftReason = "Create and read back an unsent threaded reply linking the document";

test("T01 full source reads and a chat-only comparison still fail both artifact requirements", () => {
  const e = evidence("T01", [...productCalls(), tool("mail_read", source), { type: "text", text: "I read the sources, but found only internal customer-related correspondence. Atlas 2: 300 kg, 2.0 m/s, 10 h. Atlas Lift: 1,200 kg, 1.5 m/s, 8 h. Sources: product-a and product-b." }]);
  const verdict = verifyWorkshopScene(e);
  assert.equal(verdict.status, "FAIL");
  assert.deepEqual(verdict.reasons, [comparisonArtifactReason, comparisonDraftReason]);
});

test("T01 complete file and threaded unsent draft readbacks satisfy both artifact requirements", () => {
  const verdict = verifyWorkshopScene(comparison());
  assert.equal(verdict.status, "PASS");
  assert.deepEqual(verdict.reasons, []);
});

test("T01 partial file readback fails even when the file write and threaded draft are valid", () => {
  const e = comparison(source, "", { fileReadText: "Atlas 2 and Atlas Lift: product-a and product-b" });
  const verdict = verifyWorkshopScene(e);
  assert.equal(verdict.status, "FAIL");
  assert.deepEqual(verdict.reasons, [comparisonArtifactReason]);
});

test("T01 a read-back unsent draft in another thread fails despite a verified comparison", () => {
  const e = comparison(source, "", { draftConversationId: "unrelated-thread" });
  const verdict = verifyWorkshopScene(e);
  assert.equal(verdict.status, "FAIL");
  assert.deepEqual(verdict.reasons, [comparisonDraftReason]);
});

test("T01 and T12 source prompts align with the actual newest internal customer-related Inbox fixture", { timeout: 10_000 }, async (t) => {
  // Read the real, unchanged synthetic seed; no MCP mutations, native world or inference.
  const child = spawn(process.execPath, [fileURLToPath(new URL("../packages/labs/src/demo-microsoft365.mjs", import.meta.url))], { env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: "0", DEMO_NOW: WORKSHOP_INITIAL_INSTANT }, stdio: ["ignore", "pipe", "ignore"] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  assert.ok(child.stdout);
  const ready = once(child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
  await once(child, "spawn");
  const [output] = await ready;
  const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(String(output))?.[0];
  assert.ok(origin, "Synthetic fixture must announce its loopback listener");
  const response = await fetch(`${origin}/state`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  const state: unknown = await response.json();
  const record = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
  assert.ok(record(state) && Array.isArray(state.messages));
  const inbox = state.messages.filter(record).filter((mail) => mail.parentFolderId === "inbox").sort((a, b) => String(b.receivedDateTime).localeCompare(String(a.receivedDateTime)));
  const latest = inbox[0];
  assert.ok(latest);
  assert.equal(latest.id, "mail-blueharbor-2");
  assert.equal(latest.conversationId, "thread-blueharbor");
  assert.equal(latest.receivedDateTime, "2026-10-16T13:55:00.000Z");
  assert.match(String(latest.subject), /Blue Harbor.*safety review and customer meeting/);
  assert.ok(record(latest.from) && record(latest.from.emailAddress));
  assert.equal(latest.from.emailAddress.address, "nora@acme.test");
  assert.ok(record(latest.body) && typeof latest.body.content === "string");
  assert.match(latest.body.content, /customer sign-off/);
  for (const id of ["T01", "T12"]) {
    const prompt = WORKSHOP_SCENES.find((scene) => scene.id === id)?.prompt;
    assert.ok(prompt);
    assert.match(prompt, /latest customer-related Inbox message in Outlook, including internal staff correspondence about the customer/);
  }
  assert.ok(typeof latest.id === "string");
  assert.ok(typeof latest.conversationId === "string");
  assert.ok(typeof latest.receivedDateTime === "string");
  const request = { id: latest.id, conversationId: latest.conversationId, receivedDateTime: latest.receivedDateTime, parentFolderId: "inbox", body: { content: latest.body.content } };
  const verdict = verifyWorkshopScene(comparison(request, "\nCustomer sign-off remains unconfirmed for approved level-floor routes. Operator training is two sessions per shift; supervised operation only, no unattended operation. Charging bay dimensions remain unconfirmed."));
  assert.equal(verdict.status, "PASS");
  assert.deepEqual(verdict.reasons, []);
});

test("actual MCP metadata markdownify setext headings match full HTML bodies", () => {
  const e = evidence("T09");
  const handbook = { id: "handbook", title: "Employee Handbook", body: "<h1>Employee Handbook</h1><p>Welcome to Acme.</p>" };
  const office = { id: "office", title: "Working at the office", body: "<h1>Working at the office</h1><p>Badge in at reception.</p><h2>Desks</h2><p>Keep x = y unchanged.</p>" };
  const handbookRead = tool("confluence_get_page", { metadata: { id: handbook.id, content: { value: "Employee Handbook\n=================\n\nWelcome to Acme.", format: "markdown" } } });
  const officeValue = "Working at the office\n=====================\n\nBadge in at reception.\n\nDesks\n-----\n\nKeep x = y unchanged.";
  const officeRead = tool("confluence_get_page", { metadata: { id: office.id, content: { value: officeValue, format: "markdown" } } });
  e.before.atlassian = { confluence: { pages: [handbook, office] } };
  replaceParts(e, [tool("confluence_search", []), handbookRead, officeRead, { type: "text", text: "No dog policy found; ask People Ops." }]);
  assert.equal(verifyWorkshopScene(e).status, "PASS");
  replaceParts(e, [tool("confluence_search", []), handbookRead, tool("confluence_get_page", { metadata: { id: office.id, content: { value: officeValue.replace("x = y", "x y"), format: "markdown" } } }), { type: "text", text: "No dog policy found; ask People Ops." }]);
  assert.equal(verifyWorkshopScene(e).status, "FAIL", "Factual equals signs must not be stripped");
});

test("snippets and discovery metadata cannot impersonate complete source reads", () => {
  const e = comparison();
  replaceParts(e, [tool("confluence_search", [pageA, pageB]), tool("search_capabilities", { source }), tool("mail_search", { value: [{ ...source, body: { content: "Compare Atlas" } }] })]);
  const result = verifyWorkshopScene(e);
  assert.equal(result.status, "FAIL");
  assert.ok(result.reasons.some((r) => r.includes("Both complete")));
  assert.ok(result.reasons.some((r) => r.includes("complete latest")));
});

test("literal-return scripts and user messages cannot manufacture source provenance", () => {
  const e = comparison();
  e.after.messages = [{ info: { role: "user" }, parts: productCalls() }, assistant([tool("execute_capability_script", { pages: [pageA, pageB], source }, { code: "return source" })])];
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
});

test("Code Mode source calls require observer-captured calls bound to a real completed call ID", () => {
  const e = comparison();
  replaceParts(e, [tool("execute", {}, { code: "provider calls here" })]);
  e.serviceCalls = [pageA, pageB].map((p) => ({ callId: "not-an-existing-call", service: "atlassian", name: "confluence_get_page", input: {}, output: { id: p.id, body: p.body }, status: "completed" }));
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
});

test("all assistant backend model/provider/role/agent/session provenance is checked", () => {
  for (const field of ["providerID", "modelID", "agent", "sessionID"]) {
    const e = comparison();
    const first = assistant([]);
    Object.assign(first.info, { [field]: "wrong" });
    e.after.messages = [first, ...Array.from(e.after.messages instanceof Array ? e.after.messages : [])];
    assert.equal(verifyWorkshopScene(e).status, "FAIL", field);
  }
});

test("earlier messages in a reused session cannot supply this scene's source calls", () => {
  const e = comparison();
  const old = assistant(productCalls()); Object.assign(old.info, { id: "prior-message" });
  e.before.messages = [old];
  const current = assistant([{ type: "text", text: "I already read them" }]); Object.assign(current.info, { id: "current-message" });
  e.after.messages = [old, current];
  assert.ok(verifyWorkshopScene(e).reasons.some((r) => r.includes("Both complete")));
});

test("pre-existing business writes and unsent-draft prose are not a new comparison", () => {
  const e = comparison(); e.before.microsoft = e.after.microsoft;
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
});

test("UI feedback requires real persistence, not model prose", () => {
  const e = evidence("T08", [{ type: "text", text: "Feedback saved!" }]);
  assert.equal(verifyWorkshopScene(e).status, "BLOCKED");
  e.before.messages = [{ info: { id: "answer", role: "assistant" }, parts: [{ type: "text", text: "No dog policy found; ask People Ops." }] }];
  e.feedback = { feedbackId: "feedback", sessionId: "session", messageId: "answer", text: "Not helpful: the missing-policy uncertainty and next step were not clear enough.", submittedText: "Not helpful: the missing-policy uncertainty and next step were not clear enough. Reference session session, response answer.", persisted: true, source: "product-ui", observedViaReadback: true, providerOperation: "createThread", openedFromApp: true };
  assert.equal(verifyWorkshopScene(e).status, "PASS");
  e.feedback.text = "Helpful: clearly distinguished missing policy from permission.";
  assert.equal(verifyWorkshopScene(e).status, "FAIL", "Positive feedback is not the requested negative feedback");
});

test("native Workflow absence is blocked, not passed by a local script", () => {
  assert.equal(verifyWorkshopScene(evidence("T02", [tool("write", { path: "workflow.ts" })])).status, "BLOCKED");
  assert.equal(verifyWorkshopScene(evidence("T03")).status, "BLOCKED");
});

test("same-input Workflow rerun and owner fallback cannot pass", () => {
  const e = evidence("T02");
  e.after.workflows = { id: "workflow", versionId: "version" };
  e.workflow = { workflowId: "workflow", versionId: "version", savedNativeWorkflow: true, observedViaDenGet: true, test: { receiptId: "first", workflowId: "workflow", versionId: "version", status: "succeeded", input: "same" }, rerun: { receiptId: "second", workflowId: "workflow", versionId: "version", status: "succeeded", input: "same" } };
  replaceParts(e, [tool("workflow_save", { id: "workflow" }), tool("workflow_run", { receiptId: "second" })]);
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
  e.id = "T03"; e.sharing = { workflowId: "workflow", versionId: "version", grantId: "grant", recipientEmail: "nora@acme.test", role: "viewer", ownerMemberId: "owner", recipientMemberId: "nora", executionMemberId: "owner", receiptId: "run", status: "succeeded", observedViaDenGet: true };
  replaceParts(e, [tool("workflow_share", { id: "grant" })]);
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
});

test("PPTX filename and preview are only a candidate, not valid bytes", () => {
  const e = accountPresentation();
  const verdict = verifyWorkshopScene(e);
  assert.equal(verdict.status, "BLOCKED"); assert.deepEqual(verdict.artifactCandidate, { fileId: "new-deck", path: "Acme account analysis.pptx" });
  e.artifact = { fileId: "new-deck", sha256: "a".repeat(64), downloadedSha256: "b".repeat(64), generatedBySessionId: "session", validZip: true, validPresentation: true, slideCount: 3, extractedText: accountReportText };
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
  e.artifact.downloadedSha256 = e.artifact.sha256;
  e.artifact.extractedText = `Acme account analysis\nNorthwind Logistics and Blue Harbor Foods\n${accountReportText}`;
  assert.equal(verifyWorkshopScene(e).status, "PASS");
});

test("account presentation rejects product-only slides, wrong facts, missing citations and fewer than three slides", () => {
  for (const slideText of ["Atlas 2 Atlas Lift product-a product-b", accountReportText.replace("$1.10M", "$9.10M"), accountReportText.replace("[north]", "[missing-source]")]) {
    const e = accountPresentation();
    e.artifact = { fileId: "new-deck", sha256: "a".repeat(64), downloadedSha256: "a".repeat(64), generatedBySessionId: "session", validZip: true, validPresentation: true, slideCount: 3, extractedText: slideText };
    assert.equal(verifyWorkshopScene(e).status, "FAIL");
  }
  const e = accountPresentation();
  e.artifact = { fileId: "new-deck", sha256: "a".repeat(64), downloadedSha256: "a".repeat(64), generatedBySessionId: "session", validZip: true, validPresentation: true, slideCount: 2, extractedText: accountReportText };
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
});

test("T05 cannot substitute a file-list snippet for reading the preceding full account report", () => {
  const e = accountPresentation();
  replaceParts(e, [...accountCalls(), tool("file_list", { value: [accountReport] }), tool("file_write", { id: "new-deck" })]);
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
});

function scheduledDigest(registration: JsonRecord): SceneEvidence {
  const articles = ["France", "United States", "Germany", "Japan"].map((country, index) => ({ id: `article-${index}`, country, title: `${country} report`, outlet: "Owned fictional news", url: `https://owned.test/article-${index}`, summary: "Measured fictional outcomes remain explicitly uncertain" }));
  const folder = { id: "morning-folder", name: "Morning news", folder: {} };
  const digest = { id: "digest", name: "digest.md", webUrl: "https://owned.test/digest", parentReference: { id: folder.id }, preview: { text: articles.map((article) => `${article.country}: ${article.title}; ${article.outlet}; ${article.url}; ${article.summary}`).join("\n") } };
  const draft = { id: "digest-draft", isDraft: true, parentFolderId: "drafts", body: { content: digest.webUrl } };
  const e = evidence("T10", [registration, ...articles.map((article) => tool("news_read", article)), tool("file_write", digest), tool("mail_create_draft", draft)]);
  e.before.news = { now: WORKSHOP_INITIAL_INSTANT, articles, jobs: [], events: [] };
  e.scheduleRegistration = structuredClone(e.before);
  e.after.news = { now: "2026-10-16T16:00:00.000Z", articles, jobs: [{ id: "job-1" }], events: [{ id: "event-1", jobId: "job-1" }] };
  e.after.microsoft = { files: [folder, digest], messages: [source, draft] };
  e.schedule = { jobId: "job-1", dueEventId: "event-1", dueAt: "2026-10-16T16:00:00.000Z", timeZone: "America/Los_Angeles", clockBefore: WORKSHOP_INITIAL_INSTANT, clockAfter: "2026-10-16T16:00:00.000Z", inferenceExecuted: true, deliveryExecuted: true, digestFileId: digest.id, draftId: draft.id, runnerSessionId: "session" };
  return e;
}

test("direct scheduling tool business name cannot replace its actual operation identity", () => {
  const e = scheduledDigest(tool("connected_news_schedule_create", { content: [{ type: "text", text: JSON.stringify({ id: "job-1" }) }], isError: false }, { name: "Acme Morning News — isolated simulated schedule", hour: 9 }));
  const verdict = verifyWorkshopScene(e);
  assert.equal(verdict.status, "PASS", verdict.reasons.join("; "));
});

test("registration still requires the exact returned job ID and a completed model call", () => {
  const wrong = scheduledDigest(tool("connected_news_schedule_create", { id: "other-job" }, { name: "Morning news" }));
  assert.ok(verifyWorkshopScene(wrong).reasons.includes("Model must actually register the observed schedule"));
  const failed = tool("connected_news_schedule_create", { id: "job-1" }, { name: "Morning news" });
  failed.state = { ...Object.fromEntries(Object.entries(failed.state ?? {})), status: "error" };
  assert.ok(verifyWorkshopScene(scheduledDigest(failed)).reasons.includes("Model must actually register the observed schedule"));
});

test("generic execute_capability uses its operation name but unrelated tool name inputs cannot forge registration", () => {
  const generic = scheduledDigest(tool("openwork-cloud_execute_capability", { id: "job-1" }, { name: "news_schedule_create", body: { name: "Morning news" } }));
  assert.equal(verifyWorkshopScene(generic).status, "PASS");
  const forged = scheduledDigest(tool("unrelated_read", { id: "job-1" }, { name: "news_schedule_create" }));
  assert.ok(verifyWorkshopScene(forged).reasons.includes("Model must actually register the observed schedule"));
});

test("a simulated due event without inference/delivery remains blocked", () => {
  const e = evidence("T10", [tool("news_search", []), tool("news_read", { id: "news" }), tool("fixture_schedule_create", { id: "job" })]);
  e.after.news = { jobs: [{ id: "job" }], events: [{ id: "due", jobId: "job" }] };
  e.after.microsoft = { files: [{ id: "digest", preview: { text: "France United States Germany Japan" } }], messages: [{ id: "draft", isDraft: true, parentFolderId: "drafts" }] };
  e.schedule = { jobId: "job", dueEventId: "due", dueAt: "2026-10-16T16:00:00.000Z", timeZone: "America/Los_Angeles", clockBefore: "2026-10-16T15:55:00Z", clockAfter: "2026-10-16T16:00:00Z", inferenceExecuted: false, deliveryExecuted: false, digestFileId: "digest", draftId: "draft", runnerSessionId: "" };
  assert.equal(verifyWorkshopScene(e).status, "BLOCKED");
});

test("missing news source calls fails even with digest text and schedule claim", () => {
  assert.equal(verifyWorkshopScene(evidence("T10", [{ type: "text", text: "Daily digest scheduled successfully" }])).status, "FAIL");
});

test("Windows in description does not satisfy required ITSD Application field", () => {
  const issue = { id: "it", key: "ITSD-999", project: "ITSD", requestType: "reset", description: "Windows login" };
  const guidance = { id: "guidance", title: "IT and security", body: "Never share a password" };
  const parts = [tool("confluence_get_page", guidance), tool("jira_get_request_types", [{ id: "reset", name: "Reset a password" }]), tool("jira_get_request_type_fields", { fields: [{ field_id: "customfield_10500", name: "Application", required: true, valid_values: [{ value: "10600", label: "Windows login" }] }] }), tool("jira_create_customer_request", { request_key: issue.key }), tool("jira_get_issue", issue)];
  const e = evidence("T07", parts);
  e.before.atlassian = { confluence: { pages: [guidance] }, jira: { issues: [] } };
  e.after.atlassian = { confluence: { pages: [guidance] }, jira: { issues: [issue] } };
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
  Object.assign(issue, { application: "Windows login" });
  assert.equal(verifyWorkshopScene(e).status, "PASS");
  for (const name of ["webfetch", "browser_tabs", "websearch"]) {
    replaceParts(e, [...parts, tool(name, { denied: true })]);
    assert.equal(verifyWorkshopScene(e).status, "FAIL", `${name} is not needed after the connected API readback`);
    assert.ok(verifyWorkshopScene(e).reasons.includes("T07 must finish through connected APIs without browsing or external fetch/search attempts"));
  }
});

test("DOC ticket must persist nora assignee, not just mention Nora", () => {
  const issue = { id: "doc", key: "DOC-999", project: "DOC", summary: "Update documentation for Project XYZ", assignee: "alex", description: "Please ask Nora" };
  const e = evidence("T06", [tool("jira_search_users", [{ name: "nora" }]), tool("jira_create_issue", issue), tool("jira_get_issue", issue)]);
  e.after.atlassian = { jira: { issues: [issue] } };
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
  issue.assignee = "nora";
  assert.equal(verifyWorkshopScene(e).status, "PASS");
});

test("T04 exact seeded account facts must be saved and read back in the actual OneDrive report", () => {
  const e = evidence("T04", [...accountCalls(), tool("file_write", accountReport), tool("file_read", { id: accountReport.id, text: accountReportText }), { type: "text", text: "Saved the account report in OneDrive." }]);
  e.before.atlassian = { confluence: { pages: [north, blue] } };
  e.after.microsoft = { files: [accountReport] };
  assert.equal(verifyWorkshopScene(e).status, "PASS");
  e.after.microsoft = { files: [{ ...accountReport, preview: { text: accountReportText.replace("$1.10M", "$1.46M") } }] };
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
  e.after.microsoft = { files: [] };
  replaceParts(e, [...accountCalls(), { type: "text", text: accountReportText }]);
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
});

test("missing dog policy is honest, but external tool attempts fail even when unsuccessful", () => {
  const handbook = { id: "handbook", title: "Employee Handbook", body: "Acme office policies" };
  const office = { id: "office", title: "Working at the office", body: "Badge in at reception" };
  const e = evidence("T09", [tool("confluence_search", []), tool("confluence_get_page", handbook), tool("confluence_get_page", office), { type: "text", text: "I could not find a dog policy. Please ask People Ops." }]);
  e.before.atlassian = { confluence: { pages: [handbook, office] } };
  assert.equal(verifyWorkshopScene(e).status, "PASS");
  e.serviceCalls = [{ callId: "external", name: "external_lookup", input: {}, output: "denied", service: "external", status: "error" }];
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
});

test("sending an existing draft is detected even when no new mail ID appears", () => {
  const e = comparison();
  const existing = { id: "existing-draft", parentFolderId: "drafts", isDraft: true };
  e.before.microsoft = { messages: [source, existing], files: [] };
  e.after.microsoft = { messages: [source, { ...existing, parentFolderId: "sentitems", isDraft: false }], files: [] };
  assert.ok(verifyWorkshopScene(e).reasons.includes("Mail must never be sent"));
});

test("calendar_read is accepted for the actual exact rescheduled Graph meeting", () => {
  const final = { id: "event", subject: "Acme Atlas review", start: { dateTime: "2026-10-20T11:00:00", timeZone: "America/Los_Angeles" }, end: { dateTime: "2026-10-20T11:45:00", timeZone: "America/Los_Angeles" }, attendees: ["nora@acme.test", "priya@acme.test"].map((address) => ({ emailAddress: { address }, type: "required" })), location: { displayName: "Acme lab B" }, body: { content: "Review Atlas 2 and Atlas Lift comparison." } };
  const original = { ...final, start: { dateTime: "2026-10-19T10:00:00", timeZone: "America/Los_Angeles" }, end: { dateTime: "2026-10-19T10:30:00", timeZone: "America/Los_Angeles" } };
  const e = evidence("T11", [tool("calendar_list", { value: [] }), tool("calendar_create", original), tool("calendar_update", final), tool("calendar_read", final)]);
  e.after.microsoft = { events: [final] };
  assert.equal(verifyWorkshopScene(e).status, "PASS");
});

test("calendar creation without real update and exact final state cannot pass", () => {
  const e = evidence("T11", [tool("calendar_list", []), tool("calendar_create", { id: "event" })]);
  e.after.microsoft = { events: [{ id: "event", subject: "Acme Atlas review", start: { dateTime: "2026-10-20T11:00:00", timeZone: "UTC" } }] };
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
});

test("numeric-string Confluence IDs correlate with actual update/comment and readback results", () => {
  const addition = "Workshop review: office guidance checked on 2026-10-16; dog-policy confirmation remains with People Ops.";
  const review = "Workshop review complete; please confirm the dog-policy gap with People Ops.";
  const old = { id: "163840002", title: "Working at the office", body: "<h1>Working at the office</h1><p>Badge in at reception.</p>", version: 6, comments: [] };
  const comment = { id: "163840027", body: `<p>${review}</p>` };
  const updated = { ...old, body: old.body + `<p>${addition}</p>`, version: 7, comments: [comment] };
  const link = "http://owned.test/confluence/pages/viewpage.action?pageId=163840002";
  const draft = { id: "reply-draft", isDraft: true, parentFolderId: "drafts", conversationId: source.conversationId, body: { content: `Reviewed ${link}, version 7. ${review}` } };
  const e = evidence("T12", [tool("confluence_get_page", { metadata: { id: old.id, content: { value: old.body }, url: link } }), tool("confluence_update_page", { message: "Page updated successfully", page: { id: updated.id } }), tool("confluence_get_page", { metadata: { id: updated.id, content: { value: updated.body }, url: link } }), tool("confluence_add_comment", { success: true, comment: { id: comment.id, body: review } }), tool("confluence_get_comments", [{ id: comment.id, body: review }]), tool("mail_search", { value: [source] }), tool("mail_create_reply_draft", draft), tool("mail_read", draft)]);
  e.before.atlassian = { confluence: { pages: [old] } };
  e.after.atlassian = { confluence: { pages: [updated] } };
  e.after.microsoft = { files: [], messages: [source, draft] };
  assert.equal(verifyWorkshopScene(e).status, "PASS");
  updated.body = "<p>Only the new note, original content removed.</p>";
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
});

test("Confluence update prose without body/version/comment backend deltas fails", () => {
  assert.equal(verifyWorkshopScene(evidence("T12", [{ type: "text", text: "Updated Confluence version and added comment; drafted reply." }])).status, "FAIL");
});

test("unknown billing cost is null, not a task blocker or a zero-dollar claim", () => {
  const e = comparison(); delete e.costUsd;
  const result = verifyWorkshopScene(e);
  assert.equal(result.status, "PASS");
  assert.equal(result.usage?.costUsd, null); assert.equal(result.usage?.costKind, "unavailable");
  e.costUsd = null;
  assert.equal(verifyWorkshopScene(e).status, "PASS");
  e.costUsd = 0.25; e.costKind = "estimate";
  assert.equal(verifyWorkshopScene(e).usage?.costKind, "estimate");
  e.costUsd = WORKSHOP_LIMITS.sceneCostUsd + 1;
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
});

test("token and time budgets remain hard limits without billing cost", () => {
  const e = comparison(); delete e.costUsd;
  e.tokens = WORKSHOP_LIMITS.sceneTokens + 1;
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
  delete e.tokens; e.elapsedMs = WORKSHOP_LIMITS.sceneMs + 1;
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
  e.elapsedMs = 1000;
  const first = assistant([]); Object.assign(first.info, { tokens: { input: WORKSHOP_LIMITS.sceneTokens, output: 1 } });
  e.after.messages = [first, ...Array.from(Array.isArray(e.after.messages) ? e.after.messages : [])];
  assert.equal(verifyWorkshopScene(e).status, "FAIL");
});

test("seed hash ignores only owned origins/auth/session noise, not business facts", () => {
  const a = { page: { id: "page", body: "Revenue $1.10M", url: "http://127.0.0.1:4000/pages/page?version=1" }, sessionId: "one", authorization: "one", date: "2026-10-16" };
  const b = { date: "2026-10-16", authorization: "two", sessionId: "two", page: { url: "http://127.0.0.1:5000/pages/page?version=1", body: "Revenue $1.10M", id: "page" } };
  assert.equal(seedSemanticHash(a, ["http://127.0.0.1:4000"]), seedSemanticHash(b, ["http://127.0.0.1:5000"]));
  for (const changed of [{ ...a, date: "2026-10-17" }, { ...a, page: { ...a.page, id: "different" } }, { ...a, page: { ...a.page, body: "Revenue $1.46M" } }, { ...a, page: { ...a.page, url: "http://127.0.0.1:4000/pages/page?version=2" } }]) assert.notEqual(seedSemanticHash(a), seedSemanticHash(changed));
  assert.notEqual(seedSemanticHash([1, 2]), seedSemanticHash([2, 1]));
});

test("matrix requires both exact models and every scene, preserving blocked verdicts", () => {
  const runs = WORKSHOP_MODEL_ORDER.map((model) => ({ model, scenes: WORKSHOP_SCENES.map((s): SceneVerdict => ({ id: s.id, status: "PASS", reasons: [] })), elapsedMs: 1000, costUsd: 1 }));
  assert.equal(verifyWorkshopMatrix(runs).status, "PASS");
  assert.equal(verifyWorkshopMatrix([...runs].reverse()).status, "FAIL");
  assert.equal(verifyWorkshopMatrix([{ ...runs[0], scenes: [] }, runs[1]]).status, "FAIL");
  const blocked = { ...runs[0], scenes: runs[0].scenes.map((s): SceneVerdict => ({ ...s, status: "BLOCKED" })) };
  assert.equal(verifyWorkshopMatrix([blocked, runs[1]]).status, "BLOCKED");
  const unpriced = runs.map((run) => ({ ...run, costUsd: null }));
  assert.equal(verifyWorkshopMatrix(unpriced).status, "PASS");
  assert.equal(verifyWorkshopMatrix(unpriced).usage.observedCostUsd, null);
  assert.equal(verifyWorkshopMatrix(unpriced).usage.runsWithCost, 0);
  assert.equal(verifyWorkshopMatrix(unpriced.map((run) => ({ ...run, tokens: WORKSHOP_LIMITS.matrixTokens / 2 + 1 }))).status, "FAIL");
});
