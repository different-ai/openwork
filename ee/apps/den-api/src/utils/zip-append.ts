const EOCD_SIGNATURE = 0x06054b50
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const MAX_UINT_16 = 0xffff
const MAX_UINT_32 = 0xffffffff
const EOCD_MIN_LENGTH = 22
const MAX_COMMENT_LENGTH = 0xffff

const CRC32_TABLE = Array.from({ length: 256 }, (_entry, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

type EndOfCentralDirectory = {
  offset: number
  entryCount: number
  centralDirectorySize: number
  centralDirectoryOffset: number
  comment: Buffer
}

function crc32(data: Buffer) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function findEndOfCentralDirectory(source: Buffer): EndOfCentralDirectory {
  const minOffset = Math.max(0, source.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH)
  for (let offset = source.length - EOCD_MIN_LENGTH; offset >= minOffset; offset -= 1) {
    if (source.readUInt32LE(offset) !== EOCD_SIGNATURE) {
      continue
    }

    const commentLength = source.readUInt16LE(offset + 20)
    if (offset + EOCD_MIN_LENGTH + commentLength !== source.length) {
      continue
    }

    const diskNumber = source.readUInt16LE(offset + 4)
    const centralDirectoryDisk = source.readUInt16LE(offset + 6)
    const diskEntryCount = source.readUInt16LE(offset + 8)
    const entryCount = source.readUInt16LE(offset + 10)
    const centralDirectorySize = source.readUInt32LE(offset + 12)
    const centralDirectoryOffset = source.readUInt32LE(offset + 16)

    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== entryCount) {
      throw new Error("Multi-disk zip archives are not supported")
    }
    if (entryCount === MAX_UINT_16 || centralDirectorySize === MAX_UINT_32 || centralDirectoryOffset === MAX_UINT_32) {
      throw new Error("Zip64 archives are not supported")
    }
    if (offset >= 20 && source.readUInt32LE(offset - 20) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
      throw new Error("Zip64 archives are not supported")
    }
    if (centralDirectoryOffset + centralDirectorySize > offset) {
      throw new Error("Zip central directory is malformed")
    }

    return {
      offset,
      entryCount,
      centralDirectorySize,
      centralDirectoryOffset,
      comment: source.subarray(offset + EOCD_MIN_LENGTH, offset + EOCD_MIN_LENGTH + commentLength),
    }
  }

  throw new Error("Zip end-of-central-directory record was not found")
}

function dosTimestamp(date = new Date()) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const seconds = Math.floor(date.getSeconds() / 2)

  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  }
}

function assertFitsUint32(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT_32) {
    throw new Error(`${label} is too large for this zip writer`)
  }
}

function assertFitsUint16(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT_16) {
    throw new Error(`${label} is too large for this zip writer`)
  }
}

function writeBytes(target: Buffer, source: Buffer, offset: number) {
  for (let index = 0; index < source.length; index += 1) {
    target[offset + index] = source[index]
  }
}

function createLocalHeader(entryName: Buffer, content: Buffer, modTime: number, modDate: number, checksum: number) {
  assertFitsUint16(entryName.length, "Entry name")
  assertFitsUint32(content.length, "Entry content")

  const header = Buffer.alloc(30 + entryName.length)
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(modTime, 10)
  header.writeUInt16LE(modDate, 12)
  header.writeUInt32LE(checksum, 14)
  header.writeUInt32LE(content.length, 18)
  header.writeUInt32LE(content.length, 22)
  header.writeUInt16LE(entryName.length, 26)
  header.writeUInt16LE(0, 28)
  writeBytes(header, entryName, 30)
  return header
}

function createCentralDirectoryHeader(
  entryName: Buffer,
  content: Buffer,
  localHeaderOffset: number,
  modTime: number,
  modDate: number,
  checksum: number,
) {
  assertFitsUint16(entryName.length, "Entry name")
  assertFitsUint32(content.length, "Entry content")
  assertFitsUint32(localHeaderOffset, "Local header offset")

  const header = Buffer.alloc(46 + entryName.length)
  header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(modTime, 12)
  header.writeUInt16LE(modDate, 14)
  header.writeUInt32LE(checksum, 16)
  header.writeUInt32LE(content.length, 20)
  header.writeUInt32LE(content.length, 24)
  header.writeUInt16LE(entryName.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE(0, 38)
  header.writeUInt32LE(localHeaderOffset, 42)
  writeBytes(header, entryName, 46)
  return header
}

function createEndOfCentralDirectory(entryCount: number, centralDirectorySize: number, centralDirectoryOffset: number, comment: Buffer) {
  assertFitsUint16(entryCount, "Central directory entry count")
  assertFitsUint32(centralDirectorySize, "Central directory size")
  assertFitsUint32(centralDirectoryOffset, "Central directory offset")
  assertFitsUint16(comment.length, "Zip comment")

  const eocd = Buffer.alloc(EOCD_MIN_LENGTH + comment.length)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entryCount, 8)
  eocd.writeUInt16LE(entryCount, 10)
  eocd.writeUInt32LE(centralDirectorySize, 12)
  eocd.writeUInt32LE(centralDirectoryOffset, 16)
  eocd.writeUInt16LE(comment.length, 20)
  writeBytes(eocd, comment, EOCD_MIN_LENGTH)
  return eocd
}

function toArrayBuffer(buffer: Buffer) {
  const bytes = new Uint8Array(buffer.byteLength)
  for (let index = 0; index < buffer.length; index += 1) {
    bytes[index] = buffer[index]
  }
  return bytes.buffer
}

export function appendStoredEntryToZip(sourceZip: Buffer, entryNameInput: string, contentInput: Buffer): ArrayBuffer {
  const source = sourceZip
  const entryName = Buffer.from(entryNameInput, "utf8")
  const content = contentInput
  const eocd = findEndOfCentralDirectory(source)
  const prefix = source.subarray(0, eocd.centralDirectoryOffset)
  const originalCentralDirectory = source.subarray(eocd.centralDirectoryOffset, eocd.centralDirectoryOffset + eocd.centralDirectorySize)
  const { time, date } = dosTimestamp()
  const checksum = crc32(content)
  const localHeader = createLocalHeader(entryName, content, time, date, checksum)
  const centralDirectoryHeader = createCentralDirectoryHeader(entryName, content, eocd.centralDirectoryOffset, time, date, checksum)
  const nextCentralDirectoryOffset = eocd.centralDirectoryOffset + localHeader.length + content.length
  const nextCentralDirectorySize = eocd.centralDirectorySize + centralDirectoryHeader.length
  const nextEocd = createEndOfCentralDirectory(eocd.entryCount + 1, nextCentralDirectorySize, nextCentralDirectoryOffset, eocd.comment)

  const output = Buffer.alloc(
    prefix.length + localHeader.length + content.length + originalCentralDirectory.length + centralDirectoryHeader.length + nextEocd.length,
  )
  let outputOffset = 0
  for (const chunk of [prefix, localHeader, content, originalCentralDirectory, centralDirectoryHeader, nextEocd]) {
    writeBytes(output, chunk, outputOffset)
    outputOffset += chunk.length
  }

  return toArrayBuffer(output)
}
