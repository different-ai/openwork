import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchDemo, manageDemo } from "../../worlds/lib/demo-launcher.ts";
import type { DemoProvider } from "../../worlds/lib/demo-launcher.ts";
import { demoPrivateDir, readSeatControl, writeDemoJson } from "../../worlds/lib/demo-output.ts";
import { guardDemoBudget, parseDemoOptions, parseDemoSource } from "../../worlds/lib/demo-options.ts";
import { DEMO_AUDIT, parseDemoSnapshot, reviewedDemoSnapshot, verifyDemoSnapshot } from "../../worlds/lib/demo-snapshot.ts";
import type { DemoSnapshot } from "../../worlds/lib/demo-snapshot.ts";
import { main } from "./launch.ts";
import { createDemoSandbox, deleteDemoSandbox, demoCli } from "../../worlds/lib/demo-provider.ts";
import type { DaytonaExec } from "../../evals/packages/hosts/src/daytona.ts";

const id = "11111111-1111-4111-8111-111111111111";
const name = "demo-desktop-fixture";
const entry: DemoSnapshot = { id, sourceSandboxId: id, image: `registry.example.test/demo@sha256:${"a".repeat(64)}`,
  source: "release:0.18.71/cloud", packageSha256: "b".repeat(64), diskGiB: 30, audit: DEMO_AUDIT };
const flags = ["--snapshot", name];
const signed = "https://6080-private-fixture.example.test/vnc.html";

function fakeProvider() {
  const created: string[] = [], removed: string[] = [];
  const provider: DemoProvider = {
    async review() { return entry; },
    async create(name) { created.push(name); return name; },
    async prepare() {},
    async viewer() { return { viewer: signed, viewerExpiresAt: new Date(Date.now() + 3600_000).toISOString() }; },
    async remove(id) { removed.push(id); },
  };
  return { provider, created, removed };
}

async function temp() { return mkdtemp(join(tmpdir(), "openwork-demo-test-")); }

test("snapshot gate requires immutable provenance, canonical source, bounded disk and audit", () => {
  assert.deepEqual(parseDemoSnapshot(entry), entry);
  for (const patch of [{ image: "registry/demo:latest" }, { id: "latest" }, { packageSha256: "x" }, { sourceSandboxId: "" },
    { source: "release:0.18.71" }, { source: "sha:dev" }, { diskGiB: 41 }, { diskGiB: 9 }, { audit: "passed" }]) {
    assert.throws(() => parseDemoSnapshot({ ...entry, ...patch }));
  }
  assert.throws(() => reviewedDemoSnapshot({}, name), /No reviewed entry/);
  assert.throws(() => reviewedDemoSnapshot({ [name]: entry }, "../elsewhere"));
  assert.throws(() => reviewedDemoSnapshot(Object.create({ [name]: entry }), name));
  const actual = { ...entry, name, ref: entry.image, state: "active", cpu: 4, mem: 8, disk: 30 };
  verifyDemoSnapshot(name, entry, actual);
  for (const patch of [{ id: "other" }, { state: "building" }, { ref: "latest" }, { cpu: 8 }, { mem: 16 }, { disk: 40 }, { sourceSandboxId: "other" }]) {
    assert.throws(() => verifyDemoSnapshot(name, entry, { ...actual, ...patch }));
  }
});

test("flags cap seats, TTL, spend and shell-safe timezone; duplicate or unknown flags fail", () => {
  const options = parseDemoOptions(flags);
  assert.deepEqual(options.seats, ["demo", "practice", "backup"]);
  assert.equal(options.lifetime, 1440);
  assert.ok(guardDemoBudget(options, 30) < 30);
  for (const extra of [["--seats", "demo,demo"], ["--seats", "other"], ["--lifetime", "1441"], ["--lifetime", "0"],
    ["--timezone", "UTC';echo x"], ["--timezone", "Invalid/Zone"], ["--wat", "x"], ["--snapshot", name], ["--seats"]]) {
    assert.throws(() => parseDemoOptions([...flags, ...extra]));
  }
  assert.throws(() => guardDemoBudget(parseDemoOptions([...flags, "--budget-usd", "1"]), 30), /exceeds/);
  assert.equal(parseDemoSource(`sha:${"a".repeat(40)}`).kind, "sha");
});

