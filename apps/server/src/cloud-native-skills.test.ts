import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudNativeSkillSyncError, cloudNativeSkillId, cloudNativeSkillScopeKey, createCloudNativeSkillSync } from "./cloud-native-skills.js";
import { isRecord, type McpFetch } from "./connect-mcp-transport.js";
import { renderOpencodeV2Config } from "./managed-opencode-v2.js";

const INDEX_URI = "skill://index.json";
const BRIEFING_URI = "skill://briefing/SKILL.md";
const TRIAGE_URI = "skill://support-triage/SKILL.md";
const BRIEFING_BODY = "---\nname: briefing\ndescription: Prepare a briefing\n---\n\nDo the briefing.\n";
const TRIAGE_BODY = "---\nname: support-triage\ndescription: Triage support\n---\nTriage steps.\n";
const indexFor = (uris: string[]) => ({ skills: uris.map((url) => ({ name: url.split("/")[2], type: "skill-md", url })) });
const cloudConfig = (token: string): Record<string, unknown> => ({ type: "remote", url: "https://api.example.test/mcp/agent", headers: { Authorization: `Bearer ${token}` } });

function fakeCloud(options: { index: unknown; bodies: Record<string, string | undefined>; gate?: () => Promise<void> }): { fetcher: McpFetch; reads: string[] } {
  const reads: string[] = [];
  let session = 0;
  let initialized = false;
  const fetcher: McpFetch = async (_url, init) => {
    const request: unknown = JSON.parse(String(init?.body));
    if (!isRecord(request)) throw new Error("bad request");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toMatch(/^Bearer /);
    const json = (value: Record<string, unknown>) => Response.json({ jsonrpc: "2.0", id: request.id, ...value }, { headers: { "mcp-session-id": `session-${session}` } });
    if (request.method === "initialize") {
      session++; initialized = false;
      return json({ result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
    }
    expect(headers.get("mcp-session-id")).toBe(`session-${session}`);
    expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
    if (request.method === "notifications/initialized") { initialized = true; return new Response(null, { status: 202 }); }
    expect(initialized).toBe(true);
    if (request.method === "resources/read") {
      const uri = isRecord(request.params) ? String(request.params.uri) : "";
      reads.push(uri);
      await options.gate?.();
      const text = uri === INDEX_URI ? typeof options.index === "string" ? options.index : JSON.stringify(options.index) : options.bodies[uri];
      return text === undefined ? json({ error: { code: -32602, message: "Unavailable" } })
        : json({ result: { contents: [{ uri, mimeType: "text/markdown", text }] } });
    }
    throw new Error("No skill tools may be called");
  };
  return { fetcher, reads };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "openwork-cloud-skills-"));
  try { await run(join(base, "cloud-skills")); } finally { await rm(base, { recursive: true, force: true }); }
}
const exists = (path: string) => stat(path).then(() => true, () => false);

test("skill IDs and authorization scopes are stable opaque hashes", () => {
  expect(cloudNativeSkillId(BRIEFING_URI)).toBe(`openwork-cloud-${createHash("sha256").update(BRIEFING_URI).digest("hex").slice(0, 16)}`);
  const scope = cloudNativeSkillScopeKey(cloudConfig("fixture-secret"));
  expect(scope).toMatch(/^[0-9a-f]{64}$/);
  expect(scope).not.toContain("fixture-secret");
  expect(cloudNativeSkillScopeKey(cloudConfig("other"))).not.toBe(scope);
  for (const config of [null, { url: "https://example.test/mcp" }, { ...cloudConfig("t"), enabled: false }, { ...cloudConfig("t"), disabled: true }]) expect(cloudNativeSkillScopeKey(config)).toBeNull();
});

