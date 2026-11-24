import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const imageLock = JSON.parse(readFileSync(resolve(here, "../../server/src/packaged-sandbox-image.json"), "utf8"));
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// OCI archive entries have fixed names, mode, ownership, ordering and timestamps.
// No Docker daemon, native SDK execution or build-machine image cache is used.
export function ociArchive(entries) {
  const chunks = [];
  for (const [name, value] of [...entries].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (Buffer.byteLength(name) > 100 || name.startsWith("/") || name.split("/").includes("..")) throw new Error("Invalid OCI archive entry.");
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    const octal = (offset, width, number) => header.write(`${number.toString(8).padStart(width - 1, "0")}\0`, offset, width);
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, bytes.length);
    octal(136, 12, 0);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

export async function preparePackagedSandboxImage(output, { arch = process.arch, fetchUrl = fetch, lock = imageLock } = {}) {
  const digest = lock.manifests[arch];
  if (!digest) throw new Error(`No pinned sandbox guest image for ${arch}.`);
  const reference = `${lock.repository}@${digest}`;
  const authResponse = await fetchUrl("https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/alpine:pull", { signal: AbortSignal.timeout(60_000) });
  if (!authResponse.ok) throw new Error(`Alpine registry authentication failed: ${authResponse.status}`);
  const { token } = await authResponse.json();
  if (typeof token !== "string") throw new Error("Alpine registry did not return a pull token.");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json" };
  async function download(kind, expectedDigest, expectedSize) {
    if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) throw new Error("Invalid pinned OCI digest.");
    const response = await fetchUrl(`https://registry-1.docker.io/v2/library/alpine/${kind}/${expectedDigest}`, { headers, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Pinned Alpine ${kind} download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== expectedDigest || expectedSize !== undefined && bytes.length !== expectedSize) throw new Error(`Pinned Alpine ${kind} integrity mismatch.`);
    return bytes;
  }
  const index = JSON.parse((await download("manifests", lock.indexDigest)).toString("utf8"));
  const descriptor = index.manifests.find((item) => item.digest === digest && item.platform?.os === "linux" && item.platform?.architecture === (arch === "x64" ? "amd64" : arch));
  if (!descriptor) throw new Error("Pinned Alpine platform manifest is absent from its pinned index.");
  const manifestBytes = await download("manifests", digest, descriptor.size);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const entries = new Map([
    ["oci-layout", JSON.stringify({ imageLayoutVersion: "1.0.0" })],
    ["index.json", JSON.stringify({ schemaVersion: 2, manifests: [{ ...descriptor, annotations: { "org.opencontainers.image.ref.name": reference } }] })],
    [`blobs/sha256/${digest.slice(7)}`, manifestBytes],
  ]);
  for (const blob of [manifest.config, ...manifest.layers]) entries.set(`blobs/sha256/${blob.digest.slice(7)}`, await download("blobs", blob.digest, blob.size));
  const archive = ociArchive(entries);
  const metadata = { schemaVersion: 1, arch, reference, manifestDigest: digest, archive: "alpine.oci.tar", archiveSha256: sha256(archive) };
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "alpine.oci.tar.pending"), archive);
  renameSync(join(output, "alpine.oci.tar.pending"), join(output, "alpine.oci.tar"));
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--outdir");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--outdir is required.");
  const target = process.env.TARGET ?? "";
  const arch = target.startsWith("x86_64-") ? "x64" : target.startsWith("aarch64-") ? "arm64" : process.arch;
  process.stdout.write(`${JSON.stringify(await preparePackagedSandboxImage(resolve(process.argv[index + 1]), { arch }))}\n`);
}
