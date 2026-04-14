import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readJsonFile } from "./utils.js";

describe("readJsonFile", () => {
  test("reads and parses valid json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openwork-read-json-"));
    const file = join(dir, "data.json");

    await writeFile(file, JSON.stringify({ ok: true, count: 2 }), "utf8");

    expect(await readJsonFile<{ ok: boolean; count: number }>(file)).toEqual({
      ok: true,
      count: 2,
    });
  });

  test("returns null for missing files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openwork-read-json-"));
    const file = join(dir, "missing.json");

    expect(await readJsonFile(file)).toBeNull();
  });

  test("returns null for invalid json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openwork-read-json-"));
    const file = join(dir, "broken.json");

    await writeFile(file, "{not valid json", "utf8");

    expect(await readJsonFile(file)).toBeNull();
  });
});
