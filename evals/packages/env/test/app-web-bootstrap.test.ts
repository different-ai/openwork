import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seedSyntheticPreactivatedDen } from "../src/app-web-bootstrap.ts";

test("synthetic preactivation defaults off without creating installation state", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-bootstrap-default-"));
  try {
    assert.deepEqual(await seedSyntheticPreactivatedDen(root), {});
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("synthetic preactivation writes only the fresh owned config and never overwrites it", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-bootstrap-owned-"));
  try {
    const config = join(root, "config", "openwork");
    await mkdir(config, { recursive: true });
    const origin = "https://synthetic-den.example:8443";
    const env = await seedSyntheticPreactivatedDen(root, origin);
    const path = join(config, "desktop-bootstrap.json");
    assert.deepEqual(env, { OPENWORK_DESKTOP_BOOTSTRAP_PATH: path });
    const source = await readFile(path, "utf8");
    const body = JSON.parse(source);
    assert.equal(body.enterpriseActivation.denBaseUrl, origin);
    assert.ok(Number.isFinite(Date.parse(body.enterpriseActivation.activatedAt)));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), ["config"]);
    assert.deepEqual(await readdir(config), ["desktop-bootstrap.json"]);
    await assert.rejects(seedSyntheticPreactivatedDen(root, "https://different-synthetic.example"), { code: "EEXIST" });
    assert.equal(await readFile(path, "utf8"), source);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("synthetic preactivation refuses nonexact or insecure origins before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-bootstrap-invalid-"));
  try {
    for (const origin of ["http://synthetic.example", "https://synthetic.example/", "https://synthetic.example/path", "https://synthetic.example?token=no", "https://synthetic.example#fragment", "https://user:password@synthetic.example", "not-a-url"]) {
      await assert.rejects(seedSyntheticPreactivatedDen(root, origin));
    }
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
