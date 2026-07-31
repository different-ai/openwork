import { deflateRawSync, inflateRawSync } from "node:zlib"

// A deterministic ZIP writer and a hardened ZIP reader.
//
// Why hand-rolled rather than a dependency:
//
//   * Determinism. A `.owapp` must be a function of its contents alone. General
//     archivers embed mtimes, host attributes, and directory entries, so the
//     same input tree yields different bytes on different machines and the
//     digest stops meaning anything.
//   * The reader is the attack surface. Zip-slip, symlink escape, decompression
//     bombs, and ZIP64 confusion are bugs in extractors, not in archives. This
//     reader fails closed on all of them, checks the central directory against
//     each local header, and never touches the filesystem — callers decide what
//     to write, after verification.
//
// What is guaranteed: the same file set, packed by the same tool build, gives
// byte-identical output. Cross-version zlib reproducibility is not claimed;
// integrity does not depend on it, because every digest is taken over
// uncompressed content and over the finished archive.

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50

const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const END_OF_CENTRAL_DIRECTORY_SIZE = 22

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** UTF-8 filename flag (bit 11). No other general-purpose flags are ever set. */
const FLAG_UTF8 = 0x0800
const FLAG_ENCRYPTED = 0x0001
const FLAG_DATA_DESCRIPTOR = 0x0008

// The ZIP epoch. Fixing the timestamp is what removes build time from the
// archive bytes.
const DOS_TIME = 0
const DOS_DATE = 0x0021 // 1980-01-01

const VERSION_NEEDED = 20
/** "Made by" MS-DOS, so external attributes carry no unix mode and no symlink bit. */
const VERSION_MADE_BY = 20

const UNIX_MADE_BY = 3
const S_IFMT = 0xf000
const S_IFLNK = 0xa000

const ZIP64_SENTINEL = 0xffffffff

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = -1
  for (let index = 0; index < data.length; index += 1) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ (data[index] as number)) & 0xff] as number)
  }
  return (crc ^ -1) >>> 0
}

export type ZipInputEntry = {
  /** Forward-slashed relative path. Validated by the writer. */
  path: string
  content: Uint8Array
}

export type ZipEntry = {
  path: string
  content: Uint8Array
}

export class ZipError extends Error {
  constructor(
    readonly code: ZipErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ZipError"
  }
}

export type ZipErrorCode =
  | "invalid_archive"
  | "unsupported_feature"
  | "path_traversal"
  | "symlink_entry"
  | "directory_entry"
  | "duplicate_entry"
  | "too_many_entries"
  | "entry_too_large"
  | "archive_too_large"
  | "compression_bomb"
  | "checksum_mismatch"
  | "header_mismatch"
  | "non_canonical_layout"

