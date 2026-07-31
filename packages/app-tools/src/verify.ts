import {
  PACKAGE_LIMITS,
  PACKAGE_MANIFEST_PATH,
  PACKAGE_METADATA_PATH,
  canonicalFileListPayload,
  checkCompatibility,
  packageMetadataSchema,
  parseJsonStrict,
  validateManifest,
  type AppManifest,
  type Diagnostic,
  type HostEnvironment,
  type PackageMetadata,
} from "@openwork/app-contract"

import { digest } from "./pack.js"
import { ZipError, readZip, type ZipEntry } from "./zip.js"

// Package verification.
//
// This runs in three places — the CLI, CI, and the installer — and must reach
// the same verdict in all three. It is the last checkpoint before bytes from
// the internet become an installed application, so every check is mandatory and
// ordered cheapest-first.

export type VerifyOptions = {
  /**
   * Digest the caller committed to before downloading. Supplied by the install
   * candidate. When present, a mismatch aborts before the archive is parsed at
   * all — the release moved under us, or the bytes were swapped in transit.
   */
  expectedArchiveDigest?: string
  /** Expected app id from the candidate, to catch a release that changed identity. */
  expectedAppId?: string
  /** Expected version from the candidate. */
  expectedVersion?: string
  /**
   * Digest of the repository manifest the user actually reviewed, pinned by the
   * install candidate.
   *
   * The reviewed document is the one that governs. A package that ships a
   * different manifest — different permissions, contributions, entrypoints, or
   * privacy disclosure — is a mismatch, not a preference, so the package must
   * carry a byte-identical copy of what the review screen showed. Without this
   * the review screen and the grant read two different documents.
   */
  expectedManifestDigest?: string
  /** When supplied, engine, App API, and platform compatibility are enforced. */
  host?: HostEnvironment
}

export type VerifiedPackage = {
  manifest: AppManifest
  metadata: PackageMetadata
  /** Every file except the metadata document, keyed by archive path. */
  files: Map<string, Uint8Array>
  archiveDigest: string
}

export type VerifyResult =
  | { ok: true; package: VerifiedPackage; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] }

function error(code: string, message: string, hint?: string): Diagnostic {
  return hint === undefined
    ? { severity: "error", code, path: "", message }
    : { severity: "error", code, path: "", message, hint }
}

function fail(code: string, message: string, hint?: string): VerifyResult {
  return { ok: false, diagnostics: [error(code, message, hint)] }
}

