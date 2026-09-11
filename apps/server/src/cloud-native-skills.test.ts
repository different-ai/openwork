import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CloudNativeSkillSyncError,
  cloudNativeSkillId,
  cloudNativeSkillScopeKey,
  createCloudNativeSkillSync,
} from "./cloud-native-skills.js";
import type { McpFetch } from "./connect-mcp-transport.js";
import { renderOpencodeV2Config } from "./managed-opencode-v2.js";

const INDEX_URI = "skill://index.json";
const BRIEFING_URI = "skill://customer-briefing/SKILL.md";
const TRIAGE_URI = "skill://support-triage/SKILL.md";
const BRIEFING_BODY = "---\nname: customer-briefing\ndescription: Prepare a briefing\n---\n\n# Briefing\n\nDo the briefing.\n";
const TRIAGE_BODY = "---\nname: support-triage\ndescription: Triage support\n---\n\nTriage steps.\n";

function indexFor(uris: string[]): unknown {
  return {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: uris.map((url) => ({ name: url.split("/")[2], type: "skill-md", description: "d", url, capability: "skill:x" })),
  };
}

function cloudConfig(token: string): Record<string, unknown> {
  return { type: "remote", url: "https://api.example.test/mcp/agent", headers: { Authorization: `Bearer ${token}` } };
}

function fakeCloud(options: {
  index: unknown;
  bodies: Record<string, string | undefined>;
  gate?: () => Promise<void>;
}): { fetcher: McpFetch; reads: string[] } {
  const reads: string[] = [];
  const json = (payload: unknown) => new Response(JSON.stringify(payload), {
    status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
  });
  const fetcher: McpFetch = async (_url, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    if (typeof body !== "object" || body === null) throw new Error("bad request");
    const request = body as { id?: number; method: string; params?: { uri?: string } };
    if (request.method === "initialize") {
      return json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
    }
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method === "resources/read") {
      const uri = request.params?.uri ?? "";
      reads.push(uri);
      await options.gate?.();
      const text = uri === INDEX_URI
        ? (typeof options.index === "string" ? options.index : JSON.stringify(options.index))
        : options.bodies[uri];
      if (text === undefined) return json({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Skill is no longer available" } });
      return json({ jsonrpc: "2.0", id: request.id, result: { contents: [{ uri, mimeType: "text/markdown", text }] } });
    }
    throw new Error(`unexpected method ${request.method}`);
  };
  return { fetcher, reads };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "openwork-cloud-skills-"));
  try { await run(join(base, "cloud-skills")); } finally { await rm(base, { recursive: true, force: true }); }
}

test("skill ids and scope keys are stable, opaque hashes", () => {
  expect(cloudNativeSkillId(BRIEFING_URI)).toBe(`openwork-cloud-${createHash("sha256").update(BRIEFING_URI).digest("hex").slice(0, 16)}`);
  expect(cloudNativeSkillId(BRIEFING_URI)).toMatch(/^openwork-cloud-[0-9a-f]{16}$/);
  const scope = cloudNativeSkillScopeKey(cloudConfig("secret-token"));
  expect(scope).toMatch(/^[0-9a-f]{16}$/);
  expect(scope).not.toContain("secret");
  expect(cloudNativeSkillScopeKey(cloudConfig("other-token"))).not.toBe(scope);
  expect(cloudNativeSkillScopeKey(null)).toBeNull();
  expect(cloudNativeSkillScopeKey({ url: "https://api.example.test/mcp" })).toBeNull();
  expect(cloudNativeSkillScopeKey({ ...cloudConfig("t"), enabled: false })).toBeNull();
});