test("a plain turn can recheck the same empty signed-in skill scope without repeated invalidation", async () => {
  await withRoot(async (root) => {
    const cloud = fakeCloud({ index: indexFor([BRIEFING_URI]), bodies: { [BRIEFING_URI]: BRIEFING_BODY } });
    const registrations: Array<string | null> = [];
    let config = cloudConfig("a");
    const sync = createCloudNativeSkillSync({ root, fetcher: cloud.fetcher,
      readCloudConfig: async () => config, register: async (directory) => { registrations.push(directory); } });
    await sync.reconcileScope();
    const generation = sync.generation();
    await sync.reconcileScope();
    expect(sync.generation()).toBe(generation);
    expect(sync.current().root).toBeNull();
    expect(cloud.reads).toEqual([]);
    const loaded = await sync.sync();
    expect(loaded.skills).toHaveLength(1);
    config = cloudConfig("b");
    await sync.reconcileScope();
    expect(sync.current().root).toBeNull();
    expect(registrations.at(-1)).toBeNull();
  });
});

test("fresh same-session bodies are private, update with stable IDs and remove revoked files", async () => {
  await withRoot(async (root) => {
    const bodies: Record<string, string> = { [BRIEFING_URI]: BRIEFING_BODY, [TRIAGE_URI]: TRIAGE_BODY };
    const catalog = { index: indexFor([BRIEFING_URI, TRIAGE_URI]), bodies };
    const cloud = fakeCloud(catalog);
    const registered: Array<string | null> = [];
    const sync = createCloudNativeSkillSync({ root, fetcher: cloud.fetcher, readCloudConfig: async () => cloudConfig("a"), register: async (dir) => { registered.push(dir); } });
    const first = await sync.sync();
    expect(first.root).toBe(join(root, String(cloudNativeSkillScopeKey(cloudConfig("a")))));
    for (const skill of first.skills) {
      expect(skill.scope).toBe(String(cloudNativeSkillScopeKey(cloudConfig("a"))));
      expect(await readFile(skill.location, "utf8")).toBe(catalog.bodies[skill.uri]);
      expect((await stat(skill.location)).mode & 0o777).toBe(0o600);
      expect((await stat(join(skill.location, ".."))).mode & 0o777).toBe(0o700);
    }
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    await sync.sync();
    expect(cloud.reads.filter((uri) => uri === INDEX_URI)).toHaveLength(2);
    expect(cloud.reads.filter((uri) => uri === BRIEFING_URI)).toHaveLength(2);
    expect(registered).toEqual([first.root]);
    catalog.bodies[BRIEFING_URI] += "Updated body only.\n";
    catalog.index = indexFor([BRIEFING_URI]);
    const second = await sync.sync();
    expect(second.skills.map((skill) => skill.id)).toEqual([cloudNativeSkillId(BRIEFING_URI)]);
    expect(await readFile(second.skills[0]!.location, "utf8")).toBe(catalog.bodies[BRIEFING_URI]);
    expect(await readdir(String(second.root))).toEqual([cloudNativeSkillId(BRIEFING_URI)]);
    expect(await readdir(root)).toEqual([String(cloudNativeSkillScopeKey(cloudConfig("a")))]);
  });
});

test("malformed/partial reads, auth rejection and transport failure clear old skills without leaking errors", async () => {
  await withRoot(async (root) => {
    const good = fakeCloud({ index: indexFor([BRIEFING_URI]), bodies: { [BRIEFING_URI]: BRIEFING_BODY } }).fetcher;
    let fetcher = good;
    const registered: Array<string | null> = [];
    const sync = createCloudNativeSkillSync({ root, fetcher: (url, init) => fetcher(url, init), readCloudConfig: async () => cloudConfig("t"), register: async (dir) => { registered.push(dir); } });
    const bad: Array<[McpFetch, string]> = [
      [fakeCloud({ index: "{not json", bodies: {} }).fetcher, "cloud_skill_index_malformed"],
      [fakeCloud({ index: { skills: [{ name: "x", type: "skill-md", url: "https://wrong" }] }, bodies: {} }).fetcher, "cloud_skill_index_malformed"],
      [fakeCloud({ index: indexFor([BRIEFING_URI, TRIAGE_URI]), bodies: { [BRIEFING_URI]: BRIEFING_BODY } }).fetcher, "cloud_skill_body_unavailable"],
      [async () => new Response(null, { status: 401 }), "cloud_skill_session_failed"],
      [async () => { throw new Error("fixture-credential-must-not-escape"); }, "cloud_skill_session_failed"],
      [async () => { throw new DOMException("Timed out", "TimeoutError"); }, "cloud_skill_session_failed"],
    ];
    for (const [failure, code] of bad) {
      fetcher = good; await sync.sync(); fetcher = failure;
      const error: unknown = await sync.sync().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(CloudNativeSkillSyncError);
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain("fixture-credential");
      expect(await exists(root)).toBe(false);
      expect(registered.at(-1)).toBeNull();
      expect(sync.current()).toEqual({ root: null, skills: [] });
    }
  });
});