export type ZipLimits = {
  maxFiles: number
  maxFileBytes: number
  maxUnpackedBytes: number
  maxCompressionRatio: number
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * The only path shape allowed inside an `.owapp`.
 *
 * Deliberately stricter than the ZIP spec: no backslashes, no drive letters, no
 * leading slash, no `.`/`..` segment, no empty segment, no trailing slash. An
 * entry that cannot be spelled cannot escape.
 */
export function isSafeArchivePath(path: string): boolean {
  if (path.length === 0 || path.length > 255) return false
  if (path.includes("\\") || path.includes("\0")) return false
  if (path.startsWith("/")) return false
  if (/^[A-Za-z]:/.test(path)) return false
  const segments = path.split("/")
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".." && !/^\s|\s$/.test(segment),
  )
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

type StagedEntry = {
  path: string
  nameBytes: Buffer
  method: number
  crc: number
  compressed: Buffer
  uncompressedSize: number
  offset: number
}

/**
 * Build a deterministic ZIP.
 *
 * Determinism comes from: entries sorted by path, a fixed 1980 timestamp, a
 * fixed flag word, no extra fields, no directory entries, no data descriptors,
 * and zeroed external attributes.
 */
export function writeZip(entries: readonly ZipInputEntry[]): Buffer {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!isSafeArchivePath(entry.path)) {
      throw new ZipError("path_traversal", `unsafe archive path: ${JSON.stringify(entry.path)}`)
    }
    if (seen.has(entry.path)) {
      throw new ZipError("duplicate_entry", `duplicate archive path: ${entry.path}`)
    }
    seen.add(entry.path)
  }

  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const staged: StagedEntry[] = []
  const chunks: Buffer[] = []
  let offset = 0

  for (const entry of sorted) {
    const content = Buffer.from(entry.content)
    const nameBytes = Buffer.from(entry.path, "utf8")
    const deflated = deflateRawSync(content, { level: 9 })
    // Store when deflate does not help, so tiny files stay byte-stable and small.
    const useDeflate = deflated.length < content.length
    const compressed = useDeflate ? deflated : content
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE
    const crc = crc32(content)

    const header = Buffer.alloc(LOCAL_HEADER_SIZE)
    header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0)
    header.writeUInt16LE(VERSION_NEEDED, 4)
    header.writeUInt16LE(FLAG_UTF8, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(DOS_TIME, 10)
    header.writeUInt16LE(DOS_DATE, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(content.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    header.writeUInt16LE(0, 28)

    chunks.push(header, nameBytes, compressed)
    staged.push({
      path: entry.path,
      nameBytes,
      method,
      crc,
      compressed,
      uncompressedSize: content.length,
      offset,
    })
    offset += header.length + nameBytes.length + compressed.length
  }

  const centralDirectoryOffset = offset
  let centralDirectorySize = 0

  for (const entry of staged) {
    const header = Buffer.alloc(CENTRAL_HEADER_SIZE)
    header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0)
    header.writeUInt16LE(VERSION_MADE_BY, 4)
    header.writeUInt16LE(VERSION_NEEDED, 6)
    header.writeUInt16LE(FLAG_UTF8, 8)
    header.writeUInt16LE(entry.method, 10)
    header.writeUInt16LE(DOS_TIME, 12)
    header.writeUInt16LE(DOS_DATE, 14)
    header.writeUInt32LE(entry.crc, 16)
    header.writeUInt32LE(entry.compressed.length, 20)
    header.writeUInt32LE(entry.uncompressedSize, 24)
    header.writeUInt16LE(entry.nameBytes.length, 28)
    header.writeUInt16LE(0, 30) // extra length
    header.writeUInt16LE(0, 32) // comment length
    header.writeUInt16LE(0, 34) // disk number
    header.writeUInt16LE(0, 36) // internal attributes
    header.writeUInt32LE(0, 38) // external attributes: no unix mode, no symlink bit
    header.writeUInt32LE(entry.offset, 42)
    chunks.push(header, entry.nameBytes)
    centralDirectorySize += header.length + entry.nameBytes.length
  }

  const end = Buffer.alloc(END_OF_CENTRAL_DIRECTORY_SIZE)
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(staged.length, 8)
  end.writeUInt16LE(staged.length, 10)
  end.writeUInt32LE(centralDirectorySize, 12)
  end.writeUInt32LE(centralDirectoryOffset, 16)
  end.writeUInt16LE(0, 20)
  chunks.push(end)

  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

type CentralEntry = {
  path: string
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  madeBy: number
  externalAttributes: number
  flags: number
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The end record may be followed by a comment, so scan backwards. The comment
  // length is bounded to 64 KiB by the format.
  const minimum = Math.max(0, buffer.length - END_OF_CENTRAL_DIRECTORY_SIZE - 0xffff)
  for (let index = buffer.length - END_OF_CENTRAL_DIRECTORY_SIZE; index >= minimum; index -= 1) {
    if (buffer.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      const commentLength = buffer.readUInt16LE(index + 20)
      if (index + END_OF_CENTRAL_DIRECTORY_SIZE + commentLength === buffer.length) return index
    }
  }
  throw new ZipError("invalid_archive", "end of central directory record not found")
}

/**
 * The central directory, plus where the payload stream ends.
 *
 * `readZip` needs `directoryOffset` to prove the entries account for every byte
 * before it, which is the half of the canonical-layout check that cannot be done
 * from the directory alone.
 */
type CentralDirectory = {
  entries: CentralEntry[]
  directoryOffset: number
}

function readCentralDirectory(buffer: Buffer, limits: ZipLimits): CentralDirectory {
  const endOffset = findEndOfCentralDirectory(buffer)
  const totalEntries = buffer.readUInt16LE(endOffset + 10)
  const directorySize = buffer.readUInt32LE(endOffset + 12)
  const directoryOffset = buffer.readUInt32LE(endOffset + 16)
  const archiveCommentLength = buffer.readUInt16LE(endOffset + 20)

  if (directoryOffset === ZIP64_SENTINEL || directorySize === ZIP64_SENTINEL) {
    throw new ZipError("unsupported_feature", "ZIP64 archives are not supported")
  }
  if (totalEntries > limits.maxFiles) {
    throw new ZipError("too_many_entries", `archive declares ${totalEntries} entries`)
  }
  if (directoryOffset + directorySize > buffer.length) {
    throw new ZipError("invalid_archive", "central directory extends past end of archive")
  }

  // Canonical layout, part one: nothing sits between the directory and the end
  // record, and there is no archive comment.
  //
  // An `.owapp` is produced by one deterministic writer, so every byte has a
  // place. Slack anywhere in the container is somewhere to carry content the
  // metadata never has to declare — which would make "the metadata closes the
  // archive" true of the entry list but not of the file.
  if (archiveCommentLength !== 0) {
    throw new ZipError("non_canonical_layout", "archive carries a trailing comment")
  }
  if (directoryOffset + directorySize !== endOffset) {
    throw new ZipError(
      "non_canonical_layout",
      "central directory does not end where the end record begins",
    )
  }

  const entries: CentralEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + CENTRAL_HEADER_SIZE > buffer.length) {
      throw new ZipError("invalid_archive", "truncated central directory")
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ZipError("invalid_archive", "bad central directory header signature")
    }
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const nameStart = cursor + CENTRAL_HEADER_SIZE
    if (nameStart + nameLength > buffer.length) {
      throw new ZipError("invalid_archive", "truncated central directory entry name")
    }
    if (extraLength !== 0 || commentLength !== 0) {
      throw new ZipError(
        "non_canonical_layout",
        "central directory entry carries extra fields or a comment",
      )
    }
    entries.push({
      path: buffer.subarray(nameStart, nameStart + nameLength).toString("utf8"),
      flags: buffer.readUInt16LE(cursor + 8),
      method: buffer.readUInt16LE(cursor + 10),
      crc: buffer.readUInt32LE(cursor + 16),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      madeBy: buffer.readUInt16LE(cursor + 4) >> 8,
      externalAttributes: buffer.readUInt32LE(cursor + 38),
      localOffset: buffer.readUInt32LE(cursor + 42),
    })
    cursor = nameStart + nameLength + extraLength + commentLength
  }
  if (cursor !== endOffset) {
    throw new ZipError("non_canonical_layout", "central directory contains unaccounted bytes")
  }
  return { entries, directoryOffset }
}

