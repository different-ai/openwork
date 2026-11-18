import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { once } from "node:events"
import { Buffer } from "node:buffer"
import { gzipSync, gunzipSync } from "node:zlib"
import { inspectInstallerBundle } from "../src/managed-deployments/release-verifier.js"
import { boundedReleaseGet, InstallerReleaseError, installerSourceBaseUrl, latestInstallerVersion, sha256, verifyInstallerRelease } from "../src/managed-deployments/release-verifier.js"
import { fixtureArtifacts, fixtureFetch, gcpSource, source } from "./api/managed-installer-fixtures.js"

test("latest stable discovery requests GitHub JSON rather than the artifact download media type", async () => {
  const accepted: string[] = []
  const server = createServer((request, response) => {
    accepted.push(request.headers.accept ?? "")
    assert.equal(request.headers.authorization, undefined)
    response.writeHead(request.headers.accept === "application/vnd.github+json" ? 200 : 415, { "content-type": "application/json" })
    response.end(JSON.stringify({ tag_name: "v1.2.3", draft: false, prerelease: false, html_url: "https://github.com/different-ai/openwork/releases/tag/v1.2.3" }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  try {
    const transport: typeof fetch = async (input, init) => {
      assert.equal(input, "https://api.github.com/repos/different-ai/openwork/releases/latest")
      return fetch(`http://127.0.0.1:${address.port}/latest`, init)
    }
    assert.deepEqual(await latestInstallerVersion(transport), { version: "1.2.3", url: "https://github.com/different-ai/openwork/releases/tag/v1.2.3" })
    assert.deepEqual(accepted, ["application/vnd.github+json"])
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test("real streamed HTTP bodies are bounded and redirects are refused through the scoped transport", async () => {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/redirect")) { response.writeHead(302, { location: "http://169.254.169.254/latest/" }); response.end(); return }
    response.writeHead(200, { "x-amz-version-id": "fixture-version" })
    response.write("x".repeat(20_000))
    response.end("x".repeat(20_000))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  try {
    for (const pathname of ["/oversized", "/redirect"]) {
      const transport: typeof fetch = async (_input, init) => fetch(`http://127.0.0.1:${address.port}${pathname}`, init)
      await assert.rejects(verifyInstallerRelease("aws", source, "1.2.3", transport))
    }
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test("archive validation rejects traversal, duplicate/unknown types, damaged checksums and gzip expansion bombs", () => {
  const bundle = fixtureArtifacts().get("bundle.tar.gz")
  assert.ok(bundle)
  for (const attack of ["traversal", "symlink", "unknown", "duplicate", "checksum"]) {
    const tar = Buffer.from(gunzipSync(new Uint8Array(bundle)))
    const offset = attack === "duplicate" ? 1024 : 0
    const header = tar.subarray(offset, offset + 512)
    if (attack === "traversal") { header.fill(0, 0, 100); header.write("../outside", 0) }
    if (attack === "duplicate") { header.fill(0, 0, 100); header.write("main.tf", 0) }
    if (attack === "symlink") header[156] = 50
    if (attack === "unknown") header[156] = 120
    if (attack !== "checksum") {
      header.fill(32, 148, 156)
      const checksum = header.reduce((sum, byte) => sum + byte, 0)
      header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148)
    } else { header[0] = 88 }
    assert.throws(() => inspectInstallerBundle("aws", "1.2.3", Buffer.from(gzipSync(new Uint8Array(tar)))))
  }
  const bomb = Buffer.from(gzipSync(new Uint8Array(65 * 1024 * 1024)))
  assert.throws(() => inspectInstallerBundle("aws", "1.2.3", bomb))
})

test("tar checksum requires a complete octal field and legal padding, never a parseInt prefix", () => {
  const bundle = fixtureArtifacts().get("bundle.tar.gz")
  assert.ok(bundle)
  const original = Buffer.from(gunzipSync(new Uint8Array(bundle)))
  const digits = original.subarray(148, 154).toString("latin1")
  for (const field of [`${digits}x `, `${digits}8 `, `${digits}\0x`, `${digits}9\0`, `${digits}\u0080 `]) {
    const tar = Buffer.from(original)
    tar.write(field, 148, 8, "latin1")
    assert.throws(() => inspectInstallerBundle("aws", "1.2.3", Buffer.from(gzipSync(new Uint8Array(tar)))), /checksum field/)
  }
  for (const field of [`${digits}\0 `, ` ${digits} `, `0${digits} `]) {
    const tar = Buffer.from(original)
    tar.write(field, 148, 8, "latin1")
    assert.equal(inspectInstallerBundle("aws", "1.2.3", Buffer.from(gzipSync(new Uint8Array(tar)))).length, 5)
  }
})

test("only exact public provider object-store sources, preserving prefix", () => {
  assert.equal(installerSourceBaseUrl("aws", source.slice(0, -1)), source)
  assert.equal(installerSourceBaseUrl("gcp", "https://storage.googleapis.com/example-bucket/releases/gcp"), "https://storage.googleapis.com/example-bucket/releases/gcp/")
  for (const value of ["http://127.0.0.1/releases/", "https://169.254.169.254/latest/", "https://localhost/releases/", "https://bucket.s3.us-east-1.amazonaws.com.evil.test/", "https://user:password@bucket.s3.us-east-1.amazonaws.com/", "https://bucket.s3.us-east-1.amazonaws.com:444/", source + "../other/", source + "%2e%2e/", source + "?token=secret", source + "#fragment"]) assert.throws(() => installerSourceBaseUrl("aws", value))
})

test("GCP uses tutorial.md, real generation pins and its existing three-service inventory", async () => {
  const fetcher = fixtureFetch(new Map([["1.2.3", fixtureArtifacts("1.2.3", { provider: "gcp" })]]), { provider: "gcp" })
  const verified = await verifyInstallerRelease("gcp", gcpSource, "1.2.3", fetcher)
  assert.deepEqual(verified.services, ["den_api", "den_web", "health"])
  assert.match(verified.release.templateUrl, /tutorial\.md\?generation=1234567890$/)
})

test("verifies all objects twice and complete immutable five-image runtime inventory", async () => {
  const verified = await verifyInstallerRelease("aws", source, "1.2.3", fixtureFetch())
  assert.equal(verified.services.length, 5)
  assert.match(verified.release.bundleUrl, /versionId=/)
  assert.match(verified.manifestUrl, /versionId=/)
  assert.equal(verified.manifestSha256.length, 64)
})

test("rejects missing real immutable version, changed versioned bytes, hashes and legacy core-only bundles", async () => {
  for (const fetcher of [fixtureFetch(undefined, { noVersion: true }), fixtureFetch(undefined, { changed: true }), fixtureFetch(new Map([["1.2.3", fixtureArtifacts("1.2.3", { corrupt: true })]])), fixtureFetch(new Map([["1.2.3", fixtureArtifacts("1.2.3", { coreOnly: true })]]))]) await assert.rejects(verifyInstallerRelease("aws", source, "1.2.3", fetcher))
})

test("object failures identify the artifact and distinguish forbidden from missing without exposing provider bodies", async () => {
  for (const name of ["manifest.json", "cloudformation.json", "bundle.tar.gz"]) {
    for (const status of [403, 404, 500]) {
      const original = fixtureFetch()
      const failing: typeof fetch = async (input, init) => String(input).includes(`/${name}`) ? new Response("private provider error with credentials", { status }) : original(input, init)
      await assert.rejects(verifyInstallerRelease("aws", source, "1.2.3", failing), (error: unknown) => {
        assert.ok(error instanceof InstallerReleaseError)
        assert.equal(error.code, "artifact_unavailable")
        assert.equal(error.status, status === 403 || status === 404 ? 400 : 502)
        assert.ok(error.message.includes(name))
        assert.ok(error.message.includes(`HTTP ${status}`))
        assert.ok(!error.message.includes("credentials"))
        assert.ok(!error.message.includes(source))
        if (status === 403) assert.match(error.message, /may be unpublished or private/)
        if (status === 404) assert.match(error.message, /not found/)
        return true
      })
    }
  }
})

test("download diagnostics distinguish deadlines, transport failures and declared or streamed size limits", async () => {
  const failing: typeof fetch = async () => { throw new Error("private transport detail") }
  const cases = [
    { fetcher: failing, signal: AbortSignal.abort(), code: "artifact_unavailable", message: /deadline/ },
    { fetcher: failing, signal: new AbortController().signal, code: "artifact_unavailable", message: /public read access/ },
    { fetcher: async () => new Response("secret", { headers: { "content-length": "100" } }), signal: new AbortController().signal, code: "artifact_too_large", message: /size limit/ },
    { fetcher: async () => new Response("secret"), signal: new AbortController().signal, code: "artifact_too_large", message: /size limit/ },
    { fetcher: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("private transport detail")) } })), signal: AbortSignal.abort(), code: "artifact_unavailable", message: /deadline/ },
  ] satisfies { fetcher: typeof fetch, signal: AbortSignal, code: string, message: RegExp }[]
  for (const entry of cases) await assert.rejects(boundedReleaseGet(`${source}1.2.3/bundle.tar.gz`, 3, entry.signal, entry.fetcher), (error: unknown) => {
    assert.ok(error instanceof InstallerReleaseError)
    assert.equal(error.code, entry.code)
    assert.equal(error.status, 502)
    assert.match(error.message, /bundle\.tar\.gz/)
    assert.match(error.message, entry.message)
    assert.doesNotMatch(error.message, /secret|private transport detail/)
    return true
  })
})

test("manifest, object checksum and runtime inventory failures retain safe actionable diagnostics", async () => {
  for (const entry of [
    { kind: "manifest-json", code: "manifest_invalid", message: /manifest\.json.*protocolVersion 1/ },
    { kind: "manifest-protocol", code: "manifest_invalid", message: /protocolVersion 1/ },
    { kind: "manifest-identity", code: "manifest_identity_mismatch", message: /selected provider and version/ },
    { kind: "template-checksum", code: "artifact_checksum_mismatch", message: /cloudformation\.json.*templateSha256/ },
    { kind: "bundle-checksum", code: "artifact_checksum_mismatch", message: /bundle\.tar\.gz.*bundleSha256/ },
    { kind: "runtime-inventory", code: "runtime_inventory_mismatch", message: /den_api, den_web, headless_runner, workbot, ai_gateway/ },
    { kind: "runtime-digest", code: "runtime_image_unpinned", message: /den_api.*@sha256:/ },
    { kind: "archive", code: "bundle_invalid", message: /regular-file archive/ },
  ]) {
    const artifacts = fixtureArtifacts("1.2.3", { coreOnly: entry.kind === "runtime-inventory", imageDigest: entry.kind === "runtime-digest" ? "invalid-private-image" : undefined })
    const manifest = artifacts.get("manifest.json")
    assert.ok(manifest)
    if (entry.kind === "manifest-json") artifacts.set("manifest.json", Buffer.from("private malformed json"))
    if (entry.kind === "manifest-protocol") artifacts.set("manifest.json", Buffer.from(manifest.toString().replace('"protocolVersion":1', '"protocolVersion":2')))
    if (entry.kind === "manifest-identity") artifacts.set("manifest.json", Buffer.from(manifest.toString().replace('"provider":"aws"', '"provider":"gcp"')))
    if (entry.kind === "template-checksum") artifacts.set("cloudformation.json", Buffer.from("private mismatching template"))
    if (entry.kind === "bundle-checksum") artifacts.set("bundle.tar.gz", Buffer.from("private mismatching bundle"))
    if (entry.kind === "archive") {
      const bundle = Buffer.from("private invalid gzip")
      const oldBundle = artifacts.get("bundle.tar.gz")
      assert.ok(oldBundle)
      artifacts.set("bundle.tar.gz", bundle)
      artifacts.set("manifest.json", Buffer.from(manifest.toString().replace(sha256(oldBundle), sha256(bundle))))
    }
    await assert.rejects(verifyInstallerRelease("aws", source, "1.2.3", fixtureFetch(new Map([["1.2.3", artifacts]]))), (error: unknown) => {
      assert.ok(error instanceof InstallerReleaseError)
      assert.equal(error.code, entry.code)
      assert.equal(error.status, 502)
      assert.match(error.message, entry.message)
      assert.doesNotMatch(error.message, /private/)
      return true
    })
  }
})

test("rejects oversized objects, fetch errors and pre-release candidates without leaking remote response bodies", async () => {
  const oversized: typeof fetch = async () => new Response("private remote failure", { headers: { "content-length": "999999999" } })
  const failing: typeof fetch = async () => { throw new Error("private remote failure") }
  for (const fetcher of [oversized, failing]) await assert.rejects(verifyInstallerRelease("aws", source, "1.2.3", fetcher), (error: Error) => !error.message.includes("private remote failure"))
  await assert.rejects(verifyInstallerRelease("aws", source, "1.2.3-beta.1", fixtureFetch()))
})
