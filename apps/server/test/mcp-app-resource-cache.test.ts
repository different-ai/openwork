import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MCP_APP_MAX_HTML_BYTES } from "@openwork/types/mcp-app";
import { MCP_APP_RESOURCE_MAX_BYTES } from "../src/mcp-app-limits.js";
import { createMcpAppResourceCache } from "../src/mcp-app-resource-cache.js";

const resource = (html: string) => ({
  html,
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
  prefersBorder: false,
});

test("desktop and builder keep the same bounded HTML resource size", () => {
  assert.equal(MCP_APP_RESOURCE_MAX_BYTES, MCP_APP_MAX_HTML_BYTES);
  assert.equal(MCP_APP_RESOURCE_MAX_BYTES, 1536 * 1024);
});

test("a bundled renderer-sized App survives memory and disk cache reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-app-large-resource-"));
  try {
    const expected = resource("x".repeat(1_140_000));
    let loads = 0;
    const load = async () => { loads += 1; return expected; };
    const first = createMcpAppResourceCache(directory);
    assert.deepEqual(await first.read("scope", "ui://model/revision", load), expected);
    assert.deepEqual(await first.read("scope", "ui://model/revision", load), expected);
    const second = createMcpAppResourceCache(directory);
    assert.deepEqual(await second.read("scope", "ui://model/revision", load), expected);
    assert.equal(loads, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the resource cache enforces both character and UTF-8 byte ceilings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-app-resource-bound-"));
  try {
    const cache = createMcpAppResourceCache(directory);
    const exact = resource("x".repeat(MCP_APP_RESOURCE_MAX_BYTES));
    assert.deepEqual(await cache.read("scope", "ui://exact", async () => exact), exact);
    await assert.rejects(cache.read("scope", "ui://ascii-too-large", async () => resource("x".repeat(MCP_APP_RESOURCE_MAX_BYTES + 1))));
    // The text fits the character ceiling but not the encoded resource budget.
    await assert.rejects(cache.read("scope", "ui://utf8-too-large", async () => resource("é".repeat(MCP_APP_RESOURCE_MAX_BYTES / 2 + 1))));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
