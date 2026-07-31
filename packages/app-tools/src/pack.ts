import { createHash } from "node:crypto"

import {
  PACKAGE_LIMITS,
  PACKAGE_MANIFEST_PATH,
  PACKAGE_METADATA_PATH,
  canonicalFileListPayload,
  packageMetadataSchema,
  resolveDistributionAsset,
  stringifyJsonCanonical,
  validateManifest,
  type AppManifest,
  type Diagnostic,
  type PackageFileEntry,
  type PackageMetadata,
  type PackageProvenance,
} from "@openwork/app-contract"

import { ZipError, isSafeArchivePath, readZip, writeZip, type ZipInputEntry } from "./zip.js"

export const PACK_TOOL_NAME = "@openwork/app-tools"
export const PACK_TOOL_VERSION = "0.1.0"

export function digest(data: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`
}

export type PackInput = {
  /** Raw `openwork.app.json` bytes exactly as they will ship. */
  manifestText: string
  /** Every other file to include, keyed by archive-relative path. */
  files: ReadonlyMap<string, Uint8Array>
  source: PackageProvenance
}

export type PackResult =
  | {
      ok: true
      archive: Buffer
      /** Digest of the finished archive; this is what a release must publish. */
      archiveDigest: string
      assetName: string
      manifest: AppManifest
      metadata: PackageMetadata
      diagnostics: Diagnostic[]
    }
  | { ok: false; diagnostics: Diagnostic[] }

function error(code: string, path: string, message: string, hint?: string): Diagnostic {
  return hint === undefined
    ? { severity: "error", code, path, message }
    : { severity: "error", code, path, message, hint }
}

/**
 * Build a `.owapp`.
 *
 * The manifest is validated first, then every path the manifest points at is
 * checked to actually exist in the file set. Packaging an app whose entrypoint
 * or icon is missing produces an archive that only fails at install time, on the
 * user's machine — so it fails here instead.
 */
export function packApp(input: PackInput): PackResult {
  const validation = validateManifest(input.manifestText)
  if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics }
  const manifest = validation.manifest
  const diagnostics: Diagnostic[] = [...validation.diagnostics]

  if (input.files.has(PACKAGE_MANIFEST_PATH)) {
    diagnostics.push(
      error(
        "package.duplicate_manifest",
        PACKAGE_MANIFEST_PATH,
        "the manifest must be supplied as manifestText, not as a bundled file",
      ),
    )
  }
  if (input.files.has(PACKAGE_METADATA_PATH)) {
    diagnostics.push(
      error(
        "package.reserved_path",
        PACKAGE_METADATA_PATH,
        "META-INF/openwork-package.json is generated and cannot be supplied",
      ),
    )
  }

  for (const path of input.files.keys()) {
    if (!isSafeArchivePath(path)) {
      diagnostics.push(error("package.unsafe_path", path, `unsafe archive path: ${JSON.stringify(path)}`))
    }
    if (path.startsWith("META-INF/")) {
      diagnostics.push(error("package.reserved_path", path, "META-INF/ is reserved for package metadata"))
    }
  }

  // Every declared path must ship. A dangling entrypoint is a broken install.
  const declared: Array<{ path: string; field: string }> = [
    { path: manifest.icons.default, field: "icons.default" },
  ]
  if (manifest.icons.light) declared.push({ path: manifest.icons.light, field: "icons.light" })
  if (manifest.icons.dark) declared.push({ path: manifest.icons.dark, field: "icons.dark" })
  if (manifest.entrypoints.background) {
    declared.push({ path: manifest.entrypoints.background, field: "entrypoints.background" })
  }
  for (const [key, path] of Object.entries(manifest.entrypoints.surfaces)) {
    declared.push({ path, field: `entrypoints.surfaces.${key}` })
  }
  for (const contribution of manifest.contributions) {
    if (contribution.type === "right_sidebar_item") {
      declared.push({ path: contribution.icon, field: `contributions.${contribution.id}.icon` })
    }
  }
  for (const entry of declared) {
    if (!input.files.has(entry.path)) {
      diagnostics.push(
        error(
          "package.missing_declared_file",
          entry.field,
          `${entry.field} points at "${entry.path}", which is not in the package`,
        ),
      )
    }
  }

  const manifestBytes = Buffer.from(input.manifestText, "utf8")
  let totalBytes = manifestBytes.length
  for (const content of input.files.values()) {
    if (content.byteLength > PACKAGE_LIMITS.maxFileBytes) {
      diagnostics.push(error("package.file_too_large", "", "a bundled file exceeds the per-file limit"))
    }
    totalBytes += content.byteLength
  }
  if (input.files.size + 2 > PACKAGE_LIMITS.maxFiles) {
    diagnostics.push(error("package.too_many_files", "", "package exceeds the entry limit"))
  }
  if (totalBytes > PACKAGE_LIMITS.maxUnpackedBytes) {
    diagnostics.push(error("package.too_large", "", "package exceeds the unpacked size limit"))
  }

  if (diagnostics.some((entry) => entry.severity === "error")) return { ok: false, diagnostics }

  const fileEntries: PackageFileEntry[] = [
    {
      path: PACKAGE_MANIFEST_PATH,
      size: manifestBytes.length,
      digest: digest(manifestBytes),
    },
    ...[...input.files.entries()]
      .map(([path, content]) => ({
        path,
        size: content.byteLength,
        digest: digest(content),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
  ]

  const metadata: PackageMetadata = {
    package_format_version: 1,
    app_id: manifest.id,
    app_version: manifest.version,
    manifest_digest: digest(manifestBytes),
    created_with: { tool: PACK_TOOL_NAME, version: PACK_TOOL_VERSION },
    source: input.source,
    files: fileEntries,
    files_digest: digest(canonicalFileListPayload(fileEntries)),
  }

  const metadataText = stringifyJsonCanonical(metadata)
  const zipEntries: ZipInputEntry[] = [
    { path: PACKAGE_MANIFEST_PATH, content: manifestBytes },
    { path: PACKAGE_METADATA_PATH, content: Buffer.from(metadataText, "utf8") },
    ...[...input.files.entries()].map(([path, content]) => ({ path, content })),
  ]

  const archive = writeZip(zipEntries)
  if (archive.length > PACKAGE_LIMITS.maxArchiveBytes) {
    return {
      ok: false,
      diagnostics: [error("package.archive_too_large", "", "the built archive exceeds the size limit")],
    }
  }

  // Round-trip the generated metadata through its own schema: a packer that can
  // emit metadata the verifier rejects is worse than one that refuses to build.
  const metadataCheck = packageMetadataSchema.safeParse(JSON.parse(metadataText) as unknown)
  if (!metadataCheck.success) {
    return {
      ok: false,
      diagnostics: [
        error("package.invalid_metadata", "", "generated package metadata failed its own schema"),
      ],
    }
  }

  // And round-trip the archive itself through the reader, for the same reason.
  //
  // The reader enforces limits the writer does not — the per-entry compression
  // ratio above all — so without this a publisher can pack a release that fails
  // verification later on the user's machine, at preview time, before any consent
  // and with nothing the user can do about it. Failing here names the offending
  // file while the author can still act on it.
  try {
    readZip(Buffer.from(archive), PACKAGE_LIMITS)
  } catch (thrown) {
    if (thrown instanceof ZipError) {
      return { ok: false, diagnostics: [error(`package.${thrown.code}`, "", thrown.message)] }
    }
    throw thrown
  }

  return {
    ok: true,
    archive,
    archiveDigest: digest(archive),
    assetName: resolveDistributionAsset(manifest),
    manifest,
    metadata,
    diagnostics,
  }
}

/** Contents of the sibling `.sha256` file published next to the archive. */
export function checksumFileContents(archiveDigest: string, assetName: string): string {
  return `${archiveDigest.replace("sha256:", "")}  ${assetName}\n`
}
