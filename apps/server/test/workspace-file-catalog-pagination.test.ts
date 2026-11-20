import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerFileRoutes } from "../src/routes/files.js";
import { matchRoute, type RequestContext, type Route } from "../src/routes/registry.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";

// The zero-width space is ignored by locale collation, but these are distinct files.
const pageNames = ["001.txt", "a.txt", "a​.txt", "B.txt", "c.txt", "é.txt", "z.txt"];

test("catalog pages return every filename exactly once, in the catalog's own order", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-catalog-pages-"));
  try {
    await mkdir(join(workspaceRoot, "pages"));
    for (const name of pageNames) await writeFile(join(workspaceRoot, "pages", name), name);

    const workspace = { id: "ws_catalog", path: workspaceRoot } as WorkspaceInfo;
    const config = { workspaces: [workspace], readOnly: true } as unknown as ServerConfig;
    const routes: Route[] = [];
    registerFileRoutes({
      routes,
      config,
      jsonResponse: (data, status = 200) => Response.json(data, { status }),
      readJsonBody: async (request) => (await request.json()) as Record<string, unknown>,
      ensureWritable: () => {},
      requireApproval: async () => {},
      requireClientScope: () => {},
      resolveWorkspace: async () => workspace,
      resolveInboxEnabled: () => false,
      resolveOutboxEnabled: () => false,
      resolveInboxMaxBytes: () => 0,
      scopeRank: () => 0,
    });

    const call = async (method: string, path: string, body?: unknown) => {
      const url = new URL(path, "http://openwork.local");
      const route = matchRoute(routes, method, url.pathname);
      if (!route) throw new Error(`No route for ${method} ${url.pathname}`);
      const request = new Request(url, body === undefined ? { method } : { method, body: JSON.stringify(body) });
      const ctx = { request, url, params: route.params, config, actor: { tokenHash: "token", scope: "viewer" } } as unknown as RequestContext;
      return (await (await route.handler(ctx)).json()) as Record<string, unknown>;
    };

    const { session } = (await call("POST", `/workspace/${workspace.id}/files/sessions`, { write: false })) as { session: { id: string } };
    const catalog = (query: string) => call("GET", `/files/sessions/${session.id}/catalog/snapshot?${query}`);

    const received: string[] = [];
    let after = "";
    for (let page = 0; page < Math.ceil(pageNames.length / 2); page += 1) {
      const result = await catalog(`prefix=pages&includeDirs=false&limit=2${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      const paths = (result.items as Array<{ path: string }>).map((item) => item.path);
      const hasMore = (page + 1) * 2 < pageNames.length;
      assert.equal(result.total, pageNames.length - page * 2);
      assert.deepEqual(paths, pageNames.slice(page * 2, page * 2 + 2).map((name) => `pages/${name}`));
      assert.equal(result.truncated, hasMore);
      received.push(...paths);
      if (hasMore) {
        assert.equal(result.nextAfter, paths.at(-1));
        after = String(result.nextAfter);
      } else {
        assert.equal(result.nextAfter, undefined);
      }
    }
    assert.deepEqual(received, pageNames.map((name) => `pages/${name}`));

    const exhausted = await catalog(`prefix=pages&includeDirs=false&limit=2&after=${encodeURIComponent("pages/z.txt")}`);
    assert.deepEqual(exhausted.items, []);
    assert.equal(exhausted.total, 0);
    assert.equal(exhausted.truncated, false);
    assert.equal(exhausted.nextAfter, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
