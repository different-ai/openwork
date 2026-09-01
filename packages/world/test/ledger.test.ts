import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendLedgerEntry,
  LEDGER_ENV,
  readLedger,
  rewriteLedger,
  trackResource,
} from "../src/ledger.ts";

function absent(path: string): Promise<boolean> {
  return access(path).then(() => false, () => true);
}

test("appendLedgerEntry creates a private JSONL ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-ledger-append-"));
  try {
    const path = join(root, "nested", "world.ledger.jsonl");
    await appendLedgerEntry(path, { kind: "docker", id: "container", label: "app" });
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600);
    const line: unknown = JSON.parse((await readFile(path, "utf8")).trim());
    assert.deepEqual(line, {
      kind: "docker",
      id: "container",
      label: "app",
      at: line && typeof line === "object" && "at" in line ? line.at : undefined,
    });
    assert.equal(line && typeof line === "object" && "at" in line && typeof line.at === "string", true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readLedger skips invalid lines and keeps the last kind/id occurrence", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-ledger-read-"));
  try {
    const path = join(root, "world.ledger.jsonl");
    await writeFile(path, [
      "",
      "not-json",
      JSON.stringify({ kind: "tmpdir", id: "/tmp/a", label: 42, at: "invalid" }),
      JSON.stringify({ kind: "tmpdir", id: "/tmp/a", label: "first", at: "one" }),
      JSON.stringify({ kind: "process", id: "123", at: "two" }),
      JSON.stringify({ kind: "tmpdir", id: "/tmp/a", label: "last", retain: true, at: "three" }),
      "",
    ].join("\n"), "utf8");

    assert.deepEqual(await readLedger(path), [
      { kind: "process", id: "123", at: "two" },
      { kind: "tmpdir", id: "/tmp/a", label: "last", retain: true, at: "three" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rewriteLedger unlinks an empty ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-ledger-rewrite-"));
  try {
    const path = join(root, "world.ledger.jsonl");
    await writeFile(path, "content\n", "utf8");
    await rewriteLedger(path, []);
    assert.equal(await absent(path), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trackResource is inert without its env var and appends when configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-ledger-track-"));
  const path = join(root, "world.ledger.jsonl");
  const previous = process.env[LEDGER_ENV];
  try {
    delete process.env[LEDGER_ENV];
    await trackResource({ kind: "tmpdir", id: "/tmp/noop" });
    assert.equal(await absent(path), true);

    process.env[LEDGER_ENV] = path;
    await trackResource({ kind: "tmpdir", id: "/tmp/tracked", retain: true });
    const entries = await readLedger(path);
    assert.equal(entries.length, 1);
    assert.deepEqual({ ...entries[0], at: "recorded" }, {
      kind: "tmpdir",
      id: "/tmp/tracked",
      retain: true,
      at: "recorded",
    });
  } finally {
    if (previous === undefined) delete process.env[LEDGER_ENV];
    else process.env[LEDGER_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
