import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { imageLock, preparePackagedSandboxImage } from "./prepare-packaged-sandbox-image.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function fixture(t, { corruptLayer = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pinned-sandbox-image-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = Buffer.from(JSON.stringify({ architecture: "arm64", os: "linux", rootfs: { type: "layers", diff_ids: [] } }));
  const layer = Buffer.from("compressed layer fixture");
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: sha(config), size: config.length }, layers: [{ digest: sha(layer), size: layer.length }] }));
  const descriptor = { digest: sha(manifest), size: manifest.length, mediaType: "application/vnd.oci.image.manifest.v1+json", platform: { architecture: "arm64", os: "linux" } };
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [descriptor] }));
  const lock = { repository: "docker.io/library/alpine", indexDigest: sha(index), manifests: { arm64: sha(manifest) } };
  const responses = new Map([[sha(index), index], [sha(manifest), manifest], [sha(config), config], [sha(layer), corruptLayer ? Buffer.from("tampered") : layer]]);
  const requests = [];
  const fetchUrl = async (url) => {
    requests.push(url);
    if (url.startsWith("https://auth.docker.io/token?")) return Response.json({ token: "fixture-public-pull-token" });
    const bytes = responses.get(url.split("/").at(-1));
    assert.ok(bytes, `Unexpected network target: ${url}`);
    return new Response(bytes);
  };
  return { root, lock, requests, options: { arch: "arm64", fetchUrl, lock } };
}

test("pinned Alpine manifests specify both Linux guest architectures and immutable digests", () => {
  assert.equal(imageLock.tag, "3.22");
  for (const digest of [imageLock.indexDigest, imageLock.manifests.arm64, imageLock.manifests.x64]) assert.match(digest, /^sha256:[a-f0-9]{64}$/);
});

test("image provisioning is deterministic and closes over verified manifests, config and layers without host caches", async (t) => {
  const { root, lock, options, requests } = fixture(t);
  const first = await preparePackagedSandboxImage(join(root, "first"), options);
  const second = await preparePackagedSandboxImage(join(root, "second"), options);
  assert.deepEqual(first, second);
  const archive = readFileSync(join(root, "first/alpine.oci.tar"));
  assert.deepEqual(archive, readFileSync(join(root, "second/alpine.oci.tar")));
  assert.equal(sha(archive), first.archiveSha256);
  assert.equal(first.reference, `${lock.repository}@${lock.manifests.arm64}`);
  const names = [];
  for (let offset = 0; offset < archive.length - 1024;) {
    const header = archive.subarray(offset, offset + 512);
    names.push(header.subarray(0, 100).toString().replace(/\0.*$/, ""));
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, ""), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(names.includes("oci-layout"));
  assert.ok(names.includes("index.json"));
  assert.equal(names.filter((name) => name.startsWith("blobs/sha256/")).length, 3);
  assert.equal(requests.length, 10);
});

test("a registry serving altered pinned bytes fails before publishing any image archive", async (t) => {
  const { root, options } = fixture(t, { corruptLayer: true });
  await assert.rejects(preparePackagedSandboxImage(root, options), /integrity mismatch/);
  assert.equal(existsSync(join(root, "alpine.oci.tar")), false);
});

test("unsupported guest architecture fails before making any registry request", async (t) => {
  const { root, options, requests } = fixture(t);
  await assert.rejects(preparePackagedSandboxImage(root, { ...options, arch: "unsupported" }), /No pinned sandbox guest image/);
  assert.equal(requests.length, 0);
});
