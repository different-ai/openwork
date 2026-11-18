import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleIdentity, GUEST_TOOLS, hasOnlyDirectGuestTools, isolatedParentEnvironment, offeredToolNames, packagedBundle, redact, sandboxDenFixture, type InferenceRecord } from "../worlds/packaged-sandbox-fixtures.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const request = (overrides: Partial<InferenceRecord> = {}): InferenceRecord => ({ phase: "guest", path: "/v1/messages", requestedModel: "test", offeredTools: GUEST_TOOLS,
  codeModeTools: [], responseModel: "test", status: 200, completed: true, requestContainedHostSecret: false, ...overrides });

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
      expect(await response.json()).toEqual({ sandboxTools: true });
      expect(den.reads).toEqual(["/v1/features"]);
      expect((await fetch(`${den.url}/v1/org`)).status).toBe(404);
    } finally { await den.close(); }
  });
  it("redacts upstream and loopback credentials from exported evidence", () => {
    expect(redact("upstream-key scoped-token upstream-key", ["upstream-key", "scoped-token"])).toBe("[redacted] [redacted] [redacted]");
  });
});
