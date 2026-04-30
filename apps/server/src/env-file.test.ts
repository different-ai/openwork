import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EnvService,
  EnvStoreReadError,
  InvalidEnvKeyError,
  isReservedEnvKey,
  isValidEnvKey,
} from "./env-file.js";

describe("env-file", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openwork-env-"));
    path = join(dir, "env.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("isValidEnvKey accepts POSIX names, rejects garbage", () => {
    expect(isValidEnvKey("ANTHROPIC_API_KEY")).toBe(true);
    expect(isValidEnvKey("_x")).toBe(true);
    expect(isValidEnvKey("GCLOUD_PROJECT")).toBe(true);
    expect(isValidEnvKey("1BAD")).toBe(false);
    expect(isValidEnvKey("has space")).toBe(false);
    expect(isValidEnvKey("has-dash")).toBe(false);
    expect(isValidEnvKey("")).toBe(false);
  });

  test("isReservedEnvKey blocks OPENWORK_ / OPENCODE_ prefixes", () => {
    expect(isReservedEnvKey("OPENWORK_TOKEN")).toBe(true);
    expect(isReservedEnvKey("OPENCODE_SERVER_PASSWORD")).toBe(true);
    expect(isReservedEnvKey("ANTHROPIC_API_KEY")).toBe(false);
    expect(isReservedEnvKey("GCLOUD_PROJECT")).toBe(false);
  });

  test("upsertMany + list round-trips with sorted keys", async () => {
    const svc = new EnvService({ path });
    await svc.upsertMany([
      { key: "ZED", value: "z" },
      { key: "ANTHROPIC_API_KEY", value: "sk-ant-abc123" },
    ]);
    const items = await svc.list();
    expect(items.map((e) => e.key)).toEqual(["ANTHROPIC_API_KEY", "ZED"]);
    expect(items.find((e) => e.key === "ANTHROPIC_API_KEY")?.value).toBe("sk-ant-abc123");
  });

  test("upsertMany updates existing keys in place", async () => {
    const svc = new EnvService({ path });
    await svc.upsertMany([{ key: "FOO", value: "1" }]);
    await svc.upsertMany([{ key: "FOO", value: "2" }]);
    const items = await svc.list();
    expect(items).toHaveLength(1);
    expect(items[0].value).toBe("2");
  });

  test("concurrent upserts do not overwrite each other", async () => {
    const svc = new EnvService({ path });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        svc.upsertMany([{ key: `KEY_${index}`, value: String(index) }])
      ),
    );

    const items = await svc.list();
    expect(items.map((item) => item.key)).toEqual(
      Array.from({ length: 12 }, (_, index) => `KEY_${index}`).sort(),
    );
  });

  test("write failures do not mutate loaded values", async () => {
    const svc = new EnvService({ path });
    await svc.upsertMany([{ key: "KEEP_ME", value: "old" }]);

    rmSync(path, { force: true });
    mkdirSync(path);

    await expect(svc.upsertMany([{ key: "NEW_KEY", value: "new" }])).rejects.toThrow();
    expect(await svc.list()).toEqual([
      expect.objectContaining({ key: "KEEP_ME", value: "old" }),
    ]);
  });

  test("upsertMany rejects invalid keys with InvalidEnvKeyError", async () => {
    const svc = new EnvService({ path });
    const promise = svc.upsertMany([{ key: "bad-key", value: "x" }]);
    await expect(promise).rejects.toBeInstanceOf(InvalidEnvKeyError);
    await expect(promise).rejects.toMatchObject({ code: "invalid_env_key" });
  });

  test("upsertMany rejects reserved keys", async () => {
    const svc = new EnvService({ path });
    const promise = svc.upsertMany([{ key: "OPENWORK_TOKEN", value: "x" }]);
    await expect(promise).rejects.toBeInstanceOf(InvalidEnvKeyError);
    await expect(promise).rejects.toMatchObject({ code: "reserved_env_key" });
  });

  test("delete returns false when the key is missing", async () => {
    const svc = new EnvService({ path });
    await svc.upsertMany([{ key: "FOO", value: "x" }]);
    expect(await svc.delete("FOO")).toBe(true);
    expect(await svc.delete("FOO")).toBe(false);
  });

  test("persisted file has 0600 perms on POSIX", async () => {
    if (process.platform === "win32") return;
    const svc = new EnvService({ path });
    await svc.upsertMany([{ key: "FOO", value: "bar" }]);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("readForInjection returns a plain key/value map", async () => {
    const svc = new EnvService({ path });
    await svc.upsertMany([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);
    const injected = await EnvService.readForInjection(path);
    expect(injected).toEqual({ A: "1", B: "2" });
  });

  test("readForInjection strips reserved keys even if present on disk", async () => {
    // Simulate a hand-edited env.json that contains a reserved key. The
    // service refuses to write these, but the injection path must still
    // defend against a file someone tampered with.
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: Date.now(),
        variables: [
          { key: "OPENWORK_TOKEN", value: "stolen" },
          { key: "ANTHROPIC_API_KEY", value: "sk-ant" },
        ],
      }),
    );
    const injected = await EnvService.readForInjection(path);
    expect(injected).toEqual({ ANTHROPIC_API_KEY: "sk-ant" });
  });

  test("readForInjection returns {} when the file is missing", async () => {
    const injected = await EnvService.readForInjection(join(dir, "nope.json"));
    expect(injected).toEqual({});
  });

  test("readForInjection returns {} on corrupted JSON", async () => {
    writeFileSync(path, "{ this is not json");
    const injected = await EnvService.readForInjection(path);
    expect(injected).toEqual({});
  });

  test("list rejects corrupted JSON instead of treating it as empty", async () => {
    writeFileSync(path, "{ this is not json");
    const svc = new EnvService({ path });
    await expect(svc.list()).rejects.toBeInstanceOf(EnvStoreReadError);
  });

  test("upsertMany does not overwrite an invalid store", async () => {
    writeFileSync(path, "{ this is not json");
    const svc = new EnvService({ path });
    await expect(svc.upsertMany([{ key: "SAFE", value: "new" }])).rejects.toBeInstanceOf(EnvStoreReadError);
    expect(readFileSync(path, "utf8")).toBe("{ this is not json");
  });
});
