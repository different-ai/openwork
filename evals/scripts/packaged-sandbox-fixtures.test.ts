import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { holdNewOwnedRuntime } from "../worlds/packaged-sandbox-startup-hold.ts";
import { join } from "node:path";
import { bundleIdentity, GUEST_TOOLS, hasOnlyDirectGuestTools, hasStoppedAssistantAnswer, hasVisibleReplyEvidence, stoppedAssistantAnswer, inferenceFixture, isolatedParentEnvironment, offeredToolNames, ownedMicrosandboxProcesses, packagedBundle, rawMessages, redact, sandboxDenFixture, type InferenceRecord } from "../worlds/packaged-sandbox-fixtures.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const request = (overrides: Partial<InferenceRecord> = {}): InferenceRecord => ({ phase: "guest", path: "/v1/messages", requestedModel: "test", offeredTools: GUEST_TOOLS,
  codeModeTools: [], responseModel: "test", status: 200, completed: true, requestContainedHostSecret: false, ...overrides });

describe("native packaged turn completion", () => {
  const answer = (id: string) => ({ id, type: "assistant", finish: "stop", content: [{ type: "text", text: "Darwin; status: draft" }] });
  it("normalizes a native descending cursor page and ignores its newest idle marker", () => {
    const body = { messages: { data: [{ id: "idle", type: "idle", content: [] }, answer("new-answer"), { id: "new-user", type: "user", content: [] }, answer("old-answer")], cursor: null } };
    expect(rawMessages(body).map(message => message.id)).toEqual(["old-answer", "new-user", "new-answer", "idle"]);
    expect(hasStoppedAssistantAnswer(body, new Set(["old-answer"]))).toBe(true);
  });
  it("preserves oldest-first pages without a cursor", () => {
    const body = { messages: { data: [answer("first"), answer("second")] } };
    expect(rawMessages(body).map(message => message.id)).toEqual(["first", "second"]);
  });
  it("uses IDs rather than a count boundary when a 50-message page rolls over", () => {
    const previousIds = new Set(Array.from({ length: 50 }, (_, index) => `old-${index}`));
    const ascending = [...Array.from({ length: 47 }, (_, index) => answer(`old-${index + 3}`)), { id: "new-user", type: "user", content: [] }, answer("new-answer"), { id: "new-idle", type: "idle", content: [] }];
    const body = { messages: { data: ascending.toReversed(), cursor: "previous-page" } };
    expect(rawMessages(body)).toHaveLength(50);
    expect(rawMessages(body).filter(message => typeof message.id === "string" && !previousIds.has(message.id)).map(message => message.id)).toEqual(["new-user", "new-answer", "new-idle"]);
    expect(hasStoppedAssistantAnswer(body, previousIds)).toBe(true);
  });
  it("does not mistake an earlier turn's answer, a user message or idle marker for completion", () => {
    const body = { messages: { data: [{ id: "idle", type: "idle", content: [] }, { id: "user", type: "user", content: [{ type: "text", text: "new request" }] }, answer("old-answer")], cursor: null } };
    expect(hasStoppedAssistantAnswer(body, new Set(["old-answer"]))).toBe(false);
  });
  it("requires a stopped assistant with nonempty text, not a tool-only or unfinished response", () => {
    for (const candidate of [
      { ...answer("new"), finish: "tool-calls" },
      { ...answer("new"), type: "user" },
      { ...answer("new"), content: [] },
      { ...answer("new"), content: [{ type: "text", text: "" }] },
      { ...answer("new"), content: [{ type: "tool", text: "tool output is not a final answer" }] },
    ]) expect(hasStoppedAssistantAnswer({ messages: { data: [candidate] } }, new Set())).toBe(false);
  });
  it("fails loudly when the native message-page contract is missing", () => {
    expect(() => rawMessages({ messages: [] })).toThrow("Native snapshot has no message page");
  });
});

