import os from "node:os"
import path from "node:path"

export const ARTIFACT_STORAGE_DEFAULT_MAX_BYTES = 20 * 1024 * 1024
export const ARTIFACT_STORAGE_DEFAULT_MAX_ROWS = 10_000

export type ArtifactStorageBackendConfig =
  | { kind: "celld"; url: string; token: string }
  | { kind: "local"; directory: string }

export type ArtifactStorageConfig = {
  /** null when this install has nowhere to keep artifact data; artifacts then report their saved data as unavailable. */
  backend: ArtifactStorageBackendConfig | null
  /** Why `backend` is null, for the startup log. */
  unavailableReason?: string
  /** Largest database one artifact may grow to. */
  maxBytes: number
  /** Most rows one artifact may hold, across its collections. */
  maxRows: number
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text ? text : undefined
}

function positiveInteger(name: string, value: string | undefined, fallback: number, max: number): number {
  const text = trimmed(value)
  if (!text) return fallback
  const parsed = Number(text)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${name} must be a whole number between 1 and ${max}.`)
  return parsed
}

/**
 * Which storage backend this install uses is install configuration, not a
 * feature: the `artifactStorage` feature decides who gets saved data, this
 * decides where it is kept.
 *
 * - `celld`: a celld fleet (one cell per artifact, state in an S3-compatible
 *   bucket). The only choice for an install that runs more than one Den.
 * - `local`: SQLite files in a directory on this Den's disk, for development
 *   and tests. Outside dev mode it is refused unless the operator states that
 *   this install runs exactly one Den with a persistent disk.
 * - unset: `local` under the system temp directory in dev mode, otherwise none.
 */
export function resolveArtifactStorageConfig(input: {
  backend: string | undefined
  localDir: string | undefined
  localSingleInstance: string | undefined
  celldUrl: string | undefined
  celldToken: string | undefined
  maxBytes: string | undefined
  maxRows: string | undefined
  devMode: boolean
}): ArtifactStorageConfig {
  const limits = {
    maxBytes: positiveInteger("DEN_ARTIFACT_STORAGE_MAX_BYTES", input.maxBytes, ARTIFACT_STORAGE_DEFAULT_MAX_BYTES, 1024 * 1024 * 1024),
    maxRows: positiveInteger("DEN_ARTIFACT_STORAGE_MAX_ROWS", input.maxRows, ARTIFACT_STORAGE_DEFAULT_MAX_ROWS, 1_000_000),
  }
  const kind = trimmed(input.backend)?.toLowerCase()
  const localDirectory = () => path.resolve(trimmed(input.localDir) ?? path.join(os.tmpdir(), "openwork-den-artifact-storage"))
  if (kind === undefined) {
    return input.devMode
      ? { backend: { kind: "local", directory: localDirectory() }, ...limits }
      : { backend: null, unavailableReason: "DEN_ARTIFACT_STORAGE_BACKEND is not set.", ...limits }
  }
  if (kind === "celld") {
    const url = trimmed(input.celldUrl)
    const token = trimmed(input.celldToken)
    if (!url || !token) throw new Error("DEN_ARTIFACT_STORAGE_BACKEND=celld needs DEN_ARTIFACT_STORAGE_CELLD_URL and DEN_ARTIFACT_STORAGE_CELLD_TOKEN.")
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error("DEN_ARTIFACT_STORAGE_CELLD_URL must be an absolute http or https URL.")
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("DEN_ARTIFACT_STORAGE_CELLD_URL must be an absolute http or https URL.")
    if (token.length < 24) throw new Error("DEN_ARTIFACT_STORAGE_CELLD_TOKEN must contain at least 24 characters.")
    return { backend: { kind: "celld", url: parsed.toString().replace(/\/+$/u, ""), token }, ...limits }
  }
  if (kind === "local") {
    const acknowledged = trimmed(input.localSingleInstance) === "1"
    if (!input.devMode && !acknowledged) {
      return {
        backend: null,
        unavailableReason: "DEN_ARTIFACT_STORAGE_BACKEND=local keeps data on one Den's disk, so it is refused outside dev mode. Use celld, or set DEN_ARTIFACT_STORAGE_LOCAL_UNSAFE_SINGLE_INSTANCE=1 when this install runs exactly one Den with a persistent disk.",
        ...limits,
      }
    }
    return { backend: { kind: "local", directory: localDirectory() }, ...limits }
  }
  throw new Error("DEN_ARTIFACT_STORAGE_BACKEND must be celld or local.")
}
