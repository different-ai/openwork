import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveReleaseSecret, emptyReleaseModule, obfuscateReleaseSecret, writeDesktopFreeReleaseModule } from "./prepare-desktop-free-release.mjs";

const masterKey = "test-only-release-master-key-2222222222222222222";

async function load(text, root) {
  const file = path.join(root, `module-${Math.random().toString(16).slice(2)}.mjs`);
  await import("node:fs/promises").then((fs) => fs.writeFile(file, text, "utf8"));
  return import(file);
}

test("the release secret is HMAC(master, version) and changes with every version", () => {
  const secret = deriveReleaseSecret(masterKey, "1.2.3");
  assert.equal(secret.length, 32);
  assert.deepEqual(secret, createHmac("sha256", masterKey).update("1.2.3").digest());
  assert.notDeepEqual(secret, deriveReleaseSecret(masterKey, "1.2.4"));
  assert.throws(() => deriveReleaseSecret("short", "1.2.3"), /32 characters/);
  assert.throws(() => deriveReleaseSecret(masterKey, ""), /version/);
});

test("the generated module reveals the secret at runtime but never contains it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-free-release-"));
  try {
    const secret = deriveReleaseSecret(masterKey, "1.2.3");
    const text = obfuscateReleaseSecret(secret, "1.2.3");
    for (const encoded of [secret.toString("hex"), secret.toString("base64"), secret.toString("base64url"), masterKey]) {
      assert.equal(text.includes(encoded), false, `module must not contain ${encoded.slice(0, 8)}…`);
    }
    // Not even a single stored chunk equals a chunk of the secret.
    for (let offset = 0; offset < 32; offset += 8) assert.equal(text.includes(secret.subarray(offset, offset + 8).toString("base64url")), false);
    const module = await load(text, root);
    assert.equal(module.version, "1.2.3");
    assert.deepEqual(Buffer.from(module.reveal()), secret);
    assert.notEqual(obfuscateReleaseSecret(secret, "1.2.3"), text, "the mask is random per build");
    const empty = await load(emptyReleaseModule("0.0.0-dev"), root);
    assert.equal(empty.reveal(), null);
    assert.equal(empty.version, "0.0.0-dev");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stable CI builds refuse to ship without a key; other builds get an untagged module", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-free-release-"));
  try {
    const outPath = path.join(root, "generated", "desktop-free-release.mjs");
    assert.throws(() => writeDesktopFreeReleaseModule({ masterKey: "", version: "1.2.3", outPath, ci: true }), /DESKTOP_FREE_RELEASE_KEY/);
    assert.deepEqual(writeDesktopFreeReleaseModule({ masterKey: "", version: "1.2.3", outPath, ci: false }), { tagged: false });
    assert.match(await readFile(outPath, "utf8"), /return null/);
    assert.deepEqual(writeDesktopFreeReleaseModule({ masterKey: undefined, version: "0.0.0-dev", outPath, ci: true }), { tagged: false });
    assert.deepEqual(writeDesktopFreeReleaseModule({ masterKey, version: "1.2.3", outPath, ci: true }), { tagged: true });
    const module = await import(outPath);
    assert.deepEqual(Buffer.from(module.reveal()), deriveReleaseSecret(masterKey, "1.2.3"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
