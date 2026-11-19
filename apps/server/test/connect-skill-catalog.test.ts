import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readOpenWorkConnectSkillContent,
  readOpenWorkConnectSkillContents,
  readOpenWorkConnectSkillIndex,
  resetOpenWorkConnectSkillCatalogCacheForTests,
} from "../src/connect-skill-catalog.js";
import { writeConnectCloudMcp } from "../src/connect-state.js";
import type { ServerConfig } from "../src/types.js";

const digest = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const crmBody = "---\nname: crm-sync\ndescription: \"Sync the CRM.\"\n---\n\nUpdate Notion.";
const crmUrl = "skill://crm-sync/SKILL.md";
const tamperedUrl = "skill://tampered/SKILL.md";

/** A minimal openwork-cloud MCP that serves one index and counts SKILL.md reads. */
function fakeDen(index: { skills: Array<Record<string, unknown>> }) {
  const reads: string[] = [];
  const fetcher = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const uri: string = body.params.uri;
    const text = uri === "skill://index.json"
      ? JSON.stringify({ $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", delivery: "native", ...index })
      : (reads.push(uri), uri === crmUrl ? crmBody : "not the published body");
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { contents: [{ uri, text }] } });
  };
  return { reads, fetcher };
}

const SYNC = "io.openwork/skills";
const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const etagOf = (entry: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(entry)).digest("hex").slice(0, 32);

/** An openwork-cloud MCP that understands the sync fields, as Den does, and records every request. */
function syncDen(state: { revision: string; skills: Array<Record<string, unknown>>; bodies: Record<string, string> }) {
  const requests: Array<{ method: string; uri?: string; sync?: Record<string, unknown> }> = [];
  const fetcher = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const sync = body.params?._meta?.[SYNC];
    requests.push({ method: body.method, uri: body.params?.uri, sync });
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const uri: string = body.params.uri;
    if (uri === "skill://index.json") {
      const known: Record<string, string> = sync?.known ?? {};
      const text = sync?.revision === state.revision
        ? { $schema: SCHEMA, revision: state.revision, sync: "unchanged" }
        : {
          $schema: SCHEMA, delivery: "native", revision: state.revision, sync: "changes",
          skills: state.skills.filter(entry => known[String(entry.url)] !== etagOf(entry)).map(entry => ({ ...entry, etag: etagOf(entry) })),
          removed: Object.keys(known).filter(url => !state.skills.some(entry => entry.url === url)),
        };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { contents: [{ uri, text: JSON.stringify(text) }] } });
    }
    const uris: string[] = sync?.uris ?? [uri];
    return Response.json({ jsonrpc: "2.0", id: body.id, result: {
      contents: uris.filter(entry => state.bodies[entry] !== undefined).map(entry => ({ uri: entry, text: state.bodies[entry] })),
      ...(sync ? { _meta: { [SYNC]: { batch: true } } } : {}),
    } });
  };
  const count = (method: string, uri?: string) => requests.filter(entry => entry.method === method && (uri === undefined || entry.uri === uri)).length;
  return { requests, fetcher, count };
}

function skill(name: string, url: string, body: string) {
  return { name, type: "skill-md", description: name, url, capability: `skill:${name}`, digest: digest(body) };
}

describe("readOpenWorkConnectSkillContent", () => {
  let dir: string;
  let config: ServerConfig;
  const previousDb = process.env.OPENWORK_RUNTIME_DB;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "openwork-skill-catalog-"));
    process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
    config = {
      host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
      startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    };
    await writeConnectCloudMcp(config, { type: "remote", url: "https://den.test/mcp/agent" });
    resetOpenWorkConnectSkillCatalogCacheForTests();
  });

  afterEach(() => {
    resetOpenWorkConnectSkillCatalogCacheForTests();
    if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousDb;
    rmSync(dir, { recursive: true, force: true });
  });

  test("every body it serves comes from a read Den authorized", async () => {
    const den = fakeDen({ skills: [skill("crm-sync", crmUrl, crmBody)] });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await readOpenWorkConnectSkillContent(config, crmUrl, den.fetcher)).toBe(crmBody);
    }
    expect(den.reads).toEqual([crmUrl, crmUrl, crmUrl]);
  });

  test("does not re-read a body that failed its digest on every refresh", async () => {
    const den = fakeDen({ skills: [skill("tampered", tamperedUrl, "the published body")] });
    expect(await readOpenWorkConnectSkillContent(config, tamperedUrl, den.fetcher)).toBe("not the published body");
    expect(await readOpenWorkConnectSkillContent(config, tamperedUrl, den.fetcher)).toBeNull();
    expect(den.reads).toEqual([tamperedUrl]);
    // After ten minutes it is read again.
    setSystemTime(new Date(Date.now() + 10 * 60_000 + 1_000));
    try {
      await readOpenWorkConnectSkillContent(config, tamperedUrl, den.fetcher);
      expect(den.reads).toEqual([tamperedUrl, tamperedUrl]);
    } finally {
      setSystemTime();
    }
  });

  test("returns nothing once Den stops listing the skill", async () => {
    const den = fakeDen({ skills: [skill("crm-sync", crmUrl, crmBody)] });
    expect(await readOpenWorkConnectSkillContent(config, crmUrl, den.fetcher)).toBe(crmBody);
    // The next index read, once the 30 s catalog cache expires, no longer lists it.
    setSystemTime(new Date(Date.now() + 31_000));
    try {
      const revoked = fakeDen({ skills: [] });
      expect(await readOpenWorkConnectSkillContent(config, crmUrl, revoked.fetcher)).toBeNull();
      expect(revoked.reads).toEqual([]);
    } finally {
      setSystemTime();
    }
  });
});

