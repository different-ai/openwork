import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { stalePublishedDocumentMessage, syncPublishedDocument } from "./published-document.mjs";

const tracked = Buffer.from('{"openapi":"3.1.0","paths":{"/v1/teams":{}}}');
const exported = Buffer.from('{"openapi":"3.1.0","paths":{"/v1/teams":{},"/v1/apps":{}}}');
let directory;
let path;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openwork-published-document-"));
  path = join(directory, "openapi.json");
  await writeFile(path, tracked);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("check mode rejects a stale tracked document and leaves it untouched", async () => {
  await assert.rejects(
    syncPublishedDocument({ exported, path, check: true }),
    { message: stalePublishedDocumentMessage },
  );
  assert.ok((await readFile(path)).equals(tracked), "check mode must not rewrite the tracked artifact");
});

test("check mode accepts a tracked document identical to the export", async () => {
  await syncPublishedDocument({ exported: Buffer.from(tracked), path, check: true });
  assert.ok((await readFile(path)).equals(tracked));
});

test("generate mode replaces the tracked document with the export", async () => {
  await syncPublishedDocument({ exported, path, check: false });
  assert.ok((await readFile(path)).equals(exported));
});
