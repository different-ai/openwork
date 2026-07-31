import { describe, expect, test } from "bun:test"

import {
  PACKAGE_LIMITS,
  PACKAGE_MANIFEST_PATH,
  PACKAGE_METADATA_PATH,
  canonicalFileListPayload,
  stringifyJsonCanonical,
  parseJsonStrict,
  packageMetadataSchema,
} from "@openwork/app-contract"

import { digest, packApp } from "../src/pack.js"
import { verifyPackage } from "../src/verify.js"
import { readZip, writeZip, ZipError } from "../src/zip.js"
import { PROVENANCE, packSample, packedSample, sampleFiles, sampleManifest } from "./fixtures.js"
import { buildRawZip, SYMLINK_ATTRIBUTES, UNIX_MADE_BY } from "./raw-zip.js"

function codes(diagnostics: readonly { code: string; severity: string }[]): string[] {
  return diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.code)
}

/** Rebuild an archive from its entries after mutating them, keeping it well-formed. */
function repack(archive: Buffer, mutate: (files: Map<string, Buffer>) => void): Buffer {
  const entries = readZip(archive, PACKAGE_LIMITS)
  const files = new Map(entries.map((entry) => [entry.path, Buffer.from(entry.content)] as const))
  mutate(files)
  return writeZip([...files.entries()].map(([path, content]) => ({ path, content })))
}

describe("packing", () => {
  test("a well-formed app packs and verifies", () => {
    const packed = packedSample()
    const result = verifyPackage(packed.archive)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.package.manifest.id).toBe("com.openworklabs.station")
    expect(result.package.archiveDigest).toBe(packed.archiveDigest)
    expect(result.package.files.has(PACKAGE_MANIFEST_PATH)).toBe(true)
    expect(result.package.files.has(PACKAGE_METADATA_PATH)).toBe(false)
  })

  test("packing is deterministic: identical input gives identical bytes", () => {
    const first = packedSample()
    const second = packedSample()
    expect(first.archiveDigest).toBe(second.archiveDigest)
    expect(first.archive.equals(second.archive)).toBe(true)
  })

  test("file order in the input does not change the archive", () => {
    const forward = packApp({
      manifestText: stringifyJsonCanonical(sampleManifest()),
      files: sampleFiles(),
      source: PROVENANCE,
    })
    const reversed = packApp({
      manifestText: stringifyJsonCanonical(sampleManifest()),
      files: new Map([...sampleFiles().entries()].reverse()),
      source: PROVENANCE,
    })
    expect(forward.ok && reversed.ok).toBe(true)
    if (!forward.ok || !reversed.ok) return
    expect(forward.archiveDigest).toBe(reversed.archiveDigest)
  })

  test("changing one byte of one file changes the archive digest", () => {
    const base = packedSample()
    const changed = packedSample((_manifest, files) => {
      files.set("dist/background.js", Buffer.from("export function activate() {} // changed\n"))
    })
    expect(changed.archiveDigest).not.toBe(base.archiveDigest)
  })

  test("packing refuses a manifest whose entrypoint is not shipped", () => {
    const result = packSample((_manifest, files) => {
      files.delete("dist/background.js")
    })
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.missing_declared_file")
  })

  test("packing refuses a manifest whose sidebar icon is not shipped", () => {
    const result = packSample((_manifest, files) => {
      files.delete("assets/icon.svg")
    })
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.missing_declared_file")
  })

  test("packing refuses a caller-supplied META-INF file", () => {
    const result = packSample((_manifest, files) => {
      files.set(PACKAGE_METADATA_PATH, Buffer.from("{}"))
    })
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.reserved_path")
  })

  test("packing refuses a traversal path", () => {
    const result = packSample((_manifest, files) => {
      files.set("../escape.txt", Buffer.from("x"))
    })
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.unsafe_path")
  })

  test("packing refuses an invalid manifest before touching the archive", () => {
    const result = packSample((manifest) => {
      manifest.version = "not-a-version"
    })
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("manifest.invalid_field")
  })

  test("the checksum sidecar records the archive digest", () => {
    const packed = packedSample()
    expect(packed.archiveDigest.startsWith("sha256:")).toBe(true)
    expect(packed.assetName).toBe("openwork-station-1.0.0.owapp")
  })
})