describe("incremental sync with Den", () => {
  let dir: string;
  let config: ServerConfig;
  const previousDb = process.env.OPENWORK_RUNTIME_DB;
  const notesBody = "---\nname: notes\ndescription: \"Take notes.\"\n---\n\nWrite it down.";
  const notesUrl = "skill://notes/SKILL.md";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "openwork-skill-sync-"));
    process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
    config = {
      host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
      startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    };
    await writeConnectCloudMcp(config, { type: "remote", url: "https://den.test/mcp/agent" });
    resetOpenWorkConnectSkillCatalogCacheForTests();
  });

  afterEach(() => {
    setSystemTime();
    resetOpenWorkConnectSkillCatalogCacheForTests();
    if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousDb;
    rmSync(dir, { recursive: true, force: true });
  });

  const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));

  test("an unchanged revision costs one small index request and no body requests", async () => {
    const den = syncDen({ revision: "r1", skills: [skill("crm-sync", crmUrl, crmBody)], bodies: { [crmUrl]: crmBody } });
    expect((await readOpenWorkConnectSkillIndex(config, den.fetcher)).skills.map(entry => entry.name)).toEqual(["crm-sync"]);
    expect(den.requests.at(-1)?.sync).toEqual({ known: {} });
    later(31_000);
    const again = await readOpenWorkConnectSkillIndex(config, den.fetcher);
    expect(again.skills.map(entry => entry.name)).toEqual(["crm-sync"]);
    expect(again.delivery).toBe("native");
    // The second read sent the revision and Den answered "unchanged" without a skill list.
    expect(den.requests.at(-1)?.sync).toMatchObject({ revision: "r1" });
    expect(den.count("resources/read", crmUrl)).toBe(0);
    // One session served both index reads.
    expect(den.count("initialize")).toBe(1);
  });

  test("a changed revision returns only the changed and removed entries, merged into the held index", async () => {
    const state = { revision: "r1", skills: [skill("crm-sync", crmUrl, crmBody), skill("notes", notesUrl, notesBody)], bodies: {} };
    const den = syncDen(state);
    await readOpenWorkConnectSkillIndex(config, den.fetcher);
    state.revision = "r2";
    state.skills = [{ ...skill("notes", notesUrl, notesBody), description: "Take better notes." }];
    later(31_000);
    const merged = await readOpenWorkConnectSkillIndex(config, den.fetcher);
    expect(merged.skills.map(entry => [entry.name, entry.description])).toEqual([["notes", "Take better notes."]]);
    // Den was told what was held, so it could leave the unchanged entries out.
    expect(Object.keys(den.requests.at(-1)?.sync?.known as object).sort()).toEqual([crmUrl, notesUrl]);
  });

  test("past fifteen minutes the revision is not trusted and the index is diffed again", async () => {
    const den = syncDen({ revision: "r1", skills: [skill("crm-sync", crmUrl, crmBody)], bodies: {} });
    await readOpenWorkConnectSkillIndex(config, den.fetcher);
    later(15 * 60_000 + 1_000);
    await readOpenWorkConnectSkillIndex(config, den.fetcher);
    expect(den.requests.at(-1)?.sync).not.toHaveProperty("revision");
    expect(Object.keys(den.requests.at(-1)?.sync?.known as object)).toEqual([crmUrl]);
  });

  test("several bodies arrive in one batched read on the same session, marked as a use when asked", async () => {
    const den = syncDen({
      revision: "r1",
      skills: [skill("crm-sync", crmUrl, crmBody), skill("notes", notesUrl, notesBody)],
      bodies: { [crmUrl]: crmBody, [notesUrl]: notesBody },
    });
    const bodies = await readOpenWorkConnectSkillContents(config, [crmUrl, notesUrl], { use: true }, den.fetcher);
    expect(Object.fromEntries(bodies)).toEqual({ [crmUrl]: crmBody, [notesUrl]: notesBody });
    const bodyReads = den.requests.filter(entry => entry.method === "resources/read" && entry.uri !== "skill://index.json");
    expect(bodyReads).toEqual([{ method: "resources/read", uri: crmUrl, sync: { uris: [crmUrl, notesUrl], use: true } }]);
    // initialize once for the index and the bodies together.
    expect(den.count("initialize")).toBe(1);
  });

  test("against a Den without batching, the rest are read one by one on the same session", async () => {
    const den = fakeDen({ skills: [skill("crm-sync", crmUrl, crmBody), skill("tampered", tamperedUrl, "not the published body")] });
    let initializes = 0;
    const counting = async (url: string, init?: RequestInit) => {
      if (JSON.parse(String(init?.body)).method === "initialize") initializes++;
      return den.fetcher(url, init);
    };
    const bodies = await readOpenWorkConnectSkillContents(config, [crmUrl, tamperedUrl], {}, counting);
    expect(Object.fromEntries(bodies)).toEqual({ [crmUrl]: crmBody, [tamperedUrl]: "not the published body" });
    expect(den.reads).toEqual([crmUrl, tamperedUrl]);
    expect(initializes).toBe(1);
  });
});
