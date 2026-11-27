import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { resolveArtifactStorageConfig } from "../src/mcp-app-storage/config.js"

const defaults = {
  backend: undefined,
  localDir: undefined,
  celldUrl: undefined,
  celldToken: undefined,
  maxBytes: undefined,
  maxRows: undefined,
  devMode: false,
}
const celld = { ...defaults, backend: " celld ", celldUrl: "https://storage.example.test/", celldToken: "t".repeat(24) }

test("development defaults to local files under the system temp directory", () => {
  const config = resolveArtifactStorageConfig({ ...defaults, devMode: true })
  assert.deepEqual(config.backend, { kind: "local", directory: path.join(os.tmpdir(), "openwork-den-artifact-storage") })
  assert.equal(config.maxBytes, 20 * 1024 * 1024)
  assert.equal(config.maxRows, 10_000)
})

test("production with no backend is unavailable with a reason", () => {
  const config = resolveArtifactStorageConfig(defaults)
  assert.equal(config.backend, null)
  assert.match(config.unavailableReason ?? "", /DEN_ARTIFACT_STORAGE_BACKEND is not set/u)
})

test("celld requires a token of at least 24 characters and an absolute HTTP(S) URL", () => {
  assert.deepEqual(resolveArtifactStorageConfig(celld).backend, { kind: "celld", url: "https://storage.example.test", token: celld.celldToken })
  assert.equal(resolveArtifactStorageConfig({ ...celld, celldUrl: "http://localhost:9876" }).backend?.kind, "celld")
  assert.throws(() => resolveArtifactStorageConfig({ ...celld, celldUrl: undefined }), /needs.*URL.*TOKEN/u)
  assert.throws(() => resolveArtifactStorageConfig({ ...celld, celldToken: " " }), /needs.*URL.*TOKEN/u)
  assert.throws(() => resolveArtifactStorageConfig({ ...celld, celldToken: "t".repeat(23) }), /at least 24/u)
  for (const celldUrl of ["/storage", "file:///storage", "ftp://storage.example.test"]) {
    assert.throws(() => resolveArtifactStorageConfig({ ...celld, celldUrl }), /absolute http or https/u)
  }
})

test("celld rejects credentials, query strings and fragments", () => {
  for (const celldUrl of ["http://user@host", "http://:password@host", "http://host/?key=value", "http://host/#section", "http://host/?", "http://host/#"]) {
    assert.throws(() => resolveArtifactStorageConfig({ ...celld, celldUrl }), /DEN_ARTIFACT_STORAGE_CELLD_URL must not contain credentials, a query string, or a fragment/u)
  }
  assert.equal(resolveArtifactStorageConfig({ ...celld, celldUrl: "http://host/storage%3F%23" }).backend?.kind, "celld")
})

test("local is available only in dev mode", () => {
  const local = { ...defaults, backend: "local", localDir: " .runtime/storage " }
  const config = resolveArtifactStorageConfig(local)
  assert.equal(config.backend, null)
  assert.match(config.unavailableReason ?? "", /refused outside dev mode\. Use celld instead/u)
  assert.deepEqual(resolveArtifactStorageConfig({ ...local, devMode: true }).backend, { kind: "local", directory: path.resolve(".runtime/storage") })
})

test("rejects unknown backend names", () => {
  assert.throws(() => resolveArtifactStorageConfig({ ...defaults, backend: "sqlite" }), /must be celld or local/u)
})

test("parses limits and rejects fractions, non-numbers, zero and values over their maxima", () => {
  const bounds = resolveArtifactStorageConfig({ ...defaults, maxBytes: " 1073741824 ", maxRows: " 1000000 " })
  assert.equal(bounds.maxBytes, 1_073_741_824)
  assert.equal(bounds.maxRows, 1_000_000)
  assert.equal(resolveArtifactStorageConfig({ ...defaults, maxBytes: "1", maxRows: "1" }).maxBytes, 1)
  for (const value of ["1.5", "no", "Infinity", "0", "-1", "1073741825"]) {
    assert.throws(() => resolveArtifactStorageConfig({ ...defaults, maxBytes: value }), /DEN_ARTIFACT_STORAGE_MAX_BYTES must be a whole number/u)
  }
  for (const value of ["1.5", "no", "Infinity", "0", "-1", "1000001"]) {
    assert.throws(() => resolveArtifactStorageConfig({ ...defaults, maxRows: value }), /DEN_ARTIFACT_STORAGE_MAX_ROWS must be a whole number/u)
  }
})
