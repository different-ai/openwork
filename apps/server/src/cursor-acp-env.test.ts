import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnvService } from "./env-file.js";
import { resolveCursorApiKey } from "./cursor-acp-env.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function isolateProcessKey() {
  const previous = process.env.CURSOR_API_KEY;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previous;
  });
  delete process.env.CURSOR_API_KEY;
}

describe("resolveCursorApiKey", () => {
  test("returns the env-store key when process.env.CURSOR_API_KEY is unset", async () => {
    isolateProcessKey();
    const root = await mkdtemp(join(tmpdir(), "cursor-acp-env-"));
    roots.push(root);
    const env = new EnvService({ path: join(root, "env.json") });
    await env.upsertMany([{ key: "CURSOR_API_KEY", value: "cur_test_key" }]);
    expect(await resolveCursorApiKey(env)).toBe("cur_test_key");
  });

  test("returns process.env.CURSOR_API_KEY when the store has no key", async () => {
    isolateProcessKey();
    process.env.CURSOR_API_KEY = "cur_test_key";
    const root = await mkdtemp(join(tmpdir(), "cursor-acp-env-"));
    roots.push(root);
    const env = new EnvService({ path: join(root, "env.json") });
    expect(await resolveCursorApiKey(env)).toBe("cur_test_key");
  });

  test("prefers the env-store key over process.env", async () => {
    isolateProcessKey();
    process.env.CURSOR_API_KEY = "cur_process_key";
    const root = await mkdtemp(join(tmpdir(), "cursor-acp-env-"));
    roots.push(root);
    const env = new EnvService({ path: join(root, "env.json") });
    await env.upsertMany([{ key: "CURSOR_API_KEY", value: "cur_test_key" }]);
    expect(await resolveCursorApiKey(env)).toBe("cur_test_key");
  });

  test("returns empty string when neither source has a key", async () => {
    isolateProcessKey();
    const root = await mkdtemp(join(tmpdir(), "cursor-acp-env-"));
    roots.push(root);
    const env = new EnvService({ path: join(root, "env.json") });
    expect(await resolveCursorApiKey(env)).toBe("");
  });
});
