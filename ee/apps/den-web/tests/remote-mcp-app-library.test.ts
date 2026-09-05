import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseLibraryPayload } from "../app/(den)/dashboard/_components/library-data";

test("ignores stored standalone URL Apps in Library payloads", () => {
  expect(parseLibraryPayload({
    items: [{
      type: "app",
      id: "cob_01kzzzzzzzzzzzzzzzzzzzzzzz",
      pluginId: "plg_01kzzzzzzzzzzzzzzzzzzzzzzz",
      name: "Project Atlas",
      description: "Portable dashboard",
      sourceUrl: "https://example.test/project-atlas.html",
      status: "active",
      activeVersionId: "cov_01kzzzzzzzzzzzzzzzzzzzzzzz",
      state: "ready",
      edges: [{ kind: "org_wide" }],
      role: "viewer",
    }],
  })).toEqual([]);
});

test("has no standalone URL-App import or detail entry point", () => {
  const components = join(import.meta.dir, "../app/(den)/dashboard/_components");
  const libraryScreen = readFileSync(join(components, "library-screen.tsx"), "utf8");
  const pluginData = readFileSync(join(components, "plugin-data.tsx"), "utf8");
  const pluginDetail = readFileSync(join(components, "plugin-detail-screen.tsx"), "utf8");
  expect(libraryScreen).not.toContain("add-remote-mcp-app");
  expect(libraryScreen).not.toContain("Add remote MCP App");
  expect(libraryScreen).not.toContain("RemoteMcpAppImport");
  expect(pluginData).not.toContain('objectType === "app"');
  expect(pluginDetail).not.toContain("Remote Apps");
  expect(pluginDetail).not.toContain("getRemoteMcpAppRoute");
});

test("keeps ordinary plugin and connection navigation in the unified Library", () => {
  const components = join(import.meta.dir, "../app/(den)/dashboard/_components");
  const libraryScreen = readFileSync(join(components, "library-screen.tsx"), "utf8");
  expect(libraryScreen).toContain("getLibraryPluginRoute(orgSlug, item.id)");
  expect(libraryScreen).toContain("getYourConnectionsRoute(orgSlug)");
  expect(libraryScreen).toContain("?connectionId=");
});
