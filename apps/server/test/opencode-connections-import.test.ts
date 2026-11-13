import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiError } from "../src/errors.js";
import { listMcpFromRuntimeSnapshot } from "../src/mcp.js";
import { opencodeUserConfigPaths, readOpencodeConnections } from "../src/opencode-connections-import.js";
import {
  importOpencodeConnections,
  previewOpencodeConnections,
  type OpencodeConnectionsImportTarget,
} from "../src/routes/opencode-connections-import.js";

// Synthetic OpenCode configs. The secret values are fixtures, checked only to prove they never leave the server.

const SECRET_ENV = "fixture-env-secret-value";
const SECRET_HEADER = "Bearer fixture-header-secret-value";

const JSONC_CONFIG = `{
  // connections set up by hand in OpenCode
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "notes": {
      "type": "local",
      "command": ["/usr/local/bin/notes-mcp", "--token", "${SECRET_ENV}"],
      "environment": { "NOTES_TOKEN": "${SECRET_ENV}" },
    },
    "tracker": {
      "type": "remote",
      "url": "https://mcp.example.com/sse?key=${SECRET_ENV}",
      "headers": { "Authorization": "${SECRET_HEADER}" },
    },
    "broken": { "type": "remote", "url": "not a url" },
    "bad name": { "type": "local", "command": ["x"] },
  },
}
`;

async function configDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-connections-import-"));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

/** Stands in for a workspace: holds what OpenWork has and records what the import adds. */
function workspace(options: { existing?: string[]; blocked?: string[]; failing?: string[] } = {}) {
  const added = new Map<string, Record<string, unknown>>();
  const existing = new Set(options.existing ?? []);
  const target: OpencodeConnectionsImportTarget = {
    existingNames: async () => new Set([...existing, ...added.keys()]),
    checkPolicy: async (name) => {
      if (options.blocked?.includes(name)) throw new ApiError(403, "organization_policy_denied", `policy text naming ${name}`);
    },
    add: async (name, config) => {
      if (options.failing?.includes(name)) throw new Error(`could not save ${JSON.stringify(config)}`);
      added.set(name, config);
    },
  };
  return { target, added };
}