test("fresh fetch materializes every body verbatim under the scope root and registers only that root", async () => {
  await withRoot(async (root) => {
    const cloud = fakeCloud({ index: indexFor([BRIEFING_URI, TRIAGE_URI]), bodies: { [BRIEFING_URI]: BRIEFING_BODY, [TRIAGE_URI]: TRIAGE_BODY } });
    const registered: Array<string | null> = [];
    const sync = createCloudNativeSkillSync({
      root, fetcher: cloud.fetcher,
      readCloudConfig: async () => cloudConfig("token-a"),
      register: async (directory) => { registered.push(directory); },
    });
    const state = await sync.sync();
    const scope = cloudNativeSkillScopeKey(cloudConfig("token-a"));
    expect(state.root).toBe(join(root, String(scope)));
    expect(state.skills.map((skill) => skill.id)).toEqual([cloudNativeSkillId(BRIEFING_URI), cloudNativeSkillId(TRIAGE_URI)].sort());
    for (const skill of state.skills) {
      expect(skill.location).toBe(join(root, String(scope), skill.id, "SKILL.md"));
      expect(await readFile(skill.location, "utf8")).toBe(skill.uri === BRIEFING_URI ? BRIEFING_BODY : TRIAGE_BODY);
      expect((await stat(skill.location)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, String(scope), skill.id))).mode & 0o777).toBe(0o700);
    }
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect(registered).toEqual([join(root, String(scope))]);
    expect(cloud.reads.filter((uri) => uri === INDEX_URI)).toHaveLength(1);

    // No cache: the next admission reads the index and every body again, and
    // an unchanged set does not rewrite the native registration.
    await sync.sync();
    expect(cloud.reads.filter((uri) => uri === INDEX_URI)).toHaveLength(2);
    expect(cloud.reads.filter((uri) => uri === BRIEFING_URI)).toHaveLength(2);
    expect(registered).toHaveLength(1);
    expect((await readdir(root)).sort()).toEqual([String(scope)]);
  });
});

test("body updates and removals keep ids stable and drop obsolete directories", async () => {
  await withRoot(async (root) => {
    const bodies: Record<string, string | undefined> = { [BRIEFING_URI]: BRIEFING_BODY, [TRIAGE_URI]: TRIAGE_BODY };
    const catalog = { index: indexFor([BRIEFING_URI, TRIAGE_URI]), bodies };
    const cloud = fakeCloud(catalog);
    const sync = createCloudNativeSkillSync({ root, fetcher: cloud.fetcher, readCloudConfig: async () => cloudConfig("t"), register: async () => {} });
    const first = await sync.sync();
    bodies[BRIEFING_URI] = `${BRIEFING_BODY}\nUpdated.\n`;
    catalog.index = indexFor([BRIEFING_URI]);
    const second = await sync.sync();
    expect(second.skills.map((skill) => skill.id)).toEqual([cloudNativeSkillId(BRIEFING_URI)]);
    const firstBriefingId = first.skills.find((skill) => skill.uri === BRIEFING_URI)?.id ?? "";
    expect(second.skills[0]?.id).toBe(firstBriefingId);
    expect(await readFile(second.skills[0]?.location ?? "", "utf8")).toBe(`${BRIEFING_BODY}\nUpdated.\n`);
    expect(await readdir(String(second.root))).toEqual([cloudNativeSkillId(BRIEFING_URI)]);
  });
});

test("fails closed without Cloud auth: empty desired set, root cleared, no fetch", async () => {
  await withRoot(async (root) => {
    const cloud = fakeCloud({ index: indexFor([BRIEFING_URI]), bodies: { [BRIEFING_URI]: BRIEFING_BODY } });
    let config: Record<string, unknown> | null = cloudConfig("t");
    const registered: Array<string | null> = [];
    const sync = createCloudNativeSkillSync({ root, fetcher: cloud.fetcher, readCloudConfig: async () => config, register: async (directory) => { registered.push(directory); } });
    await sync.sync();
    expect(await stat(root).then(() => true)).toBe(true);
    config = null;
    const state = await sync.sync();
    expect(state).toEqual({ root: null, skills: [] });
    expect(registered.at(-1)).toBeNull();
    expect(await stat(root).then(() => true, () => false)).toBe(false);
    expect(cloud.reads.filter((uri) => uri === INDEX_URI)).toHaveLength(1);
  });
});

