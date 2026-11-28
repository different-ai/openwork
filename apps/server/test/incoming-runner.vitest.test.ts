import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { createFakeProvider } from "@openwork/sandbox/testing";
import type { ComputerSharingSettings } from "@openwork/types/computer-sharing";
import type { ComputerToolCall } from "@openwork/types/den/computers";
import { createIncomingRunner, runIncomingAssignment } from "../src/computers/incoming-runner.js";
import { createIncomingSandbox, IncomingSandboxUnavailable } from "../src/computers/incoming-sandbox.js";
import { computersFixture } from "./fixtures/computers.js";
import { fakeIncomingDen, incomingAssignment, incomingCredential } from "./fixtures/incoming-computers.js";

const allow: ComputerSharingSettings = { enabled: true, folders: [{ path: "/drafts", access: "edit" }, { path: "/notes", access: "read" }], sources: [{ kind: "computer", id: "source-computer" }] };
const shell: ComputerToolCall = { tool: "shell", input: { cwd: "/drafts", command: "pwd" } };
const direct = () => new AbortController().signal;

test("runs the six tools in order in one sandbox, with exactly the local mounts, then stops polling when sharing turns off", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "incoming-runner-")));
  const rw = join(root, "drafts");
  const ro = join(root, "notes");
  await Promise.all([mkdir(rw), mkdir(ro)]);
  let value: ComputerSharingSettings = { ...allow, folders: [{ path: ro, access: "read" }, { path: rw, access: "edit" }] };
  const provider = createFakeProvider({ onRun: spec => ({ stdout: spec.cwd === rw ? "shell" : "found notes", stderr: "", exitCode: 0 }) });
  const factory = vi.fn(async () => provider);
  const sandbox = createIncomingSandbox(computersFixture(root), { admit: async () => true, provider: factory });
  const create = vi.spyOn(provider, "create");
  const path = join(rw, "draft.txt");
  const calls: ComputerToolCall[] = [
    { tool: "shell", input: { cwd: rw, command: "pwd" } },
    { tool: "write", input: { path, content: "draft" } },
    { tool: "edit", input: { path, oldString: "draft", newString: "final" } },
    { tool: "read", input: { path } },
    { tool: "glob", input: { path: rw, pattern: "*.txt" } },
    { tool: "grep", input: { path: rw, pattern: "final" } },
  ];
  const items = calls.map((call, index) => incomingAssignment(call, value, `command-${index}`));
  const f = fakeIncomingDen(items, () => value, sandbox);
  f.runner.update(incomingCredential);
  try {
    await vi.waitFor(() => expect(f.waiting()).toBeDefined());
    expect([...f.results.values()]).toHaveLength(6);
    for (const result of f.results.values()) expect(result).toMatchObject({ status: "done", exitCode: 0 });
    expect(f.results.get("command-3")).toMatchObject({ output: "1: final" });
    expect(f.requests.slice(1, 13)).toEqual(items.flatMap(({ id }) => [`/v1/computer-commands/${id}/claim`, `/v1/computer-commands/${id}/complete`]));
    expect(factory).toHaveBeenCalledExactlyOnceWith([{ hostPath: ro, guestPath: ro, access: "ro" }, { hostPath: rw, guestPath: rw, access: "rw" }]);
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ env: {}, storage: [], exposePorts: [], lifecycle: { autoStopMinutes: 15 } }), expect.anything());
    const count = f.requests.length;
    value = { ...value, enabled: false };
    f.runner.update(incomingCredential);
    expect(f.waiting()?.aborted).toBe(true);
    await sandbox.stop();
    expect(f.requests).toHaveLength(count);
  } finally { f.runner.close(); await sandbox.close(); await rm(root, { recursive: true, force: true }); }
});