test("private outputs reject loose permissions, checkout descendants and symlinks", async () => {
  const root = await temp();
  try {
    const dir = await demoPrivateDir(join(root, "private"));
    await writeDemoJson(join(dir, "receipt.json"), { viewer: signed });
    assert.equal((await lstat(join(dir, "receipt.json"))).mode & 0o777, 0o600);
    await symlink(dir, join(root, "link"));
    await assert.rejects(demoPrivateDir(join(root, "link")), /not a symlink/);
    await chmod(dir, 0o755);
    await assert.rejects(demoPrivateDir(dir), /0700/);
    await writeFile(join(root, ".git"), "gitdir: fixture");
    await assert.rejects(demoPrivateDir(join(root, "inside-checkout")), /Git checkout/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("three seats journal ownership before create, keep bearer links private, refresh and down", async () => {
  const root = await temp(), dir = join(root, "stage");
  const { provider, created, removed } = fakeProvider();
  const create = provider.create;
  provider.create = async (name, snapshot, lifetime) => {
    const seats = ["demo", "practice", "backup"];
    const receipt = await readSeatControl(join(dir, seats[created.length]!), seats[created.length]!);
    assert.equal(receipt.sandbox, name, "intent is durable before provider dispatch");
    return create(name, snapshot, lifetime);
  };
  try {
    const result = await launchDemo(dir, flags, provider);
    assert.equal(result.ready, "3/3");
    assert.equal(created.length, 3);
    assert.equal(new Set(created).size, 3);
    assert.ok(!JSON.stringify(result).includes(signed));
    await assert.rejects(launchDemo(dir, flags, provider), /EEXIST/);
    assert.equal(created.length, 3);
    await manageDemo(dir, "refresh", provider);
    for (const seat of ["demo", "practice", "backup"]) {
      assert.equal((await readSeatControl(join(dir, seat), seat)).viewer, signed);
    }
    await manageDemo(dir, "down", provider);
    await manageDemo(dir, "down", provider);
    assert.deepEqual([...removed].sort(), [...created].sort());
    assert.ok(!(await readFile(join(dir, "demo/control.json"), "utf8")).includes(signed));
    await chmod(join(dir, "demo/control.json"), 0o644);
    await assert.rejects(readSeatControl(join(dir, "demo"), "demo"), /permissions/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("partial and ambiguous creation failures clean all journaled owners without leaking errors", async () => {
  for (const failCreate of [false, true]) {
    const root = await temp(), dir = join(root, "stage");
    const { provider, created, removed } = fakeProvider();
    const create = provider.create;
    provider.create = async (...args) => {
      const result = await create(...args);
      if (failCreate && created.length === 2) throw new Error(signed);
      return result;
    };
    provider.prepare = async () => { if (!failCreate && created.length === 2) throw new Error(signed); };
    try {
      await assert.rejects(launchDemo(dir, flags, provider), (error: unknown) => error instanceof Error && /owned sandboxes removed/.test(error.message) && !error.message.includes(signed));
      assert.deepEqual(removed, created);
      assert.equal(created.length, 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("cleanup failures are explicit, retain recoverable receipts and do not skip other seats", async () => {
  const root = await temp(), dir = join(root, "stage");
  const { provider, removed } = fakeProvider();
  try {
    await launchDemo(dir, flags, provider);
    const remove = provider.remove;
    provider.remove = async (id) => { await remove(id); throw new Error(signed); };
    await assert.rejects(manageDemo(dir, "down", provider), /incomplete for 3 seat/);
    assert.equal(removed.length, 3);
    assert.equal((await readSeatControl(join(dir, "backup"), "backup")).stopped, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed launch cleanup preserves receipts and an explicit incomplete result", async () => {
  const root = await temp(), dir = join(root, "stage");
  const { provider, removed } = fakeProvider();
  provider.prepare = async () => { throw new Error(signed); };
  provider.remove = async (id) => { removed.push(id); throw new Error(signed); };
  try {
    await assert.rejects(launchDemo(dir, flags, provider), /cleanup incomplete/);
    assert.equal(removed.length, 1);
    assert.equal((await readSeatControl(join(dir, "demo"), "demo")).sandbox, removed[0]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expired seats cannot mint a refreshed viewer but remain eligible for cleanup", async () => {
  const root = await temp(), dir = join(root, "stage");
  const { provider } = fakeProvider();
  try {
    await launchDemo(dir, [...flags, "--seats", "practice"], provider);
    const receipt = await readSeatControl(join(dir, "practice"), "practice");
    await writeDemoJson(join(dir, "practice/control.json"), { ...receipt, expiresAt: new Date(0).toISOString() });
    provider.viewer = async () => { throw new Error("Must not be called."); };
    await assert.rejects(manageDemo(dir, "refresh", provider), /incomplete/);
    await manageDemo(dir, "down", provider);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("live adapter passes immutable snapshot and provider TTL, rejects public identity, and redacts errors", async () => {
  const calls: string[][] = [];
  let isPublic = false;
  const exec: DaytonaExec = async (args) => {
    calls.push(args);
    return { code: 0, stderr: "", stdout: args[0] === "info" ? JSON.stringify({ id, name: id, public: isPublic }) : "sensitive provider output" };
  };
  assert.equal(await createDemoSandbox(id, entry.id, 60, exec), id);
  assert.deepEqual(calls[0], ["create", "--name", id, "--snapshot", entry.id, "--target", "us", "--auto-stop", "0", "--ttl", "60"]);
  assert.ok(!calls.flat().includes("--public"));
  isPublic = true;
  await assert.rejects(createDemoSandbox(id, entry.id, 60, exec), /privacy or identity/);
  const before = calls.length;
  await assert.rejects(createDemoSandbox(id, "latest", 60, exec), /immutable/);
  assert.equal(calls.length, before);
  await assert.rejects(deleteDemoSandbox(id, exec), /could not be confirmed/);
  assert.ok(!calls.some((args) => args[0] === "delete"));
  isPublic = false;
  await deleteDemoSandbox(id, exec);
  assert.deepEqual(calls.at(-1), ["delete", id]);
  await assert.rejects(demoCli(["unused"], "Safe operation", 1, async () => { throw new Error(signed); }),
    (error: unknown) => error instanceof Error && error.message === "Safe operation failed; no provider output logged.");
});

test("stage operation lock prevents refresh or deletion during an in-progress launch", async () => {
  const root = await temp(), dir = join(root, "stage");
  const { provider } = fakeProvider();
  provider.prepare = async () => {
    await assert.rejects(manageDemo(dir, "down", provider), /EEXIST/);
    await assert.rejects(manageDemo(dir, "refresh", provider), /EEXIST/);
  };
  try { await launchDemo(dir, flags, provider); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("checked-in empty allowlist blocks plan and up before credentials, output or provider access", async () => {
  await assert.rejects(main(["plan", ...flags]), /No reviewed entry/);
  await assert.rejects(main(["up", "--stage", "offline-test", ...flags]), /No reviewed entry/);
  await assert.rejects(main(["down", "--stage", "offline-test", "--public", "true"]), /one value per flag/);
});
