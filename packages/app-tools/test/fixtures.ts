import {
  PACKAGE_MANIFEST_PATH,
  PACKAGE_METADATA_PATH,
  stringifyJsonCanonical,
  type AppManifest,
  type PackageProvenance,
} from "@openwork/app-contract"

import { packApp, type PackResult } from "../src/pack.js"

export const PROVENANCE: PackageProvenance = {
  repository: "https://github.com/different-ai/openwork-station",
  release_tag: "v1.0.0",
  commit: "a".repeat(40),
}

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>'
const SURFACE_HTML = "<!doctype html><title>Station</title><div id=\"root\"></div>"
const BACKGROUND_JS = "export function activate() {}\n"

/** A small but complete app: manifest, one surface, one background module, one icon. */
export function sampleManifest(): AppManifest {
  return {
    manifest_version: 1,
    id: "com.openworklabs.station",
    name: "OpenWork Station",
    description: "Ambient assistant that prepares context at the edge of the screen.",
    version: "1.0.0",
    publisher: { name: "OpenWork Labs" },
    repository: "https://github.com/different-ai/openwork-station",
    license: "MIT",
    icons: { default: "assets/icon.svg" },
    engines: { openwork: { min: "0.1.0" }, app_api: { min: "1.0.0", max_exclusive: "2.0.0" } },
    platforms: [{ os: "darwin", arch: ["arm64", "x64"] }],
    distribution: {
      type: "github-release",
      repository: "https://github.com/different-ai/openwork-station",
      asset: "openwork-station-{version}.owapp",
    },
    entrypoints: { background: "dist/background.js", surfaces: { station: "dist/station.html" } },
    contributions: [
      {
        type: "surface",
        id: "station",
        entrypoint: "station",
        presentation: "floating",
        default_size: { width: 360, height: 220 },
      },
      {
        type: "right_sidebar_item",
        id: "station-rail",
        label: "Station",
        surface: "station",
        icon: "assets/icon.svg",
      },
      { type: "background", id: "station-agent", entrypoint: "background" },
    ],
    permissions: [
      { id: "runtime.background.continuous", reason: "Watch for useful moments." },
      { id: "desktop.floatingSurface", reason: "Show a small island.", always_on_top: true },
      { id: "network.host", reason: "Reach the model endpoint.", hosts: ["api.openai.com"] },
      { id: "ai.realtime", reason: "Transcribe speech." },
    ],
    environment: { required: [], optional: [] },
    privacy: {
      summary: "Nothing is stored.",
      data_handled: ["transcripts"],
      retention: { policy: "session", description: "Dropped when listening stops." },
      third_parties: [{ name: "OpenAI", host: "api.openai.com", purpose: "Transcription." }],
    },
    update: { channel: "github-release", rollback_supported: true },
  }
}

export function sampleFiles(): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["assets/icon.svg", Buffer.from(ICON, "utf8")],
    ["dist/station.html", Buffer.from(SURFACE_HTML, "utf8")],
    ["dist/background.js", Buffer.from(BACKGROUND_JS, "utf8")],
  ])
}

export function packSample(
  mutate: (manifest: AppManifest, files: Map<string, Uint8Array>) => void = () => {},
): PackResult {
  const manifest = sampleManifest()
  const files = sampleFiles()
  mutate(manifest, files)
  return packApp({
    manifestText: stringifyJsonCanonical(manifest),
    files,
    source: PROVENANCE,
  })
}

export function packedSample(
  mutate: (manifest: AppManifest, files: Map<string, Uint8Array>) => void = () => {},
): Extract<PackResult, { ok: true }> {
  const result = packSample(mutate)
  if (!result.ok) {
    throw new Error(`fixture failed to pack: ${result.diagnostics.map((d) => d.message).join("; ")}`)
  }
  return result
}

export { PACKAGE_MANIFEST_PATH, PACKAGE_METADATA_PATH }
