import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { isPromptAdmissionUnknown, promptAdmissionFailure } from "../src/app/lib/opencode";
import { presentOpencodeSessionError } from "../src/react-app/domains/session/sync/session-error";

async function fixture(reply: (path: string) => Response) {
  const server = createServer(async (request, response) => {
    const result = reply(new URL(request.url ?? "/", "http://localhost").pathname);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a loopback port");
  return { url: `http://127.0.0.1:${address.port}`, async close() {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  } };
}

// The pinned native hook has no typed rejection payload. This is an HTTP
// contract/presentation regression, not a claim to know why admission failed.
test("an empty native admission rejection keeps the message unknown and gives a safe next action", async () => {
  let prompts = 0;
  const server = await fixture(path => {
    if (path.endsWith("/prompt")) { prompts++; return new Response(null, { status: 500 }); }
    return Response.json({ data: {} });
  });
  try {
    const client = createClientV2(server.url, undefined, {});
    const result = await client.session.promptAsync({ sessionID: "session", messageID: "message", model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Run review instructions" }] });
    expect(result.data).toBeUndefined();
    expect(isPromptAdmissionUnknown(result.error)).toBe(true);
    if (!isPromptAdmissionUnknown(result.error)) throw new Error("Expected the existing admission hold");
    const presentation = presentOpencodeSessionError(promptAdmissionFailure(result.error));
    expect(presentation.title).toContain("Check pending approvals and skill access");
    expect(presentation.title).not.toMatch(/Loaded|Used|blocked by|not sent/i);
    expect(prompts).toBe(1);
  } finally { await server.close(); }
});

test("a definite selected-skill permission rejection remains blocked before any prompt is sent", async () => {
  let prompts = 0;
  const server = await fixture(path => {
    if (path === "/api/skill") return Response.json({ data: [{ id: "review", name: "Review" }] });
    if (path.endsWith("/permission")) return Response.json({ data: { effect: "deny" } });
    if (path.endsWith("/prompt")) prompts++;
    return Response.json({ data: {} });
  });
  try {
    const client = createClientV2(server.url, undefined, {});
    const result = await client.session.promptAsync({ sessionID: "session", model: { providerID: "fixture", modelID: "fixture" }, parts: [
      { type: "text", text: "Review this" }, { type: "text", text: "", synthetic: true, metadata: { openworkSelectedSkill: { id: "review", name: "Review" } } },
    ] });
    expect(result.data).toBeUndefined();
    expect(isPromptAdmissionUnknown(result.error)).toBe(false);
    expect(JSON.stringify(result.error)).toContain("Selected skills are not permitted");
    expect(prompts).toBe(0);
  } finally { await server.close(); }
});