test("transport recovery does not hide a failed native unregistration", async () => {
  await withRoot(async (root) => {
    const cleanupError = new Error("Native unregistration failed");
    let fetcher: McpFetch = fakeCloud({ index: indexFor([BRIEFING_URI]), bodies: { [BRIEFING_URI]: BRIEFING_BODY } }).fetcher;
    const sync = createCloudNativeSkillSync({
      root, fetcher: (url, init) => fetcher(url, init), readCloudConfig: async () => cloudConfig("t"),
      register: async (directory) => { if (directory === null) throw cleanupError; },
    });
    await sync.sync();
    fetcher = async () => { throw new TypeError("fetch failed"); };
    await expect(sync.sync()).rejects.toBe(cleanupError);
    expect(await exists(root)).toBe(false);
  });
});

test("scope rotation/sign-out clears previous files and stops endpoint contact", async () => {
  await withRoot(async (root) => {
    const cloud = fakeCloud({ index: indexFor([BRIEFING_URI]), bodies: { [BRIEFING_URI]: BRIEFING_BODY } });
    let config: Record<string, unknown> | null = cloudConfig("a");
    const registered: Array<string | null> = [];
    const sync = createCloudNativeSkillSync({ root, fetcher: cloud.fetcher, readCloudConfig: async () => config, register: async (dir) => { registered.push(dir); } });
    const first = await sync.sync();
    config = cloudConfig("b"); await sync.reconcileScope();
    expect(await exists(root)).toBe(false);
    expect(registered.at(-1)).toBeNull();
    const second = await sync.sync();
    expect(second.root).not.toBe(first.root);
    await sync.reconcileScope();
    expect(await exists(String(second.root))).toBe(true);
    config = null;
    const before = cloud.reads.length;
    expect(await sync.sync()).toEqual({ root: null, skills: [] });
    expect(cloud.reads).toHaveLength(before);
    expect(await exists(root)).toBe(false);
  });
});

test("sign-out during an in-flight resource read discards that generation", async () => {
  await withRoot(async (root) => {
    let release: (() => void) | undefined;
    let armed = true;
    const cloud = fakeCloud({ index: indexFor([BRIEFING_URI]), bodies: { [BRIEFING_URI]: BRIEFING_BODY }, gate: () => armed ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve() });
    let config: Record<string, unknown> | null = cloudConfig("a");
    const registered: Array<string | null> = [];
    const sync = createCloudNativeSkillSync({ root, fetcher: cloud.fetcher, readCloudConfig: async () => config, register: async (dir) => { registered.push(dir); } });
    const pending = sync.sync();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    config = null;
    const generation = sync.generation();
    const reconcile = sync.reconcileScope();
    while (sync.generation() === generation) await new Promise((resolve) => setTimeout(resolve, 5));
    armed = false; release();
    expect(await pending).toEqual({ root: null, skills: [] });
    await reconcile;
    expect(registered.every((dir) => dir === null)).toBe(true);
    expect(await exists(root)).toBe(false);
  });
});

test("the generated engine config keeps skill directories across provider rewrites", () => {
  const skills = ["/state/cloud-skills/abcd"];
  const first = renderOpencodeV2Config({ providers: [], skills });
  expect(first.skills).toEqual(skills);
  const second = renderOpencodeV2Config({
    providers: [{ id: "p", name: "P", baseUrl: "https://p.test/v1", apiKey: "k", models: [{ id: "m", name: "M" }] }],
    permissions: [],
    skills,
  });
  expect(second.skills).toEqual(skills);
  expect(Object.keys(second.providers ?? {})).toEqual(["p"]);
  expect(renderOpencodeV2Config({ providers: [], skills: [] })).not.toHaveProperty("skills");
});
