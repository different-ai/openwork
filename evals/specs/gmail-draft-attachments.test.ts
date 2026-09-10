import { expect } from "vitest";
import { eventually, needs, test } from "@openwork/testkit";
import { gmailAttachmentFixtures, gmailDraftAttachments, gmailReplyFixtures } from "../worlds/gmail-draft-attachments.ts";

// New journey: native MCP preflight must reach the managed engine's real after-hook,
// then the authenticated host upload and Den MIME writer, without a second tool call.
test("Gmail attachments cross the real MCP, engine hook, host and Den boundaries without sending or changing identity", { timeout: 600_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun", "pnpm"], placement: "local" });
  await using world = await gmailDraftAttachments(place);
  console.log(`placement: ${place.kind} (real managed OpenCode 1.18.18, isolated Den, synthetic Google and model)`);
  const uploads = () => world.requests().filter((entry) => entry.path === "/v1/direct-uploads/google-workspace/gmail-drafts");
  async function finish(id: string) {
    const messages = await eventually(async () => {
      expect(world.model.failures()).toEqual([]);
      return world.messages(id);
    }, {
      within: 90_000, intervalMs: 250, label: "real engine consumes the tool result and finishes",
      until: (messages) => world.objects(messages).some((part) => part.type === "text" && part.text === "Draft attachment check complete."),
    });
    expect(world.objects(messages).filter((part) => part.type === "tool").map((part) => part.tool)).toEqual(["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"]);
    return messages;
  }
  const initialProviderCalls = await world.providerRequests();
  const search = await world.mcp("search_capabilities", { query: "gmail draft attachments", limit: 20 });
  const match = world.objects(search).find((entry) => entry.name === world.capability);
  expect(match).toBeDefined();
  expect(JSON.stringify(match)).toContain("attachments");
  const preflight = await world.mcp("execute_capability", { name: match?.name, body: world.body });
  expect(preflight.isError).toBe(false);
  expect(world.objects(preflight)).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false, error: "file_input_requires_host", created: false })]));
  expect(await world.providerRequests()).toEqual(initialProviderCalls);
  expect(uploads()).toEqual([]);
  evidence.recordAssertionEvidence("Real Gmail discovery and execution preflight do not create a draft", "The real Den gateway advertises attachment paths; exact native execution returns the non-MCP-error host marker with created=false. Neither an upload nor a Google request occurs before host fulfillment.", true);

  const prompt = "Create an inventory review draft in the selected mailbox with inventory.csv and sample.bin attached. Do not send it.";
  expect(prompt).not.toContain(world.selectedId);
  const beforeEngine = world.requests().length;
  const messages = await finish(await world.run(prompt));
  const engineCalls = world.requests().slice(beforeEngine).filter((entry) => entry.tool);
  expect(engineCalls.map((entry) => entry.tool)).toEqual(["search_capabilities", "execute_capability"]);
  expect(engineCalls[1]).toMatchObject({
    member: "first", args: { name: world.capability, body: world.body },
    result: { isError: false }, draftsBeforeReply: 0,
  });
  expect(uploads()).toHaveLength(1);
  expect(uploads()[0]).toMatchObject({ member: "first", status: 200, payload: { connectionId: world.selectedId, to: world.body.to, subject: world.body.subject, body: world.body.body } });
  const receipt = world.objects(messages).find((entry) => typeof entry.draftId === "string" && typeof entry.draftUrl === "string");
  expect(receipt).toMatchObject({ ok: true, attachments: gmailAttachmentFixtures.map((file) => ({ filename: file.filename, mimeType: file.mimeType, size: file.bytes.byteLength })) });
  expect(String(receipt?.draftUrl)).toContain(encodeURIComponent(world.mailboxes.selected));
  expect(world.objects(world.model.inputs()).some((entry) => typeof entry.draftId === "string" && entry.draftId === receipt?.draftId)).toBe(true);
  const drafts = await world.google.draftsFor(world.mailboxes.selected, { timeoutMs: 5_000 });
  expect(drafts).toHaveLength(1);
  expect(drafts[0]).toMatchObject({ to: world.body.to, body: world.body.body, tokenId: expect.any(String) });
  expect(drafts[0].attachments).toHaveLength(gmailAttachmentFixtures.length);
  for (const [index, file] of gmailAttachmentFixtures.entries()) {
    expect(drafts[0].attachments?.[index]).toEqual({ filename: file.filename, mimeType: file.mimeType, size: file.bytes.byteLength, content: file.bytes });
  }
  expect(await world.google.draftsFor(world.mailboxes.other, { timeoutMs: 5_000 })).toEqual([]);
  expect(await world.google.draftsFor(world.mailboxes.second, { timeoutMs: 5_000 })).toEqual([]);
  const completedCalls = await world.providerRequests();
  expect(completedCalls.slice(initialProviderCalls.length).map((entry) => [entry.method, entry.path])).toEqual([["POST", "/gmail/v1/users/me/drafts"]]);
  evidence.recordAssertionEvidence("The pinned engine after-hook uploads once and Den drafts exact bytes for the selected member and connector", "A deterministic model performed real search then exact native execute. The gateway returned the marker before any draft existed. Without another model tool call, the real plugin and host uploaded once, Den returned a reviewable receipt, and Google decoded exact CSV and binary bytes. Both non-selected mailboxes stayed empty; the sole provider operation was drafts POST.", true);

  const negativeCalls = await world.providerRequests();
  for (const paths of [["../outside.bin"], ["escape.bin"]]) {
    const failed = await finish(await world.run(`Prepare an inventory draft using ${paths[0]}; do not send it.`, paths));
    expect(world.objects(failed).some((entry) => typeof entry.draftId === "string")).toBe(false);
    expect(uploads()).toHaveLength(1);
    expect(await world.providerRequests()).toEqual(negativeCalls);
  }
  const beforeTrap = world.requests().length;
  await finish(await world.run("Inspect the Attachment Trap result without creating a draft.", [], true));
  const trapCalls = world.requests().slice(beforeTrap).filter((entry) => entry.tool === "execute_capability");
  expect(trapCalls).toHaveLength(1);
  expect(world.objects(trapCalls[0].result).some((entry) => entry.error === "file_input_requires_host")).toBe(true);
  expect(uploads()).toHaveLength(1);
  expect(await world.providerRequests()).toEqual(negativeCalls);
  evidence.recordAssertionEvidence("Unsafe workspace paths and external capability markers cannot cause uploads", "Real engine executions using traversal and an escaping symlink produced no draft or upload. A real external MCP tool returned the same host marker through Den; the plugin did not treat it as native Gmail authority. Google saw no additional requests.", true);

  await world.hostIdentity("missing");
  const missingAuth = await finish(await world.run("Prepare another inventory review draft with the same attachments, without sending."));
  expect(world.objects(missingAuth).some((entry) => typeof entry.draftId === "string")).toBe(false);
  expect(uploads()).toHaveLength(1);
  expect(await world.providerRequests()).toEqual(negativeCalls);
  await world.hostIdentity("first");
  // These are explicit negative transport probes, never a substitute for positive hook fulfillment.
  expect((await world.rejectedUpload("missing", world.selectedId)).status).toBe(401);
  expect((await world.rejectedUpload("second", world.selectedId)).status).toBe(409);
  expect((await world.rejectedUpload("first", world.unavailableId)).status).toBe(409);
  expect(await world.providerRequests()).toEqual(negativeCalls);
  expect(await world.google.draftsFor(world.mailboxes.other, { timeoutMs: 5_000 })).toEqual([]);
  expect(await world.google.draftsFor(world.mailboxes.second, { timeoutMs: 5_000 })).toEqual([]);
  evidence.recordAssertionEvidence("Missing auth and unavailable member/connector selections fail closed", "The real engine hook could not upload with missing host Cloud authorization. Separate real Den multipart negative probes rejected an absent bearer, another member without the selected credential, and an unconnected selection, without falling back to the connected default mailbox or calling Google.", true);

  const beforeReply = world.requests().length;
  const uploadsBeforeReply = uploads().length;
  const plain = gmailReplyFixtures.plain;
  const replyBody = { threadId: plain.id, subject: plain.subject, body: plain.body };
  const replyPrompt = "Reply to the inventory conversation in the selected mailbox with inventory.csv and sample.bin attached. Leave it as a draft.";
  expect(replyPrompt).not.toContain(world.selectedId);
  expect(replyPrompt).not.toContain(plain.id);
  const replyMessages = await finish(await world.run(replyPrompt, world.body.attachments, false, replyBody));
  const replyCalls = world.requests().slice(beforeReply).filter((entry) => entry.tool);
  expect(replyCalls.map((entry) => entry.tool)).toEqual(["search_capabilities", "execute_capability"]);
  expect(replyCalls[1]).toMatchObject({ member: "first", args: { name: world.capability, body: replyBody }, draftsBeforeReply: 1 });
  expect(uploads()).toHaveLength(uploadsBeforeReply + 1);
  expect(uploads()[uploadsBeforeReply]).toMatchObject({ member: "first", status: 200, payload: { connectionId: world.selectedId, threadId: plain.id } });
  const replyDrafts = await world.google.draftsFor(world.mailboxes.selected, { timeoutMs: 5_000 });
  expect(replyDrafts).toHaveLength(2);
  const reply = replyDrafts[1];
  expect(reply).toMatchObject({ to: world.body.to, threadId: plain.id, returnedThreadId: plain.returnedThreadId, draftId: expect.any(String), messageId: expect.any(String), tokenId: drafts[0].tokenId });
  expect(reply.attachments).toEqual(gmailAttachmentFixtures.map((file) => ({ filename: file.filename, mimeType: file.mimeType, size: file.bytes.byteLength, content: file.bytes })));
  const mime = reply.mime;
  if (!mime) throw new Error("Google did not capture the reply MIME");
  expect(mime.raw).toContain("Content-Type: multipart/mixed;");
  expect(mime.raw).toContain("Content-Type: multipart/alternative;");
  expect(mime.inReplyTo).toBe("<latest@test.example>");
  expect(mime.references).toBe("<root@test.example> <older@test.example> <latest@test.example>");
  expect(mime.subject).toBe(plain.subject.replace("\r\n", " ").trim());
  expect(mime.headers).not.toMatch(/[^\x00-\x7f]/);
  const subjectHeader = mime.headers.match(/^Subject:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*/m)?.[0];
  expect(subjectHeader).toBeDefined();
  expect(subjectHeader?.split("\r\n").every((line) => Buffer.byteLength(line) <= 78)).toBe(true);
  const encodedWords = subjectHeader?.match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? [];
  expect(encodedWords.length).toBeGreaterThan(1);
  expect(encodedWords.every((word) => word.length <= 75)).toBe(true);
  expect(mime.headers.split("\r\n").filter((line) => !/^[ \t]/.test(line)).map((line) => line.split(":")[0])).toEqual(["To", "Subject", "In-Reply-To", "References", "MIME-Version", "Content-Type"]);
  expect(mime.plain).toBe(`${plain.body}\n\nOn Tue, 08 Sep 2026 at 12:34 UTC, Latest Sender <latest@test.example> wrote:\n> Latest plain history & <SCRIPT>history-sentinel</SCRIPT>\n> <IMG src="history" onerror="history-sentinel">`);
  expect(mime.html).toContain('<div class="gmail_quote">');
  expect(mime.html).toMatch(/<blockquote\b[^>]*>[\s\S]*Latest plain history &amp; &lt;SCRIPT&gt;history-sentinel&lt;\/SCRIPT&gt;[\s\S]*&lt;IMG src="history" onerror="history-sentinel"&gt;[\s\S]*<\/blockquote>/);
  expect(mime.html).toContain('Thanks &amp; please review &lt;SCRIPT&gt;new-prose&lt;/SCRIPT&gt; and &lt;IMG src="new"&gt;.');
  expect(mime.html).not.toMatch(/<(?:script|img)\b|OLDER-HISTORY-MUST-NOT-BE-QUOTED/i);
  const mailboxUrl = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(world.mailboxes.selected)}`;
  const replyReceipt = {
    ok: true, draftId: reply.draftId, messageId: reply.messageId,
    draftUrl: `${mailboxUrl}#drafts?compose=${reply.messageId}`,
    threadId: plain.returnedThreadId, threadUrl: `${mailboxUrl}#all/${plain.returnedThreadId}`, quotedHistoryIncluded: true,
  };
  const toolResults = world.objects(replyMessages).filter((entry) => entry.type === "tool" && entry.tool === "openwork-cloud_execute_capability");
  expect(world.objects(toolResults)).toEqual(expect.arrayContaining([expect.objectContaining(replyReceipt)]));
  expect(world.objects(world.model.inputs())).toEqual(expect.arrayContaining([expect.objectContaining(replyReceipt)]));
  expect(await world.providerRequests()).toEqual([...negativeCalls,
    expect.objectContaining({ method: "GET", url: `/gmail/v1/users/me/threads/${plain.id}?format=full`, email: world.mailboxes.selected }),
    expect.objectContaining({ method: "POST", path: "/gmail/v1/users/me/drafts", email: world.mailboxes.selected }),
  ]);
  evidence.recordAssertionEvidence("Multipart replies preserve bytes, safe quoted history, threading and provider receipts through the engine hook", "The selected mailbox alone received one full-thread GET and one drafts POST. Provider-observed MIME has the latest plain history in an escaped HTML blockquote and a plain alternative, exact References/In-Reply-To, safely folded Unicode subject with no injected header, and unchanged attachments. The real execute tool result and next model input contain the provider's actual IDs and mailbox URLs, including its different returned thread ID.", true);

  const html = gmailReplyFixtures.html;
  const jsonReply = await world.mcp("execute_capability", { name: world.capability, body: { to: world.body.to, threadId: html.id, subject: html.subject, body: html.body } });
  expect(jsonReply.isError).toBe(false);
  expect(uploads()).toHaveLength(uploadsBeforeReply + 1);
  const allDrafts = await world.google.draftsFor(world.mailboxes.selected, { timeoutMs: 5_000 });
  expect(allDrafts).toHaveLength(3);
  const jsonDraft = allDrafts[2];
  expect(jsonDraft).toMatchObject({ to: world.body.to, threadId: html.id, returnedThreadId: null, draftId: expect.any(String), messageId: expect.any(String), tokenId: drafts[0].tokenId });
  expect(jsonDraft.attachments ?? []).toEqual([]);
  expect(jsonDraft.mime).toMatchObject({ subject: html.subject, inReplyTo: "<latest@test.example>", references: "<root@test.example> <older@test.example> <latest@test.example>" });
  expect(jsonDraft.mime?.raw).toContain("Content-Type: multipart/alternative;");
  expect(jsonDraft.mime?.plain).toContain(`${html.body}\n\nOn Tue, 08 Sep 2026 at 12:34 UTC, Latest Sender <latest@test.example> wrote:\n> HTML-only latest & readable.`);
  expect(jsonDraft.mime?.plain).toContain("> <SCRIPT>literal-sentinel</SCRIPT>");
  expect(jsonDraft.mime?.html).toContain('<div class="gmail_quote">');
  expect(jsonDraft.mime?.html).toMatch(/<blockquote\b[^>]*>[\s\S]*HTML-only latest &amp; readable\.[\s\S]*&lt;SCRIPT&gt;literal-sentinel&lt;\/SCRIPT&gt;[\s\S]*<\/blockquote>/);
  for (const alternative of [jsonDraft.mime?.html, jsonDraft.mime?.plain]) {
    expect(alternative).not.toMatch(/active-(?:script|style|image)-sentinel|image\.test\.example|OLDER-HISTORY-MUST-NOT-BE-QUOTED/);
  }
  expect(jsonDraft.mime?.html).not.toMatch(/<(?:script|style|img)\b/i);
  expect(world.objects(jsonReply)).toEqual(expect.arrayContaining([expect.objectContaining({
    ok: true, draftId: jsonDraft.draftId, messageId: jsonDraft.messageId,
    draftUrl: `${mailboxUrl}#drafts?compose=${jsonDraft.messageId}`,
    threadId: null, threadUrl: null, quotedHistoryIncluded: true,
  })]));
  expect((await world.providerRequests()).slice(negativeCalls.length)).toEqual([
    expect.objectContaining({ method: "GET", url: `/gmail/v1/users/me/threads/${plain.id}?format=full`, email: world.mailboxes.selected }),
    expect.objectContaining({ method: "POST", path: "/gmail/v1/users/me/drafts", email: world.mailboxes.selected }),
    expect.objectContaining({ method: "GET", url: `/gmail/v1/users/me/threads/${html.id}?format=full`, email: world.mailboxes.selected }),
    expect.objectContaining({ method: "POST", path: "/gmail/v1/users/me/drafts", email: world.mailboxes.selected }),
  ]);
  expect(await world.google.draftsFor(world.mailboxes.other, { timeoutMs: 5_000 })).toEqual([]);
  expect(await world.google.draftsFor(world.mailboxes.second, { timeoutMs: 5_000 })).toEqual([]);
  evidence.recordAssertionEvidence("Direct JSON replies safely convert HTML-only history and never invent a provider thread receipt", "A second full-thread GET and drafts POST stayed on the selected mailbox without a host upload. Both MIME alternatives contain converted readable history and exclude active script/style/image content and older messages. The actual provider draft/message IDs reach the MCP result; omitted provider threadId yields null threadId and threadUrl. Both other mailboxes remain untouched.", true);

  const modelVisible = JSON.stringify(world.model.inputs());
  for (const file of gmailAttachmentFixtures) {
    expect(modelVisible).not.toContain(file.bytes.toString("base64"));
    expect(modelVisible).not.toContain(file.bytes.toString("base64url"));
  }
  expect(modelVisible).not.toContain("fixture-widget,17");
  expect(modelVisible).not.toContain("Content-Transfer-Encoding:");
  expect(world.model.emitted().every((call) => ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"].includes(call.tool))).toBe(true);
  expect((await world.providerRequests()).filter((entry) => /\/(messages|drafts)\/send$/.test(String(entry.path)))).toEqual([]);
  evidence.recordAssertionEvidence("File bytes stay outside model context and no send is attempted", "All actual model inputs were checked for both attachment base64 alphabets, CSV contents and MIME payloads. The model only requested search and execute. The complete provider request witness contains no messages/send or drafts/send attempt.", true);
});
