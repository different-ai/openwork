import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentPermissionRule } from "@openwork/types/den/agent-permissions";
import { createFileSendApprovals, markFileSendApproved, takeFileSendApproved, type FileSendAsk, type FileSendPolicy, type FileSendRequest } from "../src/file-send-approval.js";

const scope = { baseUrl: "https://den.example", organizationId: "org_one", memberId: "mem_one" };
const rule = (effect: AgentPermissionRule["effect"]): AgentPermissionRule => ({ action: "file_send", resource: "*", effect, source: "Everyone" });

async function fixture(rules: AgentPermissionRule[] = []) {
  const root = await mkdtemp(join(tmpdir(), "file-send-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(workspace, "report.pdf"), "report");
  await writeFile(join(outside, "secret.pdf"), "secret");
  const policy: FileSendPolicy = { enabled: true, scope, rules };
  const storageDir = join(root, "grants");
  const approvals = createFileSendApprovals({ policy: async () => policy, storageDir });
  const prompts: Array<Parameters<FileSendAsk>[0]> = [];
  /** Answers like the app: "always" records the choice with the host before replying. */
  const answer = (reply: "once" | "session" | "always" | "reject"): FileSendAsk => async prompt => {
    prompts.push(prompt);
    const id = `per_${prompts.length}`;
    prompt.asked(id);
    if (reply === "reject") throw new Error("declined");
    if (reply === "always") assert.equal(approvals.chooseAlways(id), true);
    return reply === "once" ? "once" : "always";
  };
  const request = (overrides: Partial<FileSendRequest> = {}): FileSendRequest => ({
    kind: "gmail_create_draft_with_attachments", directory: workspace, sessionId: "ses_one", agent: "build",
    paths: ["report.pdf"], account: "google-workspace", ...overrides,
  });
  return { root, workspace, outside, policy, storageDir, approvals, prompts, answer, request, close: () => rm(root, { recursive: true, force: true }) };
}

test("with no administrator decision the member is asked and offered both ways to remember", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.approvals.approve(f.policy, f.request(), "nothing was sent", f.answer("once")), "once");
    assert.deepEqual(f.prompts[0]?.metadata, { fileSend: { kind: "gmail_create_draft_with_attachments", remember: ["session", "always"] } });
    assert.equal(f.prompts[0]?.save.length, 1);
    // Allow once remembers nothing, and no two questions share a resource an engine rule could match.
    assert.equal(await f.approvals.approve(f.policy, f.request(), "nothing was sent", f.answer("once")), "once");
    assert.notDeepEqual(f.prompts[0]?.resources, f.prompts[1]?.resources);
  } finally { await f.close(); }
});

test("Allow for this chat covers the same tool, account, agent and chat, for files in the workspace", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "other.pdf"), "other");
    assert.equal(await f.approvals.approve(f.policy, f.request(), "nothing was sent", f.answer("session")), "session");
    assert.equal(await f.approvals.approve(f.policy, f.request({ paths: ["other.pdf"] }), "nothing was sent", f.answer("reject")), "remembered");
    for (const other of [{ sessionId: "ses_two" }, { agent: "plan" }, { account: "emc_other" }, { kind: "drive_upload_file" }, { paths: [join(f.outside, "secret.pdf")] }]) {
      await assert.rejects(f.approvals.approve(f.policy, f.request(other), "nothing was sent", f.answer("reject")), /declined/, JSON.stringify(other));
    }
    assert.deepEqual((await f.approvals.grants()).grants, []);
  } finally { await f.close(); }
});

