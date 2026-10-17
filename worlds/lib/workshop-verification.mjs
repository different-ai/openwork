import assert from "node:assert/strict";

/** Assertions shared by the paid probe and the read-only browser proof. Never print private transcripts. */
export function verifyWorkshop({ messages, atlassian, microsoft, marker, providerId, modelId }) {
  assert.ok(Array.isArray(messages) && messages.length, "Missing session history");
  const assistants = messages.filter((message) => message.info?.role === "assistant");
  assert.ok(assistants.length && assistants.every((message) => !message.info.error), "Assistant history contains an error");
  const last = assistants.at(-1);
  assert.ok(last.info.time?.completed && last.info.finish === "stop", "Assistant turn has not completed normally");
  assert.equal(last.info.agent, "openwork", "Expected the app's OpenWork agent, not a build-agent substitute");
  assert.equal(last.info.providerID, providerId, "Unexpected inference provider");
  assert.equal(last.info.modelID, modelId, "Unexpected inference model");
  const tools = assistants.flatMap((message) => (message.parts ?? []).filter((part) => part.type === "tool"));
  assert.ok(tools.every((part) => !["pending", "running"].includes(part.state?.status)), "A tool is awaiting completion or approval");
  const executions = tools.filter((part) => part.state?.status === "completed" && !/search_capabilities/.test(part.tool));
  const calls = (name) => executions.filter((part) => String(part.state?.input?.name ?? part.tool).endsWith(name));
  assert.equal(calls("mail_send").length, 0, "Rehearsal must not send mail");
  const output = (part) => typeof part.state.output === "string" ? part.state.output : JSON.stringify(part.state.output);
  const datasheets = atlassian.confluence.pages.filter((page) => /datasheet/i.test(page.title) && /Atlas (2|Lift)/.test(page.title));
  assert.equal(datasheets.length, 2, "Expected both seeded product datasheets");
  for (const page of datasheets) assert.ok(calls("confluence_get_page").some((part) => output(part).includes(page.title) && output(part).includes(String(page.id)) && output(part).length > 300), "Both complete Confluence product pages must be read by tools");
  const issue = atlassian.jira.issues.find((item) => item.summary === marker);
  assert.ok(issue && /^DOC-\d+$/.test(issue.key) && issue.project === "DOC", "No matching DOC ticket");
  assert.equal(issue.assignee, "nora", "DOC ticket must be assigned to Nora");
  assert.match(issue.description ?? "", /Atlas\s*2/i);
  assert.match(issue.description ?? "", /Atlas\s*Lift/i);
  assert.ok(calls("jira_create_issue").some((part) => output(part).includes(issue.key)), "Session must create the observed Jira issue");
  const document = microsoft.files.find((file) => file.name === `${marker}.txt`);
  assert.ok(document && /Atlas\s*2/i.test(document.preview?.text ?? "") && /Atlas\s*Lift/i.test(document.preview?.text ?? ""), "OneDrive comparison content missing");
  assert.ok(calls("file_write").some((part) => output(part).includes(document.id)), "Session must write the observed document");
  const source = microsoft.messages.filter((mail) => mail.parentFolderId === "inbox").sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime))[0];
  const readLatest = source && (calls("mail_read").some((part) => output(part).includes(source.id)) || calls("mail_search").some((part) => {
    // This demo's mail search returns complete Graph message bodies, not snippets.
    // Accept that actual provider read only when it contains the exact latest body.
    try { const found = JSON.parse(output(part)).value; return Array.isArray(found) && found.some((mail) => mail.id === source.id && typeof source.body?.content === "string" && mail.body?.content === source.body.content); } catch { return false; }
  }));
  assert.ok(readLatest, "Session must read the complete latest inbox message");
  const draft = microsoft.messages.find((mail) => mail.isDraft && mail.parentFolderId === "drafts" && mail.conversationId === source.conversationId && (mail.body?.content?.includes(document.webUrl) || mail.body?.content?.includes(document.id)));
  assert.ok(draft, "No unsent threaded reply linking the comparison document");
  assert.ok(calls("mail_create_reply_draft").some((part) => output(part).includes(draft.id)), "Session must create the observed reply draft");
  return { issue, document, draft, datasheets };
}
