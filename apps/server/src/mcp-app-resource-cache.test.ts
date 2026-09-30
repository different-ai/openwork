import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpAppResourceCache } from "./mcp-app-resource-cache.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true }))); });
const resource = { html: "<main>App</main>", csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: false };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mcp-app-cache-")); directories.push(directory);
  return { directory, cache: createMcpAppResourceCache(directory) };
}
test("a miss loads once; concurrent and later hits reuse only immutable content", async () => {
  const { cache } = await fixture(); let reads = 0;
  const load = async () => { reads++; return resource; };
  const values = await Promise.all([cache.read("principal-a", "revision-one", load), cache.read("principal-a", "revision-one", load)]);
  values[0].html = "mutated response";
  expect((await cache.read("principal-a", "revision-one", load)).html).toBe(resource.html);
  expect(reads).toBe(1);
});
test("a new revision, workspace or principal never reuses the previous content", async () => {
  const { cache } = await fixture(); let reads = 0;
  const load = async () => { reads++; return resource; };
  for (const [scope, uri] of [["user-a/workspace-a", "revision-one"], ["user-a/workspace-a", "revision-two"],
    ["user-b/workspace-a", "revision-one"], ["user-a/workspace-b", "revision-one"]]) await cache.read(scope, uri, load);
  expect(reads).toBe(4);
});
test("device cache survives a host restart and expires after one day", async () => {
  const { directory, cache } = await fixture(); let reads = 0;
  const load = async () => { reads++; return resource; };
  await cache.read("user-a", "revision-one", load);
  await createMcpAppResourceCache(directory).read("user-a", "revision-one", load);
  expect(reads).toBe(1);
  await createMcpAppResourceCache(directory, () => Date.now() + 24 * 60 * 60_000 + 1).read("user-a", "revision-one", load);
  expect(reads).toBe(2);
});
test.each(["invalid JSON", "changed digest"])("corrupt disk content is a miss: %s", async corruption => {
  const { directory, cache } = await fixture(); let reads = 0;
  const load = async () => { reads++; return resource; };
  await cache.read("user-a", "revision-one", load);
  const [name] = await readdir(directory);
  await writeFile(join(directory, name), corruption === "invalid JSON" ? "{" : JSON.stringify({ savedAt: Date.now(), digest: "wrong", resource }));
  expect(await createMcpAppResourceCache(directory).read("user-a", "revision-one", load)).toEqual(resource);
  expect(reads).toBe(2);
});
test("failed reads are not cached", async () => {
  const { cache } = await fixture();
  await expect(cache.read("a", "uri", async () => { throw new Error("unavailable"); })).rejects.toThrow("unavailable");
  expect(await cache.read("a", "uri", async () => resource)).toEqual(resource);
});
