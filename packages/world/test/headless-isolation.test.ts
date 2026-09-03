import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { isolatedHeadlessEngineEnv, resolveHeadlessWorldRuntimePaths } from "../src/headless-web.ts";

// An `isolated` headless world must not open the installed desktop app's
// ~/.local/share/opencode/opencode.db: two long-lived writers on one SQLite
// file contend for the single writer lock and mix world sessions into the
// person's history.

test("dev-headless keeps its engine sessions database under tmp/", () => {
  const paths = resolveHeadlessWorldRuntimePaths("/repo", "dev-headless");
  assert.equal(paths.opencodeDbPath, join("/repo", "tmp", "dev-headless-opencode.db"));
});

test("named worlds keep their engine sessions database inside their runtime directory", () => {
  const paths = resolveHeadlessWorldRuntimePaths("/repo", "acme-demo");
  assert.equal(paths.opencodeDbPath, join(paths.directory, "opencode.db"));
  assert.equal(paths.directory, join("/repo", "tmp", "worlds", "runtime", "acme-demo"));
});

test("isolated engine env points OPENCODE_DB at the world database and nothing else", () => {
  const paths = resolveHeadlessWorldRuntimePaths("/repo", "dev-headless");
  const env = isolatedHeadlessEngineEnv(paths, { HOME: "/Users/person", XDG_DATA_HOME: "/Users/person/.local/share" });
  assert.deepEqual(env, { OPENCODE_DB: join("/repo", "tmp", "dev-headless-opencode.db") });
  // Provider credentials and the engine log stay with the person: no XDG/HOME rewrite.
  assert.equal("XDG_DATA_HOME" in env, false);
  assert.equal("HOME" in env, false);
});

test("an explicit OPENCODE_DB wins over the world default", () => {
  const paths = resolveHeadlessWorldRuntimePaths("/repo", "dev-headless");
  assert.deepEqual(
    isolatedHeadlessEngineEnv(paths, { OPENCODE_DB: " /elsewhere/opencode.db " }),
    { OPENCODE_DB: "/elsewhere/opencode.db" },
  );
  assert.deepEqual(
    isolatedHeadlessEngineEnv(paths, { OPENCODE_DB: "   " }),
    { OPENCODE_DB: join("/repo", "tmp", "dev-headless-opencode.db") },
  );
});