export function verifyPackage(archive: Uint8Array, options: VerifyOptions = {}): VerifyResult {
  const buffer = Buffer.from(archive)

  if (buffer.length > PACKAGE_LIMITS.maxArchiveBytes) {
    return fail("package.archive_too_large", "archive exceeds the maximum allowed size")
  }

  const archiveDigest = digest(buffer)
  if (options.expectedArchiveDigest !== undefined && options.expectedArchiveDigest !== archiveDigest) {
    return fail(
      "package.digest_mismatch",
      "the downloaded archive does not match the digest recorded when you reviewed it",
      "The release asset changed after the preview. Review it again before installing.",
    )
  }

  let entries: ZipEntry[]
  try {
    entries = readZip(buffer, PACKAGE_LIMITS)
  } catch (thrown) {
    if (thrown instanceof ZipError) return fail(`package.${thrown.code}`, thrown.message)
    throw thrown
  }

  const byPath = new Map(entries.map((entry) => [entry.path, entry.content] as const))

  const metadataBytes = byPath.get(PACKAGE_METADATA_PATH)
  if (!metadataBytes) {
    return fail("package.missing_metadata", `archive has no ${PACKAGE_METADATA_PATH}`)
  }
  const metadataJson = parseJsonStrict(Buffer.from(metadataBytes).toString("utf8"))
  if (!metadataJson.ok) {
    return fail("package.invalid_metadata", `package metadata is not valid JSON: ${metadataJson.error}`)
  }
  const metadataParse = packageMetadataSchema.safeParse(metadataJson.value)
  if (!metadataParse.success) {
    return {
      ok: false,
      diagnostics: metadataParse.error.issues.map((issue) =>
        error("package.invalid_metadata", `${issue.path.join(".")}: ${issue.message}`),
      ),
    }
  }
  const metadata = metadataParse.data

  // The metadata's own file list must be internally consistent before it is
  // used to judge anything else.
  if (metadata.files_digest !== digest(canonicalFileListPayload(metadata.files))) {
    return fail("package.metadata_tampered", "the package file list does not match its digest")
  }

  const manifestBytes = byPath.get(PACKAGE_MANIFEST_PATH)
  if (!manifestBytes) {
    return fail("package.missing_manifest", `archive has no ${PACKAGE_MANIFEST_PATH}`)
  }

  // Closure: exactly the declared files, no more and no less.
  const declared = new Map(metadata.files.map((entry) => [entry.path, entry] as const))
  const diagnostics: Diagnostic[] = []

  for (const entry of entries) {
    if (entry.path === PACKAGE_METADATA_PATH) continue
    const expected = declared.get(entry.path)
    if (!expected) {
      diagnostics.push(
        error(
          "package.undeclared_file",
          `archive contains "${entry.path}", which the package metadata does not declare`,
          "Every shipped file must be listed and hashed.",
        ),
      )
      continue
    }
    if (entry.content.byteLength !== expected.size) {
      diagnostics.push(error("package.size_mismatch", `size mismatch for ${entry.path}`))
      continue
    }
    if (digest(entry.content) !== expected.digest) {
      diagnostics.push(error("package.hash_mismatch", `content hash mismatch for ${entry.path}`))
    }
  }
  for (const path of declared.keys()) {
    if (!byPath.has(path)) {
      diagnostics.push(
        error("package.missing_file", `package metadata declares "${path}", which is not in the archive`),
      )
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics }

  const manifestDigest = digest(manifestBytes)
  if (metadata.manifest_digest !== manifestDigest) {
    return fail("package.manifest_mismatch", "the manifest does not match the digest in the package metadata")
  }

  // The reviewed manifest governs. Compare before parsing, so a package whose
  // manifest disagrees with the repository cannot reach permission extraction.
  if (options.expectedManifestDigest !== undefined && options.expectedManifestDigest !== manifestDigest) {
    return fail(
      "package.manifest_divergence",
      "the manifest inside the package is not the manifest that was reviewed",
      "The package must ship the same openwork.app.json that the repository declares at this commit.",
    )
  }

  const validation = validateManifest(Buffer.from(manifestBytes).toString("utf8"))
  if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics }
  const manifest = validation.manifest

  if (metadata.app_id !== manifest.id) {
    return fail(
      "package.identity_mismatch",
      `package metadata claims app "${metadata.app_id}" but the manifest declares "${manifest.id}"`,
    )
  }
  if (metadata.app_version !== manifest.version) {
    return fail(
      "package.version_mismatch",
      `package metadata claims version ${metadata.app_version} but the manifest declares ${manifest.version}`,
    )
  }
  if (metadata.source.repository !== manifest.repository) {
    return fail(
      "package.provenance_mismatch",
      "the package provenance repository does not match the manifest repository",
    )
  }

  if (options.expectedAppId !== undefined && options.expectedAppId !== manifest.id) {
    return fail(
      "package.identity_mismatch",
      `expected app "${options.expectedAppId}" but the package contains "${manifest.id}"`,
      "The release now points at a different application than the one you reviewed.",
    )
  }
  if (options.expectedVersion !== undefined && options.expectedVersion !== manifest.version) {
    return fail(
      "package.version_mismatch",
      `expected version ${options.expectedVersion} but the package contains ${manifest.version}`,
    )
  }

  // Entrypoints and icons must resolve inside the verified file set, so the
  // runtime never has to fall back or guess.
  const requiredPaths = new Set<string>([manifest.icons.default])
  if (manifest.icons.light) requiredPaths.add(manifest.icons.light)
  if (manifest.icons.dark) requiredPaths.add(manifest.icons.dark)
  if (manifest.entrypoints.background) requiredPaths.add(manifest.entrypoints.background)
  for (const path of Object.values(manifest.entrypoints.surfaces)) requiredPaths.add(path)
  for (const contribution of manifest.contributions) {
    if (contribution.type === "right_sidebar_item") requiredPaths.add(contribution.icon)
  }
  for (const path of requiredPaths) {
    if (!byPath.has(path)) {
      diagnostics.push(
        error("package.missing_entrypoint", `the manifest points at "${path}", which is not in the package`),
      )
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics }

  if (options.host) {
    const compatibility = checkCompatibility(manifest, options.host)
    if (!compatibility.compatible) return { ok: false, diagnostics: [compatibility.diagnostic] }
  }

  const files = new Map(byPath)
  files.delete(PACKAGE_METADATA_PATH)

  return { ok: true, package: { manifest, metadata, files, archiveDigest }, diagnostics: [] }
}