describe("archive integrity", () => {
  test("a pinned digest mismatch is rejected before the archive is parsed", () => {
    const packed = packedSample()
    const result = verifyPackage(packed.archive, {
      expectedArchiveDigest: `sha256:${"0".repeat(64)}`,
    })
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toEqual(["package.digest_mismatch"])
  })

  test("a matching pinned digest is accepted", () => {
    const packed = packedSample()
    expect(verifyPackage(packed.archive, { expectedArchiveDigest: packed.archiveDigest }).ok).toBe(true)
  })

  test("a same-length content swap is caught by the file hash", () => {
    const original = "export function activate() {}\n"
    const swapped = "export function activate(){;}\n"
    expect(swapped.length).toBe(original.length)
    const packed = packedSample()
    const tampered = repack(packed.archive, (files) => {
      files.set("dist/background.js", Buffer.from(swapped))
    })
    const result = verifyPackage(tampered)
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.hash_mismatch")
  })

  test("a different-length content swap is caught by the declared size", () => {
    const packed = packedSample()
    const tampered = repack(packed.archive, (files) => {
      files.set("dist/background.js", Buffer.from("export function activate(){ steal() }\n"))
    })
    const result = verifyPackage(tampered)
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.size_mismatch")
  })

  test("adding an undeclared file is rejected", () => {
    const packed = packedSample()
    const tampered = repack(packed.archive, (files) => {
      files.set("dist/payload.js", Buffer.from("// smuggled\n"))
    })
    const result = verifyPackage(tampered)
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.undeclared_file")
  })

  test("removing a declared file is rejected", () => {
    const packed = packedSample()
    const tampered = repack(packed.archive, (files) => {
      files.delete("assets/icon.svg")
    })
    const result = verifyPackage(tampered)
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.missing_file")
  })

  test("editing the file list without fixing files_digest is rejected", () => {
    const packed = packedSample()
    const tampered = repack(packed.archive, (files) => {
      const parsed = parseJsonStrict(files.get(PACKAGE_METADATA_PATH)!.toString("utf8"))
      if (!parsed.ok) throw new Error("fixture metadata unreadable")
      const metadata = packageMetadataSchema.parse(parsed.value)
      metadata.files = metadata.files.filter((entry) => entry.path !== "assets/icon.svg")
      files.set(PACKAGE_METADATA_PATH, Buffer.from(stringifyJsonCanonical(metadata)))
    })
    const result = verifyPackage(tampered)
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.metadata_tampered")
  })

  test("a fully re-signed metadata document still cannot hide a swapped manifest", () => {
    const packed = packedSample()
    const tampered = repack(packed.archive, (files) => {
      // Rewrite the manifest to request the microphone, then repair every hash a
      // naive attacker would think of — except the manifest_digest link.
      const manifest = sampleManifest()
      manifest.permissions.push({ id: "audio.microphone", reason: "listen" })
      manifest.privacy.data_handled = ["transcripts", "microphone-audio"]
      const manifestText = stringifyJsonCanonical(manifest)
      files.set(PACKAGE_MANIFEST_PATH, Buffer.from(manifestText))

      const parsed = parseJsonStrict(files.get(PACKAGE_METADATA_PATH)!.toString("utf8"))
      if (!parsed.ok) throw new Error("fixture metadata unreadable")
      const metadata = packageMetadataSchema.parse(parsed.value)
      metadata.files = metadata.files.map((entry) =>
        entry.path === PACKAGE_MANIFEST_PATH
          ? { ...entry, size: Buffer.byteLength(manifestText), digest: digest(manifestText) }
          : entry,
      )
      metadata.files_digest = digest(canonicalFileListPayload(metadata.files))
      files.set(PACKAGE_METADATA_PATH, Buffer.from(stringifyJsonCanonical(metadata)))
    })
    const result = verifyPackage(tampered)
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.manifest_mismatch")
  })

  test("metadata claiming a different app id than the manifest is rejected", () => {
    const packed = packedSample()
    const tampered = repack(packed.archive, (files) => {
      const parsed = parseJsonStrict(files.get(PACKAGE_METADATA_PATH)!.toString("utf8"))
      if (!parsed.ok) throw new Error("fixture metadata unreadable")
      const metadata = packageMetadataSchema.parse(parsed.value)
      metadata.app_id = "com.attacker.lookalike"
      metadata.files_digest = digest(canonicalFileListPayload(metadata.files))
      files.set(PACKAGE_METADATA_PATH, Buffer.from(stringifyJsonCanonical(metadata)))
    })
    const result = verifyPackage(tampered)
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.identity_mismatch")
  })

  test("a release whose package is a different app than the candidate is rejected", () => {
    const packed = packedSample()
    const result = verifyPackage(packed.archive, { expectedAppId: "com.openworklabs.other" })
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.identity_mismatch")
  })

  test("a release whose package version drifted from the candidate is rejected", () => {
    const packed = packedSample()
    const result = verifyPackage(packed.archive, { expectedVersion: "1.0.1" })
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.version_mismatch")
  })

  test("an archive with no metadata is rejected", () => {
    const packed = packedSample()
    const tampered = repack(packed.archive, (files) => {
      files.delete(PACKAGE_METADATA_PATH)
    })
    expect(codes(verifyPackage(tampered).diagnostics)).toContain("package.missing_metadata")
  })

  test("an empty buffer is rejected without throwing", () => {
    const result = verifyPackage(Buffer.alloc(0))
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("package.invalid_archive")
  })

  test("random bytes are rejected without throwing", () => {
    const result = verifyPackage(Buffer.from("this is definitely not a zip file"))
    expect(result.ok).toBe(false)
  })
})

