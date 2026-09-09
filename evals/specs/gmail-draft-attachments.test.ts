import { expect } from "vitest";
import { eventually, needs, test } from "@openwork/testkit";
import { gmailAttachmentFixtures, gmailDraftAttachments } from "../worlds/gmail-draft-attachments.ts";

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