describe("controlled startup slowdown safety", () => {
  const app = "100 1 /owned/OpenWork\n101 100 /owned/server";
  const guest = `${app}\n102 101 /owned/msb machine start new-owned-guest`;
  function processAccess(snapshots: string[]) {
    let snapshotIndex = 0;
    let state = "R";
    const signals: { pid: number; signal: string }[] = [];
    return {
      signals,
      access: {
        snapshot: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)] ?? "",
        state: async () => state,
        signal: (pid: number, signal: "SIGSTOP" | "SIGCONT") => { signals.push({ pid, signal }); state = signal === "SIGSTOP" ? "T" : "R"; },
      },
    };
  }
  it("refuses a startup hold when an owned guest already existed before arming", async () => {
    const process = processAccess([guest]);
    await expect(holdNewOwnedRuntime(100, process.access)).rejects.toThrow("no existing owned guest");
    expect(process.signals).toEqual([]);
  });
  it("holds only the new owned descendant, verifies OS stop and resumes it once", async () => {
    const process = processAccess([app, guest]);
    const hold = await holdNewOwnedRuntime(100, process.access);
    expect(await hold.waitHeld()).toMatchObject({ state: "held", stopVerified: true, target: { pid: 102 } });
    expect(await hold.resume()).toMatchObject({ state: "resumed", resumeVerified: true, readyVerified: false });
    await hold.dispose();
    expect(process.signals).toEqual([{ pid: 102, signal: "SIGSTOP" }, { pid: 102, signal: "SIGCONT" }]);
  });
  it("cleanup releases a held guest even when no explicit resume followed the screenshot", async () => {
    const process = processAccess([app, guest]);
    const hold = await holdNewOwnedRuntime(100, process.access);
    await hold.waitHeld();
    expect(await hold.dispose()).toMatchObject({ state: "resumed", resumeVerified: true });
    expect(process.signals.at(-1)).toEqual({ pid: 102, signal: "SIGCONT" });
  });
  it("a cancelled watcher never sends a signal to a later process", async () => {
    const process = processAccess([app]);
    const hold = await holdNewOwnedRuntime(100, process.access);
    expect(await hold.dispose()).toMatchObject({ state: "cancelled", stopVerified: false });
    expect(process.signals).toEqual([]);
  });
  it("never pauses an unrelated app's guest and exposes the bounded watch failure", async () => {
    const process = processAccess([`${app}\n201 200 /person/msb machine start other-guest`]);
    const hold = await holdNewOwnedRuntime(100, process.access, { watchMs: 25 });
    await expect(hold.waitHeld()).rejects.toThrow("bounded startup-watch deadline");
    await expect(hold.dispose()).rejects.toThrow("cleanup was blocked");
    expect(process.signals).toEqual([]);
  });
  it("refuses ambiguous multiple new owned guests without signalling either", async () => {
    const process = processAccess([app, `${guest}\n103 101 /owned/msb machine start second-owned-guest`]);
    const hold = await holdNewOwnedRuntime(100, process.access);
    await expect(hold.waitHeld()).rejects.toThrow("found 2");
    await expect(hold.dispose()).rejects.toThrow("cleanup was blocked");
    expect(process.signals).toEqual([]);
  });
  it("rechecks exact ancestry and command before sending SIGSTOP", async () => {
    const process = processAccess([app, guest, `${app}\n102 200 /person/msb machine start reused-pid`]);
    const hold = await holdNewOwnedRuntime(100, process.access);
    await expect(hold.waitHeld()).rejects.toThrow("ownership changed");
    await expect(hold.dispose()).rejects.toThrow("cleanup was blocked");
    expect(process.signals).toEqual([]);
  });
  it("rechecks ownership before SIGCONT and reports a reused target instead of signalling it", async () => {
    const process = processAccess([app, guest, guest, `${app}\n102 200 /person/msb machine start reused-pid`]);
    const hold = await holdNewOwnedRuntime(100, process.access);
    await hold.waitHeld();
    await expect(hold.resume()).rejects.toThrow("refusing to signal a reused PID");
    await expect(hold.dispose()).rejects.toThrow("refusing to signal a reused PID");
    expect(process.signals).toEqual([{ pid: 102, signal: "SIGSTOP" }]);
  });
  it("the safety deadline automatically resumes the owned guest and records the intervention", async () => {
    const process = processAccess([app, guest]);
    const hold = await holdNewOwnedRuntime(100, process.access, { maxHoldMs: 20 });
    await hold.waitHeld();
    const deadline = Date.now() + 500;
    while (!hold.receipt.resumeVerified && Date.now() < deadline) await delay(10);
    expect(hold.receipt.resumeVerified).toBe(true);
    expect(hold.receipt.detail).toContain("safety deadline");
    await hold.dispose();
    expect(process.signals.at(-1)).toEqual({ pid: 102, signal: "SIGCONT" });
  });
});

