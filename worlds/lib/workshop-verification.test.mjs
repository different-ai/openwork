import test from "node:test";
import assert from "node:assert/strict";
import { verifyWorkshop } from "./workshop-verification.mjs";

function fixture() {
  const marker = "Workshop-comparison-1";
  const pages = [{ id: "1", title: "Atlas 2 datasheet" }, { id: "2", title: "Atlas Lift datasheet" }];
  const call = (name, value) => ({ type: "tool", tool: "openwork-cloud_execute_capability", state: { status: "completed", input: { name: `mcp:fixture:${name}` }, output: JSON.stringify(value) } });
  const issue = { key: "DOC-45", summary: marker, project: "DOC", assignee: "nora", description: "Atlas 2 compared to Atlas Lift" };
  const document = { id: "file-1", name: `${marker}.txt`, webUrl: "http://127.0.0.1/onedrive?item=file-1", preview: { text: "Atlas 2 compared to Atlas Lift" } };
  const source = { id: "mail-1", parentFolderId: "inbox", conversationId: "customer-thread", body: { content: "Complete latest customer-review message." }, receivedDateTime: "2026-10-17T00:00:00Z" };
  const draft = { id: "draft-1", isDraft: true, parentFolderId: "drafts", conversationId: source.conversationId, body: { content: document.webUrl } };
  return { marker, providerId: "fixture", modelId: "fixture-model", atlassian: { jira: { issues: [issue] }, confluence: { pages } }, microsoft: { files: [document], messages: [source, draft] }, messages: [{ info: { role: "assistant", agent: "openwork", providerID: "fixture", modelID: "fixture-model", time: { completed: 1 }, finish: "stop" }, parts: [...pages.map((page) => call("confluence_get_page", { ...page, content: "Actual product content. ".repeat(30) })), call("jira_create_issue", issue), call("file_write", document), call("mail_read", source), call("mail_create_reply_draft", draft)] }] };
}
test("workshop requires actual completed tool reads and correlated backend writes", () => {
  assert.equal(verifyWorkshop(fixture()).issue.key, "DOC-45");
  const searchRead = fixture();
  const mailRead = searchRead.messages[0].parts.find((part) => part.state.input.name.endsWith("mail_read"));
  mailRead.state.input.name = "mcp:fixture:mail_search";
  mailRead.state.output = JSON.stringify({ value: [searchRead.microsoft.messages[0]] });
  assert.equal(verifyWorkshop(searchRead).draft.id, "draft-1");
  mailRead.state.output = JSON.stringify({ value: [{ id: "mail-1", bodyPreview: "Incomplete excerpt" }] });
  assert.throws(() => verifyWorkshop(searchRead));
  for (const mutation of [
    (f) => { f.messages[0].info.error = { message: "failed" }; },
    (f) => { f.messages[0].parts[0].state.status = "running"; },
    (f) => { f.messages[0].parts[0].tool = "search_capabilities"; delete f.messages[0].parts[0].state.input.name; },
    (f) => { f.atlassian.jira.issues[0].assignee = "alex"; },
    (f) => { f.atlassian.jira.issues[0].project = "FLEET"; },
    (f) => { f.microsoft.files[0].preview.text = "empty comparison"; },
    (f) => { f.microsoft.messages[1].conversationId = "unrelated"; },
    (f) => { f.messages[0].parts.pop(); },
  ]) { const f = fixture(); mutation(f); assert.throws(() => verifyWorkshop(f)); }
});
