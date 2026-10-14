import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupLegacyDesktopIdentity } from "../electron/legacy-desktop-identity.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwork-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, "userData");
  const programsPath = path.join(root, "Programs");
  await mkdir(userDataPath);
  await mkdir(programsPath);
  return {
    userDataPath,
    programsPath,
    appName: "OpenWork",
    appIdentifier: "com.differentai.openwork",
    executablePath: path.join(root, "OpenWork.exe"),
    restoreStockShortcut: true,
  };
}

const missing = (file) => assert.rejects(access(file), { code: "ENOENT" });
const ownedShortcut = (input) => ({ target: input.executablePath, appUserModelId: input.appIdentifier });

test("upgrade and restart keep rollback assets untouched, restoring only stock OpenWork identity", async (t) => {
  const input = await fixture(t);
  const legacyShortcut = path.join(input.programsPath, "Legacy desktop.lnk");
  await writeFile(legacyShortcut, "legacy");
  await writeFile(path.join(input.userDataPath, "windows-brand-shortcut.txt"), legacyShortcut);
  const caches = {
    "brand-icon.png": Buffer.from([137, 80, 78, 71, 1, 2, 3]),
    "brand-icon.json": Buffer.from(JSON.stringify({ url: "https://unused.invalid/icon.png", hash: "original-hash" })),
    "brand-icon.ico": Buffer.from([0, 0, 1, 0, 255, 128]),
    "openwork-stock.ico": Buffer.from([0, 0, 1, 0, 127]),
  };
  await Promise.all(Object.entries(caches).map(([name, bytes]) => writeFile(path.join(input.userDataPath, name), bytes)));
  const originalStats = Object.fromEntries(await Promise.all(Object.keys(caches).map(async (name) => [
    name, await stat(path.join(input.userDataPath, name)),
  ])));
  const calls = [];
  await cleanupLegacyDesktopIdentity({ ...input, shell: {
    readShortcutLink: (shortcutPath) => {
      assert.equal(shortcutPath, legacyShortcut);
      return { ...ownedShortcut(input), appUserModelId: `${input.appIdentifier}.brand.0123456789abcdef` };
    },
    writeShortcutLink: (...args) => { calls.push(args); return true; },
  } });
  assert.deepEqual(calls, [[path.join(input.programsPath, "OpenWork.lnk"), "create", {
    target: input.executablePath,
    cwd: path.dirname(input.executablePath),
    description: "OpenWork",
    icon: input.executablePath,
    iconIndex: 0,
    appUserModelId: input.appIdentifier,
  }]]);
  await missing(legacyShortcut);
  await missing(path.join(input.userDataPath, "windows-brand-shortcut.txt"));
  await cleanupLegacyDesktopIdentity({ ...input, shell: {
    readShortcutLink() { assert.fail("restart has no legacy marker"); },
    writeShortcutLink() { assert.fail("restart must not apply cached identity"); },
  } });
  // A rollback can still read the original cache URL/hash and exact image bytes.
  for (const [name, bytes] of Object.entries(caches)) {
    assert.deepEqual(await readFile(path.join(input.userDataPath, name)), bytes);
    const after = await stat(path.join(input.userDataPath, name));
    assert.equal(after.mtimeMs, originalStats[name].mtimeMs);
    assert.equal(after.ino, originalStats[name].ino);
  }
});

test("does not delete arbitrary paths from a corrupt legacy marker", async (t) => {
  const input = await fixture(t);
  const unrelated = path.join(input.userDataPath, "keep.txt");
  await writeFile(unrelated, "keep");
  await writeFile(path.join(input.userDataPath, "windows-brand-shortcut.txt"), unrelated);
  await cleanupLegacyDesktopIdentity({ ...input, shell: {
    readShortcutLink() { assert.fail("not a Programs shortcut"); },
    writeShortcutLink() { assert.fail("not a legacy shortcut"); },
  } });
  assert.equal(await readFile(unrelated, "utf8"), "keep");
});