describe("packaged reply screenshot witnesses", () => {
  const visible = { messageId: "current-answer", role: "assistant", matches: [{ text: "Linux", visible: true, rect: { x: 400, y: 300, width: 40, height: 20 } }] };
  it("uses the latest stopped assistant's ID and text, not the user prompt or idle marker", () => {
    expect(stoppedAssistantAnswer({ messages: { data: [
      { id: "earlier-answer", type: "assistant", finish: "stop", content: [{ type: "text", text: "Darwin" }] },
      { id: "current-user", type: "user", content: [{ type: "text", text: "Please quote Linux" }] },
      { id: "current-answer", type: "assistant", finish: "stop", content: [{ type: "text", text: "System:" }, { type: "text", text: "Linux" }] },
      { id: "current-idle", type: "idle", content: [] },
    ] } }, new Set(["earlier-answer"]))).toEqual({ id: "current-answer", text: "System:\nLinux" });
  });
  it("accepts only visible text in the exact current assistant reply", () => {
    expect(hasVisibleReplyEvidence(visible, "current-answer", ["Linux"])).toBe(true);
    expect(hasVisibleReplyEvidence(visible, "earlier-answer", ["Linux"])).toBe(false);
    expect(hasVisibleReplyEvidence({ ...visible, role: "user" }, "current-answer", ["Linux"])).toBe(false);
    expect(hasVisibleReplyEvidence({ ...visible, messageId: null }, "current-answer", ["Linux"])).toBe(false);
  });
  it("rejects absent, clipped or zero-area text even when the reply exists in the DOM", () => {
    expect(hasVisibleReplyEvidence({ ...visible, matches: [{ text: "Linux", visible: false, rect: { x: 400, y: -100, width: 40, height: 20 } }] }, "current-answer", ["Linux"])).toBe(false);
    expect(hasVisibleReplyEvidence({ ...visible, matches: [{ text: "Linux", visible: true, rect: null }] }, "current-answer", ["Linux"])).toBe(false);
    expect(hasVisibleReplyEvidence({ ...visible, matches: [{ text: "Linux", visible: true, rect: { x: 400, y: 300, width: 0, height: 20 } }] }, "current-answer", ["Linux"])).toBe(false);
  });
  it("requires every requested evidence string and never accepts an empty witness", () => {
    expect(hasVisibleReplyEvidence(visible, "current-answer", ["Linux", "host-later-nonce"])).toBe(false);
    expect(hasVisibleReplyEvidence(visible, "current-answer", [])).toBe(false);
    expect(hasVisibleReplyEvidence(visible, "current-answer", [""])).toBe(false);
  });
});

