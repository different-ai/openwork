import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"
import { z } from "zod"
import type { ManagedInstallerProvider } from "@openwork/types/den/managed-installer-releases"

export class InstallerReleaseError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 400 | 403 | 409 | 502 | 503 = 400) { super(message) }
}
export const sha256 = (value: string | Buffer) => createHash("sha256").update(typeof value === "string" ? value : new Uint8Array(value)).digest("hex")
const stable = z.string().max(80).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const manifestSchema = z.object({ provider: z.enum(["aws", "gcp"]), version: stable, protocolVersion: z.literal(1), bundleSha256: hash, templateSha256: hash }).strict()
const invalid = () => new InstallerReleaseError("invalid_source", "Use a public regional S3 or Google Cloud Storage release prefix without credentials, query parameters or encoded paths.")

export function installerSourceBaseUrl(provider: ManagedInstallerProvider, input: string) {
  if (!URL.canParse(input) || /[%\\\s]/.test(input) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(input)) throw invalid()
  const url = new URL(input)
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) throw invalid()
  const bucket = "[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]"
  if (provider === "aws" ? !new RegExp(`^${bucket}\\.s3\\.[a-z]{2}(?:-[a-z]+)+-[1-9]\\.amazonaws\\.com$`).test(url.hostname)
    : url.hostname !== "storage.googleapis.com" || !new RegExp(`^/${bucket}(?:/|$)`).test(url.pathname)) throw invalid()
  if (!/^\/[a-zA-Z0-9/_.,@+=-]*$/.test(url.pathname) || url.pathname.includes("//")) throw invalid()
  url.pathname = url.pathname.replace(/\/*$/, "/")
  return url.href
}

export function immutableInstallerUrl(provider: ManagedInstallerProvider, input: string) {
  if (!URL.canParse(input)) return false
  const url = new URL(input)
  const key = provider === "aws" ? "versionId" : "generation"
  const values = url.searchParams.getAll(key)
  if (values.length !== 1 || [...url.searchParams.keys()].some((entry) => entry !== key)) return false
  const value = values[0]
  if (!value || (provider === "aws" ? !/^[A-Za-z0-9_.~+\/-]{1,1024}$/.test(value) || value === "null" : !/^[1-9]\d{0,24}$/.test(value))) return false
  url.search = ""
  try { installerSourceBaseUrl(provider, url.href); return true } catch { return false }
}

export function inferInstallerSource(provider: ManagedInstallerProvider, templateUrl: string | undefined) {
  if (!templateUrl || !URL.canParse(templateUrl)) return null
  const url = new URL(templateUrl)
  url.search = ""
  const suffix = new RegExp(`/[0-9]+\\.[0-9]+\\.[0-9]+/${provider === "aws" ? "cloudformation\\.json" : "tutorial\\.md"}$`)
  if (!suffix.test(url.pathname)) return null
  url.pathname = url.pathname.replace(suffix, "/")
  try { return installerSourceBaseUrl(provider, url.href) } catch { return null }
}

/** One deadline includes response headers and all streamed bodies. No redirects or ambient credentials. */
export async function boundedReleaseGet(url: string, max: number, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const response = await fetcher(url, { redirect: "error", signal, credentials: "omit", headers: { accept: "application/octet-stream" } })
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > max) throw new InstallerReleaseError("artifact_unavailable", "A release object is unavailable or exceeds its size limit.", 502)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > max) throw new InstallerReleaseError("artifact_too_large", "A release object exceeds its size limit.", 502)
      chunks.push(next.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  return { body: Buffer.concat(chunks), headers: response.headers }
}

async function immutableGet(provider: ManagedInstallerProvider, input: string, max: number, signal: AbortSignal, fetcher: typeof fetch) {
  const first = await boundedReleaseGet(input, max, signal, fetcher)
  const value = first.headers.get(provider === "aws" ? "x-amz-version-id" : "x-goog-generation")
  if (!value || (provider === "aws" ? !/^[A-Za-z0-9_.~+\/-]{1,1024}$/.test(value) || value === "null" : !/^[1-9]\d{0,24}$/.test(value))) throw new InstallerReleaseError("immutable_version_required", "Enable public object versioning and publish an immutable release before validating.", 400)
  const url = new URL(input)
  url.searchParams.set(provider === "aws" ? "versionId" : "generation", value)
  const frozen = await boundedReleaseGet(url.href, max, signal, fetcher)
  if (sha256(first.body) !== sha256(frozen.body)) throw new InstallerReleaseError("artifact_changed", "The immutable object does not match the published object. Publish a new release.", 409)
  return { url: url.href, body: frozen.body }
}

const repositories = {
  den_api: "ghcr.io/different-ai/openwork-den-api", den_web: "ghcr.io/different-ai/openwork-den-web",
  headless_runner: "ghcr.io/different-ai/openwork-headless-runner", workbot: "ghcr.io/different-ai/openwork-workbot", ai_gateway: "ghcr.io/different-ai/openwork-inference",
}