test("keeps the marker and old shortcut for retry if stock restoration fails", async (t) => {
  const input = await fixture(t);
  const legacyShortcut = path.join(input.programsPath, "Legacy desktop.lnk");
  const marker = path.join(input.userDataPath, "windows-brand-shortcut.txt");
  await writeFile(legacyShortcut, "legacy");
  await writeFile(marker, legacyShortcut);
  await assert.rejects(cleanupLegacyDesktopIdentity({ ...input, shell: {
    readShortcutLink: () => ownedShortcut(input),
    writeShortcutLink: () => false,
  } }), /restore/);
  assert.equal(await readFile(marker, "utf8"), legacyShortcut);
  assert.equal(await readFile(legacyShortcut, "utf8"), "legacy");
});

test("preserves unrelated shortcuts inside Programs without restoring a stock shortcut", async (t) => {
  const input = await fixture(t);
  const unrelated = path.join(input.programsPath, "Other app.lnk");
  const marker = path.join(input.userDataPath, "windows-brand-shortcut.txt");
  await writeFile(unrelated, "other app");
  const otherTarget = path.join(path.dirname(input.executablePath), "Other.exe");
  for (const details of [
    { target: otherTarget, appUserModelId: "com.example.other" },
    { target: input.executablePath, appUserModelId: "com.example.other" },
    { target: otherTarget, appUserModelId: input.appIdentifier },
    { target: input.executablePath, appUserModelId: `${input.appIdentifier}.brand.not-a-legacy-id` },
  ]) {
    await writeFile(marker, unrelated);
    await cleanupLegacyDesktopIdentity({ ...input, shell: {
      readShortcutLink: (shortcutPath) => { assert.equal(shortcutPath, unrelated); return details; },
      writeShortcutLink() { assert.fail("unrelated shortcut must not restore stock identity"); },
    } });
    assert.equal(await readFile(unrelated, "utf8"), "other app");
    await missing(marker);
  }
});

test("discards a missing shortcut marker without restoring a stock shortcut", async (t) => {
  const input = await fixture(t);
  const absent = path.join(input.programsPath, "Missing desktop.lnk");
  const marker = path.join(input.userDataPath, "windows-brand-shortcut.txt");
  await writeFile(marker, absent);
  await cleanupLegacyDesktopIdentity({ ...input, shell: {
    readShortcutLink: (shortcutPath) => {
      assert.equal(shortcutPath, absent);
      throw Object.assign(new Error("Shortcut not found"), { code: "ENOENT" });
    },
    writeShortcutLink() { assert.fail("missing shortcut must not restore stock identity"); },
  } });
  await missing(marker);
  await missing(absent);
});

test("never overwrites an unrelated shortcut at the stock destination", async (t) => {
  const input = await fixture(t);
  const legacyShortcut = path.join(input.programsPath, "Legacy desktop.lnk");
  const stockShortcut = path.join(input.programsPath, "OpenWork.lnk");
  const marker = path.join(input.userDataPath, "windows-brand-shortcut.txt");
  await writeFile(legacyShortcut, "legacy");
  await writeFile(stockShortcut, "unrelated");
  await writeFile(marker, legacyShortcut);
  await assert.rejects(cleanupLegacyDesktopIdentity({ ...input, shell: {
    readShortcutLink: (shortcutPath) => shortcutPath === legacyShortcut
      ? ownedShortcut(input)
      : { target: path.join(input.programsPath, "Other.exe"), appUserModelId: "com.example.other" },
    writeShortcutLink() { assert.fail("unowned stock destination must not be overwritten"); },
  } }), /not owned/);
  assert.equal(await readFile(stockShortcut, "utf8"), "unrelated");
  assert.equal(await readFile(legacyShortcut, "utf8"), "legacy");
  assert.equal(await readFile(marker, "utf8"), legacyShortcut);
});

test("is idempotent on a clean profile and never creates a shortcut", async (t) => {
  const input = await fixture(t);
  const shell = {
    readShortcutLink() { assert.fail("no legacy marker"); },
    writeShortcutLink() { assert.fail("no legacy marker"); },
  };
  await cleanupLegacyDesktopIdentity({ ...input, shell });
  await cleanupLegacyDesktopIdentity({ ...input, shell });
});