describe("packaged sandbox proof prerequisites", () => {
  it("targets only native guest descendants of the exact app the proof owns", () => {
    const snapshot = [
      "100 1 /owned/OpenWork", "101 100 /owned/server", "102 101 /owned/msb machine start owned-guest",
      "200 1 /person/OpenWork", "201 200 /person/msb machine start person-guest",
      "300 1 /owned/msb machine start unrelated-root", "103 101 /owned/msb version",
      "400 401 /owned/msb machine start cycle", "401 400 /owned/server",
    ].join("\n");
    expect(ownedMicrosandboxProcesses(snapshot, 100)).toEqual([{ pid: 102, ppid: 101, command: "/owned/msb machine start owned-guest" }]);
    expect(ownedMicrosandboxProcesses(snapshot, 999)).toEqual([]);
    expect(() => ownedMicrosandboxProcesses(snapshot, 1)).toThrow("owned packaged app PID");
    expect(() => ownedMicrosandboxProcesses(snapshot, Number.NaN)).toThrow("owned packaged app PID");
  });
  it("never inherits a member's history, config, provider credentials or source overrides", () => {
    const env = isolatedParentEnvironment({ PATH: "/bin", TMPDIR: "/owned/tmp", OPENCODE_DB: "/member/history.db", OPENCODE_TEST_HOME: "/member", HOME: "/member", XDG_DATA_HOME: "/member/data", MSB_HOME: "/member/vm", OPENWORK_SERVER_CONFIG: "/member/server.json", OPENWORK_ELECTRON_START_URL: "http://source", ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret2", INFISICAL_TOKEN: "secret3", NODE_OPTIONS: "--import source.ts", NODE_PATH: "/checkout/node_modules", ELECTRON_RUN_AS_NODE: "1" });
    expect(env).toEqual({ PATH: "/bin", TMPDIR: "/owned/tmp" });
  });
  it("captures both supported real API tool declaration shapes", () => {
    expect(offeredToolNames({ tools: [{ name: "write" }, { type: "function", function: { name: "read" } }] })).toEqual(["read", "write"]);
  });
  it("requires all six DIRECT tools on EVERY inference request, never execute or a subset", () => {
    expect(hasOnlyDirectGuestTools([])).toBe(false);
    expect(hasOnlyDirectGuestTools([request()])).toBe(true);
    expect(hasOnlyDirectGuestTools([request(), request({ offeredTools: ["execute"], codeModeTools: GUEST_TOOLS })])).toBe(false);
    expect(hasOnlyDirectGuestTools([request({ offeredTools: ["read", "shell"] })])).toBe(false);
    expect(hasOnlyDirectGuestTools([request({ offeredTools: [...GUEST_TOOLS, "browser_open"] })])).toBe(false);
    expect(hasOnlyDirectGuestTools([request({ codeModeTools: ["shell"] })])).toBe(false);
  });
  it("refuses /Applications and a source Electron executable before reading files", async () => {
    await expect(packagedBundle("/Applications/OpenWork.app/Contents/MacOS/OpenWork")).rejects.toThrow("outside /Applications");
    await expect(packagedBundle("node_modules/electron/dist/electron")).rejects.toThrow("branch-built .app");
  });
  it("verifies app.asar really includes the embedded server and staged sandbox runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "packaged-sandbox-fixture-")); roots.push(root);
    const bundle = join(root, "Branch.app");
    const resources = join(bundle, "Contents/Resources");
    const binary = join(bundle, "Contents/MacOS/Branch");
    await Promise.all([mkdir(join(bundle, "Contents/MacOS"), { recursive: true }), mkdir(join(resources, "app-dist"), { recursive: true }), mkdir(join(resources, "opencode-plugins"), { recursive: true })]);
    await writeFile(binary, "fixture");
    await writeFile(join(resources, "opencode-plugins/openwork-sandbox-v2.js"), "fixture");
    const header = Buffer.from(JSON.stringify({ files: {
      server: { files: { dist: { files: { "embedded.js": { size: 0 } } } } },
      node_modules: { files: { "@superradcompany": { files: { microsandbox: { files: { "package.json": { size: 0 } } } } } } },
    } }));
    const prefix = Buffer.alloc(16); prefix.writeUInt32LE(header.length, 12);
    await writeFile(join(resources, "app.asar"), Buffer.concat([prefix, header]));
    const result = await packagedBundle(binary);
    expect(result.embeddedServer).toBe("app.asar/server/dist/embedded.js");
    expect(result.identity.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.binarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.asarSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.stagedRuntime).toContain("node_modules/@superradcompany/microsandbox/package.json");
  });
  it("identifies actual unpacked runtime bytes, not just the ASAR or checkout commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "packaged-bundle-identity-")); roots.push(root);
    const unpacked = join(root, "Contents/Resources/app.asar.unpacked");
    await mkdir(unpacked, { recursive: true });
    await writeFile(join(unpacked, "msb"), "first-native-binary");
    const first = await bundleIdentity(root);
    expect((await bundleIdentity(root)).sha256).toBe(first.sha256);
    await writeFile(join(unpacked, "msb"), "other-native-binary");
    expect((await bundleIdentity(root)).sha256).not.toBe(first.sha256);
  });
  it("refuses runtime symlinks that could execute something outside the supplied bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "packaged-bundle-symlink-")); roots.push(root);
    await symlink("/bin/sh", join(root, "escaped-runtime"));
    await expect(bundleIdentity(root)).rejects.toThrow("symlink escapes the artifact");
  });
  it("keeps a disposable Den rollout fixture separate from any production organization", async () => {
    const den = await sandboxDenFixture();
    try {
      const response = await fetch(`${den.url}/v1/features`);
      expect(await response.json()).toEqual({ features: { sandboxTools: true } });
      expect(den.reads).toEqual(["/v1/features"]);
      expect((await fetch(`${den.url}/v1/org`)).status).toBe(404);
    } finally { await den.close(); }
  });
  it("uses the supported low-effort Sol variant for chat and background title requests", async () => {
    const original = globalThis.fetch;
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith("https://api.openai.com/")) throw new Error("Unexpected upstream in fixture");
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ model: "gpt-6.1-sol", service_tier: "fast", output: [] });
    });
    const proxy = await inferenceFixture("sol", "fixture-key", { phase: "title", hostSecret: "host-witness" });
    try {
      const response = await original(`${proxy.url}/responses`, { method: "POST", headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-6.1-sol", reasoning: { effort: "none" }, input: "Synthetic title", tools: [] }) });
      expect(response.status).toBe(200);
      await response.text();
      expect(bodies).toEqual([{ model: "gpt-6.1-sol", reasoning: { effort: "low" }, service_tier: "priority", input: "Synthetic title", tools: [] }]);
      expect(proxy.records[0]).toMatchObject({ status: 200, completed: true, tuning: "reasoning.effort=low; service_tier=priority" });
    } finally { await proxy.close(); vi.unstubAllGlobals(); }
  });
  it("redacts upstream and loopback credentials from exported evidence", () => {
    expect(redact("upstream-key scoped-token upstream-key", ["upstream-key", "scoped-token"])).toBe("[redacted] [redacted] [redacted]");
  });
});
