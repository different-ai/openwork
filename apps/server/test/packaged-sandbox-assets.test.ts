import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { prepareSandboxGuestImage, sandboxImagePin, type SandboxImageSdk } from "../src/packaged-sandbox-assets.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "packaged-sandbox-image-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "sandbox-image");
  await mkdir(directory);
  const archive = Buffer.from("immutable OCI archive fixture");
  const pin = sandboxImagePin("arm64");
  const manifest = { arch: "arm64", ...pin, archiveSha256: `sha256:${createHash("sha256").update(archive).digest("hex")}` };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "alpine.oci.tar"), archive);
  let present = false;
  let loads = 0;
  const sdk: SandboxImageSdk = {
    setDefaultBackend(backend) { assert.equal(backend, "local"); },
    Image: {
      async get(reference) {
        assert.equal(reference, pin.reference);
        if (!present) throw Object.assign(new Error("image not found"), { code: "imageNotFound" });
        return { manifestDigest: pin.manifestDigest };
      },
      async load(path, options) {
        assert.equal(path, join(directory, "alpine.oci.tar"));
        assert.equal(options.tag, pin.reference);
        loads++;
        present = true;
      },
    },
  };
  return { root, directory, sdk, pin, manifest, loads: () => loads };
}

test("a fresh home imports the bundled pinned image before guest creation without registry access", async (t) => {
  const { root, sdk, pin, loads } = await fixture(t);
  assert.equal(await prepareSandboxGuestImage(sdk, root, "arm64"), pin.reference);
  assert.equal(loads(), 1);
  assert.equal(await prepareSandboxGuestImage(sdk, root, "arm64"), pin.reference);
  assert.equal(loads(), 1);
});

test("a missing packaged archive fails closed even with a warm image cache", async (t) => {
  const { root, directory, sdk, loads } = await fixture(t);
  await prepareSandboxGuestImage(sdk, root, "arm64");
  await rm(join(directory, "alpine.oci.tar"));
  await assert.rejects(prepareSandboxGuestImage(sdk, root, "arm64"), /ENOENT/);
  assert.equal(loads(), 1);
});

test("wrong-architecture or tampered image assets cannot start a packaged guest", async (t) => {
  const { root, directory, sdk, loads } = await fixture(t);
  await assert.rejects(prepareSandboxGuestImage(sdk, root, "x64"), /pinned platform image/);
  await writeFile(join(directory, "alpine.oci.tar"), "changed");
  await assert.rejects(prepareSandboxGuestImage(sdk, root, "arm64"), /integrity verification/);
  assert.equal(loads(), 0);
});

test("imported image digest is verified and database failures do not trigger a download fallback", async (t) => {
  const { root, sdk } = await fixture(t);
  sdk.Image.get = async () => { throw new Error("database failure"); };
  await assert.rejects(prepareSandboxGuestImage(sdk, root, "arm64"), /database failure/);
  let first = true;
  sdk.Image.get = async () => {
    if (first) { first = false; throw Object.assign(new Error("missing"), { code: "imageNotFound" }); }
    return { manifestDigest: "sha256:wrong" };
  };
  await assert.rejects(prepareSandboxGuestImage(sdk, root, "arm64"), /imported sandbox guest image/);
});