test("re-checks sharing, source, match of local mount paths and modes, and explicit path before touching the sandbox", async () => {
  const assignment = incomingAssignment(shell, allow);
  const run = vi.fn(async () => { throw new Error("No call expected"); });
  const refused = async (settings: ComputerSharingSettings, call = assignment, code: string) => {
    expect(await runIncomingAssignment(call, settings, { run }, direct())).toMatchObject({ status: "refused", code });
  };
  await refused({ ...allow, enabled: false }, assignment, "computer_not_allowed");
  await refused({ ...allow, sources: [{ kind: "workbot" }] }, assignment, "source_not_allowed");
  await refused({ ...allow, folders: allow.folders.slice(0, 1) }, assignment, "folder_not_shared");
  await refused({ ...allow, folders: [{ path: "/drafts", access: "read" }, { path: "/notes", access: "read" }] }, assignment, "folder_read_only");
  await refused(allow, incomingAssignment({ tool: "read", input: { path: "/other/not-shared" } }, allow), "folder_not_shared");
  await refused(allow, incomingAssignment({ tool: "write", input: { path: "/notes/readonly", content: "new" } }, allow), "folder_read_only");
  expect(run).not.toHaveBeenCalled();
});

test("legacy shell, file-system read-only errors, preflight failures and UTF-8 output caps", async () => {
  const content = "😁".repeat(10_000);
  const run = vi.fn<ReturnType<typeof createIncomingSandbox>["run"]>().mockResolvedValue({ content: [{ type: "text", text: content }], metadata: { sandbox: true, truncated: false } });
  const workbot = { ...allow, sources: [{ kind: "workbot" }] } satisfies ComputerSharingSettings;
  const initial = incomingAssignment(shell, workbot);
  const assignment = { ...initial, source: { ...initial.source, provider: "workbot" }, call: undefined } satisfies typeof initial;
  const output = await runIncomingAssignment(assignment, workbot, { run }, direct());
  expect(output).toMatchObject({ status: "done", truncated: true, exitCode: 0 });
  if (output.status === "done") expect(Buffer.byteLength(output.output)).toBeLessThanOrEqual(32_000);
  expect(run).toHaveBeenCalledWith(shell, workbot.folders, expect.any(AbortSignal));
  expect(await runIncomingAssignment({ ...assignment, action: { type: "read", path: "/drafts/file" } }, workbot, { run }, direct())).toMatchObject({ status: "failed", error: { code: "unsupported_request" } });
  run.mockRejectedValueOnce(new Error("Read-only file system"));
  expect(await runIncomingAssignment(incomingAssignment({ tool: "write", input: { path: "/drafts/file", content: "draft" } }, allow), allow, { run }, direct())).toEqual({ status: "failed", error: { code: "read_only", message: "That folder is shared read-only on this computer. Nothing was changed." } });
  run.mockRejectedValueOnce(new IncomingSandboxUnavailable("The sandbox couldn't start."));
  expect(await runIncomingAssignment(initial, allow, { run }, direct())).toEqual({ status: "failed", error: { code: "sandbox_unavailable", message: "The sandbox couldn't start. Nothing ran." } });
});

test.each([[404, "feature_disabled", 300_000], [403, "runner_capability_required", 30_000]])("backs off on target response %s %s, retaining the credential", async (status, error, ms) => {
  const featureOff = vi.fn();
  const rejected = vi.fn();
  const pause = vi.fn(async (_ms: number, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })));
  const runner = createIncomingRunner({ sandbox: { async run() { throw new Error("Unexpected run"); }, async stop() {} }, settings: async () => allow,
    available: async () => true, featureOff, rejected, pause, fetch: async () => Response.json({ error }, { status }),
  });
  runner.update(incomingCredential);
  try {
    await vi.waitFor(() => expect(pause).toHaveBeenCalledExactlyOnceWith(ms, expect.any(AbortSignal)));
    expect(rejected).not.toHaveBeenCalled();
    expect(featureOff).toHaveBeenCalledTimes(status === 404 ? 1 : 0);
  } finally { runner.close(); }
});

test("incoming work's runtime module graph never reaches source routes, service or executors", async () => {
  const seen = new Set<string>();
  async function scan(path: string) {
    if (seen.has(path)) return;
    seen.add(path);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("/v1/computer-sources");
    expect(path).not.toMatch(/\/computers\/(?:den|service|executors(?:\/.*)?)\.ts$/u);
    for (const [, relative] of text.matchAll(/^import (?!type )[\s\S]*? from "(\.{1,2}\/[^"\n]+)\.js";/gm)) {
      await scan(resolve(dirname(path), `${relative}.ts`));
    }
  }
  await scan(fileURLToPath(new URL("../src/computers/incoming-runner.ts", import.meta.url)));
  await scan(fileURLToPath(new URL("../src/computers/incoming-sandbox.ts", import.meta.url)));
});