describe("reading the person's OpenCode config", () => {
  test("reads local and remote connections from a config with comments and trailing commas", async () => {
    const dir = await configDir({ "opencode.jsonc": JSONC_CONFIG });
    const source = await readOpencodeConnections(opencodeUserConfigPaths(dir));

    expect(source.status).toBe("found");
    expect(source.connections.map((item) => [item.name, item.kind, item.target])).toEqual([
      ["notes", "local", "notes-mcp"],
      ["tracker", "remote", "mcp.example.com"],
    ]);
    expect(source.connections[0]?.config).toEqual({
      type: "local",
      command: ["/usr/local/bin/notes-mcp", "--token", SECRET_ENV],
      environment: { NOTES_TOKEN: SECRET_ENV },
    });
    expect(source.connections[1]?.config).toEqual({
      type: "remote",
      url: `https://mcp.example.com/sse?key=${SECRET_ENV}`,
      headers: { Authorization: SECRET_HEADER },
    });
    expect(source.problems.map((item) => item.name)).toEqual(["bad name", "broken"]);
  });

  test("reads plain JSON, and a later file wins over an earlier one", async () => {
    const dir = await configDir({
      "config.json": JSON.stringify({ mcp: { tracker: { type: "remote", url: "https://old.example.com" }, files: { type: "local", command: ["files-mcp"] } } }),
      "opencode.json": JSON.stringify({ mcp: { tracker: { type: "remote", url: "https://new.example.com/mcp" } } }),
    });
    const source = await readOpencodeConnections(opencodeUserConfigPaths(dir));

    expect(source.connections.map((item) => [item.name, item.target])).toEqual([["files", "files-mcp"], ["tracker", "new.example.com"]]);
  });

  test("accepts the map nested under mcp.servers and the command + args + env spelling", async () => {
    const dir = await configDir({
      "opencode.json": JSON.stringify({
        mcp: {
          servers: {
            files: { command: "npx", args: ["-y", "files-mcp"], env: { ROOT: "/tmp" } },
            tracker: { url: "https://mcp.example.com/mcp" },
          },
        },
      }),
    });
    const source = await readOpencodeConnections(opencodeUserConfigPaths(dir));

    expect(source.status).toBe("found");
    expect(source.problems).toEqual([]);
    expect(source.connections.map((item) => item.config)).toEqual([
      { type: "local", command: ["npx", "-y", "files-mcp"], environment: { ROOT: "/tmp" } },
      { type: "remote", url: "https://mcp.example.com/mcp" },
    ]);
  });

  test("a connection that is itself named servers is still one connection", async () => {
    const dir = await configDir({ "opencode.json": JSON.stringify({ mcp: { servers: { type: "local", command: ["servers-mcp"] } } }) });
    const source = await readOpencodeConnections(opencodeUserConfigPaths(dir));

    expect(source.connections.map((item) => item.name)).toEqual(["servers"]);
  });

  test("a missing file is reported, not thrown", async () => {
    const dir = await configDir({});
    expect(await readOpencodeConnections(opencodeUserConfigPaths(dir))).toEqual({ status: "missing", connections: [], problems: [] });
  });

  test("an invalid file is reported, not thrown, and offers nothing", async () => {
    const dir = await configDir({ "opencode.json": `{ "mcp": { "notes": { "type": "local", "command": ["notes"] ` });
    expect(await readOpencodeConnections(opencodeUserConfigPaths(dir))).toEqual({ status: "invalid", connections: [], problems: [] });
  });

  test("a file with no connections is found and empty", async () => {
    const dir = await configDir({ "opencode.json": JSON.stringify({ theme: "system" }) });
    expect(await readOpencodeConnections(opencodeUserConfigPaths(dir))).toEqual({ status: "found", connections: [], problems: [] });
  });

  test("names OpenWork reserves for the organization are not offered", async () => {
    const dir = await configDir({ "opencode.json": JSON.stringify({ mcp: { "openwork-cloud": { type: "remote", url: "https://example.com/mcp" }, notes: { type: "local", command: ["notes"] } } }) });
    const source = await readOpencodeConnections(opencodeUserConfigPaths(dir));

    expect(source.connections.map((item) => item.name)).toEqual(["notes"]);
    expect(source.problems).toEqual([]);
  });
});

describe("previewing the import", () => {
  test("says which connections are new, already here, blocked or invalid, without any secret", async () => {
    const dir = await configDir({ "opencode.jsonc": JSONC_CONFIG });
    const { target, added } = workspace({ existing: ["notes"], blocked: ["tracker"] });
    const preview = await previewOpencodeConnections(target, opencodeUserConfigPaths(dir));

    expect(preview.source).toBe("found");
    expect(preview.items).toEqual([
      { name: "bad name", status: "invalid", reason: "Its name can only use letters, numbers, - and _." },
      { name: "broken", status: "invalid", reason: "It needs a web address that starts with http:// or https://." },
      { name: "notes", kind: "local", target: "notes-mcp", status: "already_present" },
      { name: "tracker", kind: "remote", target: "mcp.example.com", status: "blocked", reason: "Your organization does not allow this connection." },
    ]);
    const sent = JSON.stringify(preview);
    expect(sent).not.toContain(SECRET_ENV);
    expect(sent).not.toContain("fixture-header-secret-value");
    expect(added.size).toBe(0);
  });

  test("an invalid file previews as invalid with nothing to import", async () => {
    const dir = await configDir({ "opencode.json": "{ nope" });
    expect(await previewOpencodeConnections(workspace().target, opencodeUserConfigPaths(dir))).toEqual({ source: "invalid", items: [] });
  });
});