test("fails closed on malformed index, rejected session, and partial body reads", async () => {
  await withRoot(async (root) => {
    const registered: Array<string | null> = [];
    let fetcher: McpFetch = fakeCloud({ index: indexFor([BRIEFING_URI]), bodies: { [BRIEFING_URI]: BRIEFING_BODY } }).fetcher;
    const sync = createCloudNativeSkillSync({
      root, fetcher: (url, init) => fetcher(url, init), readCloudConfig: async () => cloudConfig("t"),
      register: async (directory) => { registered.push(directory); },
    });
    const code = async () => {
      const error: unknown = await sync.sync().catch((caught: unknown) => caught);
      return error instanceof CloudNativeSkillSyncError ? error.code : error;
    };
    await sync.sync();
    expect(registered.at(-1)).not.toBeNull();

    fetcher = fakeCloud({ index: "{not json", bodies: {} }).fetcher;
    expect(await code()).toBe("cloud_skill_index_malformed");
    expect(await stat(root).then(() => true, () => false)).toBe(false);
    expect(registered.at(-1)).toBeNull();
    expect(sync.current()).toEqual({ root: null, skills: [] });

    fetcher = fakeCloud({ index: { skills: [{ name: "x", type: "skill-md", url: "https://not-a-skill" }] }, bodies: {} }).fetcher;
    expect(await code()).toBe("cloud_skill_index_malformed");

    fetcher = fakeCloud({ index: indexFor([BRIEFING_URI]), bodies: { [BRIEFING_URI]: BRIEFING_BODY } }).fetcher;
    await sync.sync();
    expect(registered.at(-1)).not.toBeNull();
    fetcher = fakeCloud({ index: indexFor([BRIEFING_URI, TRIAGE_URI]), bodies: { [BRIEFING_URI]: BRIEFING_BODY } }).fetcher;
    expect(await code()).toBe("cloud_skill_body_unavailable");
    expect(registered.at(-1)).toBeNull();
    expect(await stat(root).then(() => true, () => false)).toBe(false);

    fetcher = async () => new Response("unauthorized", { status: 401 });
    expect(await code()).toBe("cloud_skill_session_failed");
  });
});

test("switching scope removes the previous root and registers the new one", async () => {
  await withRoot(async (root) => {
    const cloud = fakeCloud({ index: indexFor([BRIEFING_URI]), bodies: { [BRIEFING_URI]: BRIEFING_BODY } });
    let config = cloudConfig("token-a");
    const registered: Array<string | null> = [];
    const sync = createCloudNativeSkillSync({ root, fetcher: cloud.fetcher, readCloudConfig: async () => config, register: async (directory) => { registered.push(directory); } });
    const first = await sync.sync();
    config = cloudConfig("token-b");
    // The global config write path notices the scope change before the next prompt.
    await sync.reconcileScope();
    expect(registered.at(-1)).toBeNull();
    expect(await stat(root).then(() => true, () => false)).toBe(false);
    const second = await sync.sync();
    expect(second.root).not.toBe(first.root);
    expect((await readdir(root)).sort()).toEqual([String(cloudNativeSkillScopeKey(config))]);
    expect(registered.at(-1)).toBe(second.root);
    // Unchanged scope is not an invalidation.
    await sync.reconcileScope();
    expect(registered.at(-1)).toBe(second.root);
    expect(await stat(String(second.root)).then(() => true, () => false)).toBe(true);
  });
});

test("a config change during an in-flight sync discards that generation", async () => {
  await withRoot(async (root) => {
    let release: (() => void) | undefined;
    let gateArmed = true;
    const cloud = fakeCloud({
      index: indexFor([BRIEFING_URI]), bodies: { [BRIEFING_URI]: BRIEFING_BODY },
      gate: () => gateArmed ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve(),
    });
    let config: Record<string, unknown> | null = cloudConfig("token-a");
    const registered: Array<string | null> = [];
    const sync = createCloudNativeSkillSync({ root, fetcher: cloud.fetcher, readCloudConfig: async () => config, register: async (directory) => { registered.push(directory); } });
    const pending = sync.sync();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    // Sign-out lands while the index read is in flight.
    config = null;
    const generation = sync.generation();
    const reconcile = sync.reconcileScope();
    while (sync.generation() === generation) await new Promise((resolve) => setTimeout(resolve, 5));
    gateArmed = false;
    release();
    const state = await pending;
    await reconcile;
    expect(state).toEqual({ root: null, skills: [] });
    expect(registered.every((directory) => directory === null)).toBe(true);
    expect(await stat(root).then(() => true, () => false)).toBe(false);
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