/** Inspect the publisher's regular-file archive without writing or executing its contents. */
export function inspectInstallerBundle(provider: ManagedInstallerProvider, version: string, compressed: Buffer) {
  const tar = gunzipSync(new Uint8Array(compressed), { maxOutputLength: 64 * 1024 * 1024 })
  const files = new Map<string, Buffer>()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > tar.length || !tar.subarray(offset).every((byte) => byte === 0)) throw new Error("Invalid archive terminator")
      break
    }
    const text = (start: number, end: number) => header.subarray(start, end).toString().replace(/\0.*$/s, "")
    const name = `${text(345, 500) ? text(345, 500) + "/" : ""}${text(0, 100)}`
    const octalField = (start: number, end: number) => {
      const field = header.subarray(start, end).toString("latin1")
      if (!/^ *[0-7]+[\0 ]*$/.test(field)) throw new Error("Invalid archive numeric field")
      return Number.parseInt(field.trim(), 8)
    }
    const size = octalField(124, 136)
    for (const start of [100, 108, 116]) octalField(start, start + 8)
    octalField(136, 148)
    const type = header[156]
    const checksumField = header.subarray(148, 156).toString("latin1")
    if (!/^ *[0-7]+[\0 ]+$/.test(checksumField)) throw new Error("Invalid archive checksum field")
    const checksum = Number.parseInt(checksumField.trim(), 8)
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (text(257, 263) !== "ustar" || actual !== checksum || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size + 1024 > tar.length || !name || name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..") || files.has(name) || (type !== 0 && type !== 48)) throw new Error("Invalid archive")
    files.set(name, tar.subarray(offset + 512, offset + 512 + size))
    if (files.size > 2048) throw new Error("Archive limit")
    offset += 512 + Math.ceil(size / 512) * 512
  }
  const release = z.object({ provider: z.literal(provider), version: z.literal(version), protocolVersion: z.literal(1), files: z.record(z.string(), hash), images: z.record(z.string(), z.string()) }).strict().parse(JSON.parse(files.get("release.json")?.toString() ?? "null"))
  const expected = provider === "aws" ? repositories : { den_api: repositories.den_api, den_web: repositories.den_web, health: "docker.io/library/python" }
  if (Object.keys(release.images).sort().join() !== Object.keys(expected).sort().join()) throw new Error("Incomplete runtime inventory")
  for (const [key, repository] of Object.entries(expected)) {
    const pin = release.images[key]
    if (!pin?.startsWith(repository + "@sha256:") || !/^[a-f0-9]{64}$/.test(pin.slice(repository.length + 8))) throw new Error("Unpinned runtime image")
  }
  if (!Object.keys(release.files).length || Object.keys(release.files).length !== files.size - 1) throw new Error("Incomplete checksum inventory")
  for (const [name, digest] of Object.entries(release.files)) {
    const file = files.get(name)
    if (!file || sha256(file) !== digest) throw new Error("File checksum mismatch")
  }
  return Object.keys(expected)
}

export async function verifyInstallerRelease(provider: ManagedInstallerProvider, source: string, version: string, fetcher: typeof fetch = fetch) {
  const base = installerSourceBaseUrl(provider, source)
  stable.parse(version)
  const signal = AbortSignal.timeout(5000)
  try {
    const manifest = await immutableGet(provider, `${base}${version}/manifest.json`, 32768, signal, fetcher)
    const parsed = manifestSchema.parse(JSON.parse(manifest.body.toString()))
    if (parsed.provider !== provider || parsed.version !== version) throw new Error("Manifest identity mismatch")
    const [template, bundle] = await Promise.all([
      immutableGet(provider, `${base}${version}/${provider === "aws" ? "cloudformation.json" : "tutorial.md"}`, 1024 * 1024, signal, fetcher),
      immutableGet(provider, `${base}${version}/bundle.tar.gz`, 16 * 1024 * 1024, signal, fetcher),
    ])
    if (sha256(template.body) !== parsed.templateSha256 || sha256(bundle.body) !== parsed.bundleSha256) throw new Error("Artifact checksum mismatch")
    const services = inspectInstallerBundle(provider, version, bundle.body)
    return { release: { version, templateUrl: template.url, bundleUrl: bundle.url, bundleSha256: parsed.bundleSha256 }, services, manifestUrl: manifest.url, manifestSha256: sha256(manifest.body), templateSha256: parsed.templateSha256 }
  } catch (error) {
    if (error instanceof InstallerReleaseError) throw error
    throw new InstallerReleaseError("release_verification_failed", "Release verification failed. Check public immutable objects, checksums, protocol and complete digest-pinned runtime images.", 502)
  }
}

export async function verifyFrozenInstallerRelease(input: { provider: ManagedInstallerProvider, manifest_url: string, template_sha256: string, validation: { manifestSha256: string, release: { templateUrl: string, bundleUrl: string, bundleSha256: string } } }, fetcher: typeof fetch = fetch) {
  const signal = AbortSignal.timeout(5000)
  try {
    const coordinates = input.validation.release
    if (![input.manifest_url, coordinates.templateUrl, coordinates.bundleUrl].every((url) => immutableInstallerUrl(input.provider, url))) throw new Error("Invalid immutable coordinates")
    const objects = await Promise.all([
      boundedReleaseGet(input.manifest_url, 32768, signal, fetcher), boundedReleaseGet(coordinates.templateUrl, 1024 * 1024, signal, fetcher), boundedReleaseGet(coordinates.bundleUrl, 16 * 1024 * 1024, signal, fetcher),
    ])
    const [manifest, template, bundle] = objects
    if (!manifest || !template || !bundle || sha256(manifest.body) !== input.validation.manifestSha256 || sha256(template.body) !== input.template_sha256 || sha256(bundle.body) !== coordinates.bundleSha256) throw new Error("Changed")
  } catch { throw new InstallerReleaseError("validated_release_unavailable", "The validated immutable release is no longer available or its bytes changed. Validate a newly published release.", 502) }
}