describe("importing", () => {
  test("adds the chosen connections with their full config and leaves the person's file untouched", async () => {
    const dir = await configDir({ "opencode.jsonc": JSONC_CONFIG });
    const path = join(dir, "opencode.jsonc");
    const before = await stat(path);
    const { target, added } = workspace();

    const results = await importOpencodeConnections(target, ["notes", "tracker"], opencodeUserConfigPaths(dir));

    expect(results).toEqual([{ name: "notes", status: "imported" }, { name: "tracker", status: "imported" }]);
    expect(added.get("notes")).toEqual({
      type: "local",
      command: ["/usr/local/bin/notes-mcp", "--token", SECRET_ENV],
      environment: { NOTES_TOKEN: SECRET_ENV },
    });
    expect(added.get("tracker")).toEqual({
      type: "remote",
      url: `https://mcp.example.com/sse?key=${SECRET_ENV}`,
      headers: { Authorization: SECRET_HEADER },
    });
    expect(await readFile(path, "utf8")).toBe(JSONC_CONFIG);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  test("running it again adds nothing and says each one is already here", async () => {
    const dir = await configDir({ "opencode.jsonc": JSONC_CONFIG });
    const { target, added } = workspace();
    await importOpencodeConnections(target, ["notes", "tracker"], opencodeUserConfigPaths(dir));
    const first = new Map(added);

    const again = await importOpencodeConnections(target, ["notes", "tracker"], opencodeUserConfigPaths(dir));

    expect(again).toEqual([{ name: "notes", status: "already_present" }, { name: "tracker", status: "already_present" }]);
    expect(added).toEqual(first);
  });

  test("never overwrites a connection OpenWork already has", async () => {
    const dir = await configDir({ "opencode.jsonc": JSONC_CONFIG });
    const { target, added } = workspace({ existing: ["notes"] });

    expect(await importOpencodeConnections(target, ["notes"], opencodeUserConfigPaths(dir))).toEqual([{ name: "notes", status: "already_present" }]);
    expect(added.size).toBe(0);
  });

  test("a connection the organization blocks is skipped and the rest still import", async () => {
    const dir = await configDir({ "opencode.jsonc": JSONC_CONFIG });
    const { target, added } = workspace({ blocked: ["tracker"] });

    const results = await importOpencodeConnections(target, ["tracker", "notes"], opencodeUserConfigPaths(dir));

    expect(results).toEqual([
      { name: "tracker", status: "blocked", message: "Your organization does not allow this connection." },
      { name: "notes", status: "imported" },
    ]);
    expect([...added.keys()]).toEqual(["notes"]);
  });

  test("invalid and unknown names are skipped with a reason", async () => {
    const dir = await configDir({ "opencode.jsonc": JSONC_CONFIG });
    const { target, added } = workspace();

    const results = await importOpencodeConnections(target, ["broken", "gone", "notes", "notes"], opencodeUserConfigPaths(dir));

    expect(results).toEqual([
      { name: "broken", status: "invalid", message: "It needs a web address that starts with http:// or https://." },
      { name: "gone", status: "invalid", message: "It is no longer in your OpenCode config." },
      { name: "notes", status: "imported" },
    ]);
    expect([...added.keys()]).toEqual(["notes"]);
  });

  test("a failed save is reported without quoting the connection", async () => {
    const dir = await configDir({ "opencode.jsonc": JSONC_CONFIG });
    const { target } = workspace({ failing: ["notes"] });

    const results = await importOpencodeConnections(target, ["notes", "tracker"], opencodeUserConfigPaths(dir));

    expect(results).toEqual([
      { name: "notes", status: "failed", message: "OpenWork could not save this connection." },
      { name: "tracker", status: "imported" },
    ]);
    expect(JSON.stringify(results)).not.toContain(SECRET_ENV);
  });
});

describe("the connection list after importing", () => {
  test("an imported connection is listed once, not also as an OpenCode-file entry", async () => {
    const dir = await configDir({
      "opencode.json": JSON.stringify({ mcp: { notes: { type: "local", command: ["notes"] }, files: { type: "local", command: ["files"] } } }),
    });
    const root = await mkdtemp(join(tmpdir(), "opencode-connections-import-root-"));
    const previous = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = dir;
    try {
      const items = await listMcpFromRuntimeSnapshot(root, { mcp: { notes: { type: "local", command: ["notes"] } } });
      expect(items.map((item) => [item.name, item.source])).toEqual([["files", "config.global"], ["notes", "config.remote"]]);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previous;
    }
  });
});