describe("hardened archive reader", () => {
  const limits = PACKAGE_LIMITS

  function expectZipError(archive: Buffer, code: string) {
    let thrown: unknown
    try {
      readZip(archive, limits)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ZipError)
    if (thrown instanceof ZipError) expect(thrown.code).toBe(code as ZipError["code"])
  }

  test("a traversal path is refused", () => {
    expectZipError(
      buildRawZip([{ path: "../../.ssh/authorized_keys", content: Buffer.from("key") }]),
      "path_traversal",
    )
  })

  test("an absolute path is refused", () => {
    expectZipError(buildRawZip([{ path: "/etc/passwd", content: Buffer.from("x") }]), "path_traversal")
  })

  test("a backslash path is refused", () => {
    expectZipError(
      buildRawZip([{ path: "..\\..\\windows\\system32\\x.dll", content: Buffer.from("x") }]),
      "path_traversal",
    )
  })

  test("a Windows drive path is refused", () => {
    expectZipError(buildRawZip([{ path: "C:/windows/x.dll", content: Buffer.from("x") }]), "path_traversal")
  })

  test("a symlink entry is refused", () => {
    expectZipError(
      buildRawZip([
        {
          path: "dist/link",
          content: Buffer.from("/etc/passwd"),
          madeBy: UNIX_MADE_BY,
          externalAttributes: SYMLINK_ATTRIBUTES,
        },
      ]),
      "symlink_entry",
    )
  })

  test("a directory entry is refused", () => {
    expectZipError(buildRawZip([{ path: "dist/", content: Buffer.alloc(0) }]), "directory_entry")
  })

  test("a duplicate entry name is refused", () => {
    expectZipError(
      buildRawZip([
        { path: "dist/a.js", content: Buffer.from("first") },
        { path: "dist/a.js", content: Buffer.from("second") },
      ]),
      "duplicate_entry",
    )
  })

  test("a local header naming a different file than the directory is refused", () => {
    expectZipError(
      buildRawZip([
        { path: "dist/safe.js", localPathOverride: "dist/evil.js", content: Buffer.from("x") },
      ]),
      "header_mismatch",
    )
  })

  test("an unsupported compression method is refused", () => {
    expectZipError(buildRawZip([{ path: "a.txt", content: Buffer.from("x"), method: 9 }]), "unsupported_feature")
  })

  test("an encrypted entry is refused", () => {
    expectZipError(
      buildRawZip([{ path: "a.txt", content: Buffer.from("x"), flags: 0x0801 }]),
      "unsupported_feature",
    )
  })

  test("a data-descriptor entry is refused", () => {
    expectZipError(
      buildRawZip([{ path: "a.txt", content: Buffer.from("x"), flags: 0x0808 }]),
      "unsupported_feature",
    )
  })

  test("ZIP64 sentinels are refused", () => {
    expectZipError(
      buildRawZip([{ path: "a.txt", content: Buffer.from("x"), zip64Sizes: true }]),
      "unsupported_feature",
    )
  })

  test("a corrupted payload fails its checksum", () => {
    expectZipError(
      buildRawZip([{ path: "a.txt", content: Buffer.from("hello"), crcOverride: 0 }]),
      "checksum_mismatch",
    )
  })

  test("a declared size that disagrees with the payload is refused", () => {
    expectZipError(
      buildRawZip([{ path: "a.txt", content: Buffer.from("hello"), declaredSize: 4 }]),
      "header_mismatch",
    )
  })

  test("an entry claiming more than the per-file limit is refused before allocation", () => {
    expectZipError(
      buildRawZip([
        { path: "a.txt", content: Buffer.from("small"), declaredSize: PACKAGE_LIMITS.maxFileBytes + 1 },
      ]),
      "entry_too_large",
    )
  })

  test("a decompression bomb is refused on its declared ratio", () => {
    const bomb = Buffer.alloc(8 * 1024 * 1024, 0)
    expectZipError(buildRawZip([{ path: "bomb.bin", content: bomb }]), "compression_bomb")
  })

  test("too many entries are refused", () => {
    const entries = Array.from({ length: PACKAGE_LIMITS.maxFiles + 1 }, (_unused, index) => ({
      path: `f/${index}.txt`,
      content: Buffer.from(String(index)),
    }))
    expectZipError(buildRawZip(entries), "too_many_entries")
  })

  test("the writer itself refuses to produce an unsafe path", () => {
    expect(() => writeZip([{ path: "../x", content: Buffer.from("x") }])).toThrow(ZipError)
  })

  test("a well-formed archive round-trips exactly", () => {
    const entries = [
      { path: "b.txt", content: Buffer.from("second") },
      { path: "a/x.txt", content: Buffer.from("first") },
    ]
    const read = readZip(writeZip(entries), limits)
    expect(read.map((entry) => entry.path)).toEqual(["a/x.txt", "b.txt"])
    expect(Buffer.from(read[0]!.content).toString()).toBe("first")
  })

  test("a zero-length file round-trips", () => {
    const read = readZip(writeZip([{ path: "empty.txt", content: Buffer.alloc(0) }]), limits)
    expect(read[0]?.content.byteLength).toBe(0)
  })

  test("UTF-8 filenames round-trip", () => {
    const read = readZip(writeZip([{ path: "assets/café-ícono.svg", content: Buffer.from("x") }]), limits)
    expect(read[0]?.path).toBe("assets/café-ícono.svg")
  })
})

