// Explicit paid rehearsal; never runs automatically while starting a world.
// node worlds/lib/enterprise-workshop-probe.ts <private-world-receipt.json>
// Add --verify-session <id> --marker <marker> to verify an existing turn without new model calls/writes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { record } from "./acme-gateway.ts";
import { assertAcmeMcpOrigins } from "./acme-runtime.ts";
import { verifyWorkshop } from "./workshop-verification.mjs";

const receipt = JSON.parse(await readFile(process.argv[2], "utf8"));
const out = receipt.outputs;
const option = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const existingSession = option("--verify-session");
const requestedMarker = option("--marker");
if (existingSession) assert.ok(/^ses_[a-zA-Z0-9_-]+$/.test(existingSession) && requestedMarker, "Existing-session verification requires its ID and marker");
for (const key of ["openworkUrl", "denApi", "atlassianState", "microsoftState"]) {
  const url = new URL(out[key]);
  assert.equal(url.hostname, "127.0.0.1", `Rehearsal requires owned loopback ${key}`);
  assert.equal(url.protocol, "http:");
  assert.equal(url.username + url.password + url.search + url.hash, "");
}
const headers = { authorization: `Bearer ${out.openworkToken}`, "content-type": "application/json" };
async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${out.openworkUrl}${path}`, { headers, redirect: "error", method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(360_000) });
  if (!response.ok) throw new Error(`Workshop probe ${path}: HTTP ${response.status}; private response omitted.`);
  return response.json();
}
const workspaces = await request("/workspaces");
const workspace = record(workspaces) && Array.isArray(workspaces.items) ? workspaces.items.find((item) => record(item) && item.id === out.workspaceId) : undefined;
assert.ok(workspace && typeof workspace.path === "string");
const base = `/workspace/${out.workspaceId}`;
assertAcmeMcpOrigins(await request(`${base}/opencode/config`), out.denApi);
const marker = requestedMarker ?? `Workshop-comparison-${Date.now()}`;
const beforeMail = await fetch(out.microsoftState).then((r) => r.json());
const session = existingSession
  ? await request(`${base}/opencode/session/${existingSession}`)
  : await request(`${base}/opencode/session`, { title: "Connected Acme workday verification" });
assert.ok(record(session) && typeof session.id === "string");
assert.equal(session.directory, workspace.path, "Engine and fixture workspace paths must match canonically before paid inference");
if (!existingSession) {
  console.log(`Created rehearsal session ${session.id}; starting paid default-agent turn.`);
  try {
    const result = await request(`${base}/opencode/session/${session.id}/message`, {
      model: { providerID: out.providerId, modelID: out.modelId },
      parts: [{ type: "text", text: `This is an authorized fictional Acme Robotics rehearsal. Read the brief at the absolute workspace path ${JSON.stringify(`${workspace.path}/WORKSHOP.md`)} first (not /WORKSHOP.md). Use connected service tools, not local substitutes. Discover the Confluence content search tool (capability discovery searches tool metadata, not documents), then search the PROD product space for the Atlas 2 and Atlas Lift datasheets. Search returns excerpts only: separately discover confluence_get_page and retrieve both complete pages by their discovered IDs before any write. Do not use execute_capability_script or literal-return scripts to invent service content. Do not guess page IDs or use Jira's DOC key as a Confluence space. Create a Jira Task in DOC titled "${marker}" assigned to Nora Patel, with a short factual product comparison in its description. Create a OneDrive text document named "${marker}.txt" with that comparison. Discover the Outlook mail_search and mail_read capabilities, list the Inbox and read its most recent message (the latest update in the customer-review thread). Discover mail_create_reply_draft and use this threaded reply-draft operation to create a reply DRAFT in that same conversation that links the OneDrive document; do not send. You have explicit approval for these three mock writes. Verify all three using connected reads. If blocked, stop and say why. Do not use external real services. Report the issue key, draft ID, and document ID.` }],
    });
    if (record(result) && record(result.info) && result.info.error) throw new Error("Default-agent inference returned an error; inspect private runtime logs.");
  } catch (error) {
    await request(`${base}/opencode/session/${session.id}/abort`, {}).catch(() => undefined);
    throw error;
  }
}
const messages = await request(`${base}/opencode/session/${session.id}/message`);
const atlassian = await fetch(out.atlassianState).then((r) => r.json());
const microsoft = await fetch(out.microsoftState).then((r) => r.json());
const { issue, document, draft } = verifyWorkshop({ messages, atlassian, microsoft, marker, providerId: out.providerId, modelId: out.modelId });
assert.equal(microsoft.messages.filter((mail: { parentFolderId: string }) => mail.parentFolderId === "sentitems").length, beforeMail.messages.filter((mail: { parentFolderId: string }) => mail.parentFolderId === "sentitems").length, "Rehearsal must not send mail");
if (!existingSession) assert.ok(!beforeMail.messages.some((mail: { id: string }) => mail.id === draft.id), "Expected a newly created draft");
console.log(JSON.stringify({ verdict: "Passed", mode: existingSession ? "read-only verification of actual paid session" : "paid rehearsal", sessionId: session.id, marker, issueKey: issue.key, draftId: draft.id, documentId: document.id, checks: ["default OpenWork agent and paid model", "both complete Confluence product reads", "DOC ticket assigned to Nora", "OneDrive comparison content", "threaded Outlook reply draft", "no mail sent"] }, null, 2));
