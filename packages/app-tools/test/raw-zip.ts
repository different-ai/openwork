import { deflateRawSync } from "node:zlib"

import { crc32 } from "../src/zip.js"

// A deliberately permissive ZIP writer, for tests only.
//
// The production writer refuses unsafe paths, so it cannot produce the archives
// an attacker would. This one produces them on demand: traversal paths, symlink
// entries, ZIP64 sentinels, duplicate names, headers that disagree with the
// directory. Every field a hardened reader must police is settable here.

export type RawEntry = {
  path: string
  content: Uint8Array
  /** Name written into the local header, when it should differ from the directory. */
  localPathOverride?: string
  /** 0 = store, 8 = deflate. Any other value exercises the unsupported-method path. */
  method?: number
  /** Overrides the uncompressed size in both headers. */
  declaredSize?: number
  /** Overrides the CRC in both headers. */
  crcOverride?: number
  flags?: number
  /** High byte of "version made by". 3 marks a unix archive. */
  madeBy?: number
  externalAttributes?: number
  zip64Sizes?: boolean
}

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50

export function buildRawZip(entries: readonly RawEntry[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const content = Buffer.from(entry.content)
    const method = entry.method ?? 8
    const compressed = method === 8 ? deflateRawSync(content, { level: 9 }) : content
    const crc = entry.crcOverride ?? crc32(content)
    const size = entry.zip64Sizes ? 0xffffffff : (entry.declaredSize ?? content.length)
    const compressedSize = entry.zip64Sizes ? 0xffffffff : compressed.length
    const localName = Buffer.from(entry.localPathOverride ?? entry.path, "utf8")
    const centralName = Buffer.from(entry.path, "utf8")
    const flags = entry.flags ?? 0x0800

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x0021, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressedSize, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(localName.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, localName, compressed)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    record.writeUInt16LE(((entry.madeBy ?? 0) << 8) | 20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(flags, 8)
    record.writeUInt16LE(method, 10)
    record.writeUInt16LE(0, 12)
    record.writeUInt16LE(0x0021, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(compressedSize, 20)
    record.writeUInt32LE(size, 24)
    record.writeUInt16LE(centralName.length, 28)
    record.writeUInt16LE(0, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE(entry.externalAttributes ?? 0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, centralName)

    offset += local.length + localName.length + compressed.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_SIGNATURE, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuffer, end])
}

/** A unix "made by" archive whose external attributes mark the entry a symlink. */
export const SYMLINK_ATTRIBUTES = (0xa1ff << 16) >>> 0
export const UNIX_MADE_BY = 3
