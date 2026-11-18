import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleIdentity, GUEST_TOOLS, hasOnlyDirectGuestTools, hasStoppedAssistantAnswer, inferenceFixture, isolatedParentEnvironment, offeredToolNames, packagedBundle, rawMessages, redact, sandboxDenFixture, type InferenceRecord } from "../worlds/packaged-sandbox-fixtures.ts";

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

describe("packaged sandbox proof prerequisites", () => {
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