/**
 * Read every entry, refusing anything that could escape the destination or blow
 * up memory. Returns decompressed content; nothing is written to disk here.
 */
export function readZip(buffer: Buffer, limits: ZipLimits): ZipEntry[] {
  const { entries: central, directoryOffset } = readCentralDirectory(buffer, limits)
  const seen = new Set<string>()
  const result: ZipEntry[] = []
  /** Byte ranges each entry occupies, for the contiguity check below. */
  const spans: { start: number; end: number }[] = []
  let totalUncompressed = 0

  for (const entry of central) {
    if (entry.path.endsWith("/")) {
      throw new ZipError("directory_entry", `archive contains a directory entry: ${entry.path}`)
    }
    if (!isSafeArchivePath(entry.path)) {
      throw new ZipError("path_traversal", `unsafe archive path: ${JSON.stringify(entry.path)}`)
    }
    if (seen.has(entry.path)) {
      throw new ZipError("duplicate_entry", `duplicate archive path: ${entry.path}`)
    }
    seen.add(entry.path)

    if (entry.madeBy === UNIX_MADE_BY && ((entry.externalAttributes >>> 16) & S_IFMT) === S_IFLNK) {
      throw new ZipError("symlink_entry", `archive contains a symbolic link: ${entry.path}`)
    }
    if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipError("unsupported_feature", `encrypted entry: ${entry.path}`)
    }
    if ((entry.flags & FLAG_DATA_DESCRIPTOR) !== 0) {
      throw new ZipError("unsupported_feature", `entry uses a data descriptor: ${entry.path}`)
    }
    if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
      throw new ZipError("unsupported_feature", `unsupported compression method ${entry.method}`)
    }
    if (entry.uncompressedSize === ZIP64_SENTINEL || entry.compressedSize === ZIP64_SENTINEL) {
      throw new ZipError("unsupported_feature", "ZIP64 sizes are not supported")
    }
    if (entry.uncompressedSize > limits.maxFileBytes) {
      throw new ZipError("entry_too_large", `${entry.path} declares ${entry.uncompressedSize} bytes`)
    }
    // Refuse the bomb before allocating for it, using the declared size.
    if (
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio
    ) {
      throw new ZipError("compression_bomb", `${entry.path} has an implausible compression ratio`)
    }
    totalUncompressed += entry.uncompressedSize
    if (totalUncompressed > limits.maxUnpackedBytes) {
      throw new ZipError("archive_too_large", "unpacked size exceeds the allowed total")
    }

    const localOffset = entry.localOffset
    if (localOffset + LOCAL_HEADER_SIZE > buffer.length) {
      throw new ZipError("invalid_archive", `local header out of range for ${entry.path}`)
    }
    if (buffer.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new ZipError("invalid_archive", `bad local header signature for ${entry.path}`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const localName = buffer
      .subarray(localOffset + LOCAL_HEADER_SIZE, localOffset + LOCAL_HEADER_SIZE + localNameLength)
      .toString("utf8")
    // A directory that disagrees with its local headers is the classic way to
    // show one file to a validator and extract another.
    if (localName !== entry.path) {
      throw new ZipError(
        "header_mismatch",
        `local header names ${JSON.stringify(localName)} but the directory names ${JSON.stringify(entry.path)}`,
      )
    }
    // Local header layout: signature(4) version(2) flags(2) method(2) ...
    if (buffer.readUInt16LE(localOffset + 8) !== entry.method) {
      throw new ZipError("header_mismatch", `compression method mismatch for ${entry.path}`)
    }

    if (localExtraLength !== 0) {
      throw new ZipError(
        "non_canonical_layout",
        `local header for ${entry.path} carries extra fields`,
      )
    }

    const dataStart = localOffset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength
    const dataEnd = dataStart + entry.compressedSize
    if (dataEnd > buffer.length) {
      throw new ZipError("invalid_archive", `entry data out of range for ${entry.path}`)
    }
    spans.push({ start: localOffset, end: dataEnd })
    const raw = buffer.subarray(dataStart, dataEnd)

    let content: Buffer
    if (entry.method === METHOD_STORE) {
      content = Buffer.from(raw)
    } else {
      try {
        content = inflateRawSync(raw, { maxOutputLength: limits.maxFileBytes })
      } catch {
        throw new ZipError("compression_bomb", `${entry.path} failed to inflate within limits`)
      }
    }

    if (content.length !== entry.uncompressedSize) {
      throw new ZipError("header_mismatch", `size mismatch for ${entry.path}`)
    }
    if (crc32(content) !== entry.crc) {
      throw new ZipError("checksum_mismatch", `CRC mismatch for ${entry.path}`)
    }

    result.push({ path: entry.path, content })
  }

  // Canonical layout, part two: the payload stream is exactly these entries, back
  // to back, starting at byte zero and ending where the directory begins.
  //
  // Together with the directory checks this accounts for every byte in the file.
  // Without it an entry can exist in the local-header stream with no central
  // record — invisible to this reader and to the metadata closure, but present on
  // disk and listed by streaming extractors.
  spans.sort((a, b) => a.start - b.start)
  let expected = 0
  for (const span of spans) {
    if (span.start !== expected) {
      throw new ZipError("non_canonical_layout", "archive contains bytes no entry accounts for")
    }
    expected = span.end
  }
  if (expected !== directoryOffset) {
    throw new ZipError(
      "non_canonical_layout",
      "archive contains bytes between the last entry and the central directory",
    )
  }

  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