// The writer and the reader have to agree about what a valid package is. If the
// writer can emit something the reader refuses, the failure surfaces at preview
// time on a user's machine, before any consent, and the publisher never sees it.
describe("the packer and the verifier agree", () => {
  test("every packed sample verifies", () => {
    const packed = packedSample()
    const verified = verifyPackage(packed.archive)
    expect(verified.ok).toBe(true)
  })

  test("a highly compressible asset is refused at pack time, not at install time", () => {
    // A 2 MiB zero-filled asset — a seed database, a WASM module with a large
    // static data segment — deflates far past the per-entry ratio limit.
    const result = packSample((_manifest, files) => {
      files.set("dist/seed.db", Buffer.alloc(2 * 1024 * 1024))
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.map((entry) => entry.code)).toContain("package.compression_bomb")
    // The author needs to know which file, while they can still do something.
    expect(result.diagnostics.some((entry) => entry.message.includes("dist/seed.db"))).toBe(true)
  })

  test("an archive with slack bytes is refused as non-canonical", () => {
    const packed = packedSample()
    // Append a byte after the end-of-central-directory record.
    const padded = Buffer.concat([Buffer.from(packed.archive), Buffer.from([0])])
    expect(() => readZip(padded, PACKAGE_LIMITS)).toThrow(ZipError)
    expect(verifyPackage(padded).ok).toBe(false)
  })

  test("a prefix before the first entry is refused as non-canonical", () => {
    const packed = packedSample()
    const prefixed = Buffer.concat([Buffer.from("MZ"), Buffer.from(packed.archive)])
    const verified = verifyPackage(prefixed)
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.diagnostics.map((entry) => entry.code)).toContain(
      "package.non_canonical_layout",
    )
  })
})