test("Always allow is stored privately for this member and applies in other chats until removed", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.approvals.approve(f.policy, f.request(), "nothing was sent", f.answer("always")), "always");
    assert.equal(await f.approvals.approve(f.policy, f.request({ sessionId: "ses_two", agent: "plan" }), "nothing was sent", f.answer("reject")), "remembered");
    const [file] = await readdir(f.storageDir);
    assert.ok(file);
    assert.equal((await stat(join(f.storageDir, file))).mode & 0o777, 0o600);
    const { grants } = await f.approvals.grants();
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.account, "google-workspace");
    // Another member, account, tool or outside file is not covered.
    const stranger: FileSendPolicy = { ...f.policy, scope: { ...scope, memberId: "mem_two" } };
    await assert.rejects(f.approvals.approve(stranger, f.request({ sessionId: "ses_three" }), "nothing was sent", f.answer("reject")), /declined/);
    for (const other of [{ account: "emc_other" }, { kind: "drive_upload_file" }, { paths: [join(f.outside, "secret.pdf")] }]) {
      await assert.rejects(f.approvals.approve(f.policy, f.request({ sessionId: "ses_three", ...other }), "nothing was sent", f.answer("reject")), /declined/);
    }
    assert.deepEqual((await f.approvals.revoke(grants[0]?.id ?? "")).grants, []);
    await assert.rejects(f.approvals.approve(f.policy, f.request({ sessionId: "ses_three" }), "nothing was sent", f.answer("reject")), /declined/);
  } finally { await f.close(); }
});

test("an unnamed default account or a file outside the workspace is never remembered for good", async () => {
  const f = await fixture();
  try {
    const { account: _account, ...unnamed } = f.request();
    await f.approvals.approve(f.policy, unnamed, "nothing was sent", f.answer("once"));
    assert.deepEqual(f.prompts[0]?.metadata.fileSend.remember, ["session"]);
    const outside = join(f.outside, "secret.pdf");
    await f.approvals.approve(f.policy, f.request({ paths: [outside], fileIdentity: "v1" }), "nothing was sent", f.answer("session"));
    assert.deepEqual(f.prompts[1]?.metadata.fileSend.remember, ["session"]);
    // The exact version only.
    assert.equal(await f.approvals.approve(f.policy, f.request({ paths: [outside], fileIdentity: "v1" }), "nothing was sent", f.answer("reject")), "remembered");
    await assert.rejects(f.approvals.approve(f.policy, f.request({ paths: [outside], fileIdentity: "v2" }), "nothing was sent", f.answer("reject")), /declined/);
    await f.approvals.approve(f.policy, f.request({ paths: [outside] }), "nothing was sent", f.answer("once"));
    assert.deepEqual(f.prompts.at(-1)?.metadata.fileSend.remember, []);
    assert.deepEqual(f.prompts.at(-1)?.save, []);
    // A choice the host never offered cannot be recorded.
    assert.equal(f.approvals.chooseAlways("per_unknown"), false);
  } finally { await f.close(); }
});

test("the administrator's decision comes before anything the member remembered", async () => {
  const f = await fixture();
  try {
    await f.approvals.approve(f.policy, f.request(), "nothing was sent", f.answer("always"));
    const asked = f.prompts.length;
    await assert.rejects(f.approvals.approve({ ...f.policy, rules: [rule("deny")] }, f.request(), "nothing was sent", f.answer("once")), /nothing was sent/);
    assert.equal(await f.approvals.approve({ ...f.policy, rules: [rule("allow")] }, f.request({ sessionId: "ses_new", account: "emc_other" }), "nothing was sent", f.answer("reject")), "administrator");
    assert.equal(f.prompts.length, asked);
    // Ask first asks every time and offers nothing to remember.
    const askFirst = { ...f.policy, rules: [rule("ask")] };
    assert.equal(await f.approvals.approve(askFirst, f.request(), "nothing was sent", f.answer("once")), "once");
    assert.equal(await f.approvals.approve(askFirst, f.request(), "nothing was sent", f.answer("once")), "once");
    assert.deepEqual(f.prompts.at(-1)?.metadata.fileSend.remember, []);
    assert.equal(f.prompts.length, asked + 2);
  } finally { await f.close(); }
});

test("the rollout being off or nobody signed in leaves each tool on its earlier prompt", async () => {
  const off = createFileSendApprovals({ policy: async () => ({ enabled: false, scope: null, rules: [] }), storageDir: join(tmpdir(), "unused-file-send") });
  assert.equal(await off.policy(), null);
  assert.deepEqual(await off.grants(), { enabled: false, grants: [] });
});

test("only a request this process marked counts as approved in the chat, once", () => {
  const request = new Request("http://127.0.0.1/experimental/drive-files/call", { method: "POST", headers: { "x-file-send-approved": "1" } });
  assert.equal(takeFileSendApproved(request), false);
  markFileSendApproved(request);
  assert.equal(takeFileSendApproved(request), true);
  assert.equal(takeFileSendApproved(request), false);
});
