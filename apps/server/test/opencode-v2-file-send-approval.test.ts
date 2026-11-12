import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentPermissionRule } from "@openwork/types/den/agent-permissions";
import { fakeEngine, type Answer } from "./fixtures/drive-approval-engine.js";
import { createFileSendApprovals } from "../src/file-send-approval.js";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";

const scope = { baseUrl: "https://den.example", organizationId: "org_one", memberId: "mem_one" };

/** The four tools that send a local file, through the real bridge with the shared approval on. */
async function fixture(answer: Answer, rules: AgentPermissionRule[] = [], enabled = true) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "file-send-bridge-")));
  await writeFile(join(workspace, "report.pdf"), "report");
  const engine = await fakeEngine(answer);
  const sent: Array<{ path: string; body: Record<string, unknown>; approvedInChat: boolean }> = [];
  const host = (approvedInChat: boolean) => async (path: string, init?: RequestInit) => {
    sent.push({ path, body: JSON.parse(String(init?.body)), approvedInChat });
    return { ok: true };
  };
  const approvals = createFileSendApprovals({ policy: async () => ({ enabled, scope: enabled ? scope : null, rules }), storageDir: join(workspace, ".grants") });
  const bridge = await createV2ContextBridge(host(false), () => engine.connection, undefined, { approvals, approvedRequest: host(true) });
  const inputs: Record<string, unknown> = {
    openwork_drive_upload: { path: "report.pdf", connectionId: "google-workspace" },
    openwork_gmail_draft: { to: "sam@example.com", subject: "Report", body: "Attached.", paths: ["report.pdf"], connectionId: "google-workspace" },
    openwork_outlook_draft: { to: ["sam@example.com"], subject: "Report", body: "Attached.", paths: ["report.pdf"], connectionId: "microsoft-365" },
    drive_push_file: { path: "report.pdf" },
  };
  const call = async (name: string, sessionId = "ses_one") => {
    const response = await fetch(bridge.url, { method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, input: inputs[name], sessionId, caller: { directory: workspace, messageId: "msg_one", callId: "call_one", agent: "build" } }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { engine, sent, call, tools: Object.keys(inputs), close: async () => { await bridge.close(); await engine.close(); await rm(workspace, { recursive: true, force: true }); } };
}

test("every file-send tool shows the same host-owned choices and none relies on an engine rule", async () => {
  const f = await fixture({ effect: "ask", reply: "once" });
  try {
    for (const tool of f.tools) assert.equal((await f.call(tool)).status, 200, tool);
    assert.equal(f.engine.prompts.length, 4);
    for (const prompt of f.engine.prompts) {
      const metadata = prompt.metadata as { fileSend?: { kind: string; remember: string[] } };
      assert.equal(metadata.fileSend?.kind, prompt.action);
      assert.deepEqual(metadata.fileSend?.remember, ["session", "always"]);
      const resources = prompt.resources as string[];
      assert.equal(resources[0], "report.pdf");
      assert.match(resources[1] ?? "", /^file-send-request:[0-9a-f]{32}$/);
      assert.equal((prompt.save as string[]).length, 1);
    }
    // A save approved in the chat reaches the host marked, so it is not asked again in a Desktop dialog.
    assert.deepEqual(f.sent.map(item => item.approvedInChat), [false, false, false, true]);
  } finally { await f.close(); }
});

test("Allow for this chat is not asked again in that chat, for each tool on its own", async () => {
  const f = await fixture({ effect: "ask", reply: "always" });
  try {
    for (const tool of f.tools) {
      assert.equal((await f.call(tool)).status, 200, tool);
      assert.equal((await f.call(tool)).status, 200, tool);
    }
    assert.equal(f.engine.asked.length, 4);
    assert.equal(f.sent.length, 8);
    assert.equal((await f.call("openwork_gmail_draft", "ses_two")).status, 200);
    assert.equal(f.engine.asked.length, 5);
  } finally { await f.close(); }
});

test("an administrator's Block refuses every tool without asking, and Allow sends without asking", async () => {
  const blocked = await fixture({ effect: "ask", reply: "once" }, [{ action: "file_send", resource: "*", effect: "deny", source: "Everyone" }]);
  try {
    for (const tool of blocked.tools) {
      const result = await blocked.call(tool);
      assert.equal(result.status, 400, tool);
      assert.match(String(result.body.error), /Everyone|organization/);
    }
    assert.equal(blocked.engine.asked.length, 0);
    assert.equal(blocked.sent.length, 0);
  } finally { await blocked.close(); }
  const allowed = await fixture({ effect: "deny" }, [{ action: "file_send", resource: "*", effect: "allow", source: "Everyone" }]);
  try {
    for (const tool of allowed.tools) assert.equal((await allowed.call(tool)).status, 200, tool);
    assert.equal(allowed.engine.asked.length, 0);
    assert.equal(allowed.sent.length, 4);
  } finally { await allowed.close(); }
});

test("a declined or engine-allowed request sends nothing", async () => {
  for (const answer of [{ effect: "ask", reply: "reject" }, { effect: "allow" }, { effect: "deny" }] as const) {
    const f = await fixture(answer);
    try {
      for (const tool of f.tools) assert.equal((await f.call(tool)).status, 400, `${tool} ${answer.effect}`);
      assert.equal(f.sent.length, 0);
    } finally { await f.close(); }
  }
});

test("with the rollout off each tool keeps its earlier prompt and saves stay unmarked", async () => {
  const f = await fixture({ effect: "ask", reply: "once" }, [], false);
  try {
    for (const tool of f.tools) assert.equal((await f.call(tool)).status, 200, tool);
    for (const prompt of f.engine.prompts) assert.equal((prompt.metadata as Record<string, unknown>).fileSend, undefined);
    assert.deepEqual(f.sent.map(item => item.approvedInChat), [false, false, false, false]);
  } finally { await f.close(); }
});
