import assert from "node:assert/strict";
import { test } from "node:test";
import { readMcpSkillIndexCached, resetOpenWorkConnectSkillCatalogCacheForTests } from "../src/connect-skill-catalog.js";
import { sha256Digest } from "../src/opencode-plugins/openwork-cloud-skills-v2.js";
import type { McpFetch } from "../src/connect-mcp-transport.js";

test("instruction authorization bypasses cached readiness, identity and rollout decisions", async () => {
  resetOpenWorkConnectSkillCatalogCacheForTests();
  let state: "ready" | "setup" | "changed" | "off" = "ready";
  let reads = 0;
  const cloud = { url: "https://fixture.invalid/mcp", headers: { authorization: "Bearer fixture-only" } };
  const fetcher: McpFetch = async (_url, init) => {
    assert.equal(typeof init?.body, "string");
    const request: unknown = JSON.parse(String(init?.body));
    assert.ok(typeof request === "object" && request !== null && "method" in request);
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.ok("id" in request);
    if (request.method === "initialize") return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18" } });
    assert.equal(request.method, "resources/read"); reads++;
    const index = {
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      ...(state === "off" ? {} : { delivery: "native" }),
      skills: [{ name: "fixture-review", type: "skill-md", title: "Fixture review", description: "Review a fixture.",
        url: "skill://fixture-review/SKILL.md", capability: "skill:fixture-review", modelDiscovery: true,
        ...(state === "setup" ? { setup: { status: "needs_connection", message: "Connect the fixture service." } }
          : { digest: sha256Digest(state === "changed" ? "new body" : "old body") }) }],
    };
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { contents: [{ uri: "skill://index.json", mimeType: "application/json", text: JSON.stringify(index) }] } });
  };
  try {
    const ready = await readMcpSkillIndexCached(cloud, fetcher);
    assert.equal(ready?.skills[0]?.digest, sha256Digest("old body"));
    state = "setup";
    assert.equal((await readMcpSkillIndexCached(cloud, fetcher))?.skills[0]?.digest, sha256Digest("old body"));
    assert.equal(reads, 1, "witness: discovery still has the warm readiness snapshot");
    const withheld = await readMcpSkillIndexCached(cloud, fetcher, true);
    assert.equal(withheld?.skills[0]?.digest, undefined); assert.equal(withheld?.skills[0]?.setup?.status, "needs_connection");
    state = "changed";
    assert.equal((await readMcpSkillIndexCached(cloud, fetcher, true))?.skills[0]?.digest, sha256Digest("new body"));
    state = "off";
    assert.equal((await readMcpSkillIndexCached(cloud, fetcher, true))?.delivery, undefined);
    assert.equal(reads, 4, "each authorization refresh rechecks the actual MCP resource instead of reusing a grant");
  } finally { resetOpenWorkConnectSkillCatalogCacheForTests(); }
});
