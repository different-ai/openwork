import { deflateRawSync, inflateRawSync } from "node:zlib";
import { Parser } from "htmlparser2";

/**
 * Bounded OOXML package primitives shared by the Office attachment normalizer
 * and the spreadsheet tools: a defensive ZIP reader, a minimal ZIP writer, and
 * DTD-free XML text helpers. Every limit here protects the engine process from
 * hostile workbooks, so callers must not bypass them.
 */

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_FLAG_ENCRYPTED = 0x0001;
const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP_FLAG_STRONG_ENCRYPTION = 0x0040;
const ZIP_STORED = 0;
const ZIP_DEFLATE = 8;
export const MAX_COMPRESSED_BYTES = 12 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 128;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;
export const MAX_ENTRY_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 100;

export type ZipEntry = {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

export type ZipFileInput = {
  name: string;
  data: Buffer;
};

export type XmlBlock = {
  attributes: Record<string, string>;
  inner: string;
};

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (offset < 0 || buffer.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw new Error("ZIP end-of-central-directory not found.");
}

function rejectUnsafeZipFlags(flags: number, name: string): void {
  if ((flags & ZIP_FLAG_ENCRYPTED) !== 0) throw new Error(`ZIP entry ${name} is encrypted.`);
  if ((flags & ZIP_FLAG_STRONG_ENCRYPTION) !== 0) throw new Error(`ZIP entry ${name} uses strong encryption.`);
}

/**
 * Excel, Google Sheets exports, and streaming writers set the data-descriptor
 * flag and leave the local header sizes at zero. The validated central
 * directory is authoritative for every bound, so a local header may either
 * repeat those sizes or omit them; anything else is a corrupt archive.
 */
function localSizeMatches(localFlags: number, localSize: number, centralSize: number): boolean {
  if (localSize === centralSize) return true;
  return (localFlags & ZIP_FLAG_DATA_DESCRIPTOR) !== 0 && localSize === 0;
}

export function listZipEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.byteLength > MAX_COMPRESSED_BYTES) throw new Error("ZIP input exceeds compressed byte limit.");
  const eocd = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const countOnDisk = buffer.readUInt16LE(eocd + 8);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const centralEnd = centralOffset + centralSize;
  if (disk !== 0 || centralDisk !== 0 || countOnDisk !== count) throw new Error("Multi-disk ZIP archives are not supported.");
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported.");
  if (count > MAX_ZIP_ENTRIES) throw new Error(`ZIP entry count ${count} exceeds limit ${MAX_ZIP_ENTRIES}.`);
  if (centralOffset + centralSize > buffer.byteLength) throw new Error("ZIP central directory is out of bounds.");
  if (centralEnd > eocd) throw new Error("ZIP central directory overlaps the end-of-central-directory record.");

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > centralEnd || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_HEADER) throw new Error("Invalid ZIP central directory entry.");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported.");
    if (cursor + 46 + nameLength + extraLength + commentLength > centralEnd) throw new Error("ZIP central directory entry is out of bounds.");
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    rejectUnsafeZipFlags(flags, name);
    if (method !== ZIP_STORED && method !== ZIP_DEFLATE) throw new Error(`ZIP entry ${name} uses unsupported compression method ${method}.`);
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) throw new Error(`ZIP entry ${name} exceeds per-entry uncompressed limit.`);
    if (uncompressedSize > 0 && compressedSize === 0) throw new Error(`ZIP entry ${name} has an invalid compression ratio.`);
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_ZIP_COMPRESSION_RATIO) throw new Error(`ZIP entry ${name} exceeds compression ratio limit.`);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error("ZIP archive exceeds total uncompressed limit.");
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralEnd) throw new Error("ZIP central directory size does not match its entries.");
  return entries;
}

export function readZipEntryData(buffer: Buffer, entry: ZipEntry): Buffer {
  const cursor = entry.localOffset;
  if (cursor + 30 > buffer.byteLength || buffer.readUInt32LE(cursor) !== ZIP_LOCAL_FILE_HEADER) throw new Error(`Invalid local ZIP header for ${entry.name}.`);
  const localFlags = buffer.readUInt16LE(cursor + 6);
  const localMethod = buffer.readUInt16LE(cursor + 8);
  const localCompressedSize = buffer.readUInt32LE(cursor + 18);
  const localUncompressedSize = buffer.readUInt32LE(cursor + 22);
  const nameLength = buffer.readUInt16LE(cursor + 26);
  const extraLength = buffer.readUInt16LE(cursor + 28);
  rejectUnsafeZipFlags(localFlags, entry.name);
  if (localMethod !== entry.method) throw new Error(`ZIP method mismatch for ${entry.name}.`);
  if (!localSizeMatches(localFlags, localCompressedSize, entry.compressedSize) || !localSizeMatches(localFlags, localUncompressedSize, entry.uncompressedSize)) throw new Error(`ZIP size mismatch for ${entry.name}.`);
  if (cursor + 30 + nameLength + extraLength > buffer.byteLength) throw new Error(`ZIP local header for ${entry.name} is out of bounds.`);
  const localName = buffer.toString("utf8", cursor + 30, cursor + 30 + nameLength);
  if (localName !== entry.name) throw new Error(`ZIP local header name mismatch for ${entry.name}.`);
  const dataStart = cursor + 30 + nameLength + extraLength;
  if (dataStart + entry.compressedSize > buffer.byteLength) throw new Error(`ZIP data for ${entry.name} is out of bounds.`);
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  const data = entry.method === ZIP_STORED ? compressed : inflateRawSync(compressed);
  if (data.byteLength !== entry.uncompressedSize) throw new Error(`ZIP uncompressed size mismatch for ${entry.name}.`);
  return data;
}

export function zipEntryMap(entries: ZipEntry[]): Map<string, ZipEntry> {
  const map = new Map<string, ZipEntry>();
  for (const entry of entries) map.set(entry.name, entry);
  return map;
}

export function readZipTextEntry(bytes: Buffer, entries: Map<string, ZipEntry>, name: string): string | null {
  const entry = entries.get(name);
  if (!entry) return null;
  const xml = readZipEntryData(bytes, entry).toString("utf8");
  assertSafeOfficeXml(xml);
  return xml;
}

let crcTable: Uint32Array | null = null;

function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a deflated ZIP archive that `listZipEntries` accepts: no data
 * descriptors, no ZIP64, one disk, and entry sizes recorded in both headers.
 */
export function buildZip(files: ZipFileInput[]): Buffer {
  if (files.length > MAX_ZIP_ENTRIES) throw new Error(`ZIP entry count ${files.length} exceeds limit ${MAX_ZIP_ENTRIES}.`);
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  let totalUncompressed = 0;

  for (const file of files) {
    if (file.data.byteLength > MAX_ENTRY_UNCOMPRESSED_BYTES) throw new Error(`ZIP entry ${file.name} exceeds per-entry uncompressed limit.`);
    totalUncompressed += file.data.byteLength;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error("ZIP archive exceeds total uncompressed limit.");
    const deflated = deflateRawSync(file.data);
    const useDeflate = deflated.byteLength < file.data.byteLength;
    const stored = useDeflate ? deflated : file.data;
    const method = useDeflate ? ZIP_DEFLATE : ZIP_STORED;
    const name = Buffer.from(file.name, "utf8");
    const checksum = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.byteLength, 18);
    local.writeUInt32LE(file.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localChunks.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(stored.byteLength, 20);
    central.writeUInt32LE(file.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);
    offset += local.byteLength + name.byteLength + stored.byteLength;
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localChunks, ...centralChunks, end]);
}

export function assertSafeOfficeXml(xml: string): void {
  if (Buffer.byteLength(xml, "utf8") > MAX_ENTRY_UNCOMPRESSED_BYTES) throw new Error("Office XML exceeds the parser input limit.");
  const lower = xml.toLowerCase();
  if (lower.includes("<!doctype") || lower.includes("<!entity")) throw new Error("Office XML DTD and entity declarations are not supported.");
}

function xmlLocalName(name: string): string {
  const colon = name.lastIndexOf(":");
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

export function parsedXmlText(xml: string, tagSeparator: string): string {
  assertSafeOfficeXml(xml);
  let text = "";
  let omittedDepth = 0;
  const omittedSeparator = tagSeparator || " ";
  const parser = new Parser({
    onopentag(name) {
      if (omittedDepth > 0) {
        omittedDepth += 1;
      } else if (xmlLocalName(name) === "script" || xmlLocalName(name) === "style") {
        text += omittedSeparator;
        omittedDepth = 1;
      } else {
        text += tagSeparator;
      }
    },
    ontext(value) {
      if (omittedDepth === 0) text += value;
    },
    onclosetag() {
      if (omittedDepth > 0) {
        omittedDepth -= 1;
        if (omittedDepth === 0) text += omittedSeparator;
      } else {
        text += tagSeparator;
      }
    },
  }, { decodeEntities: true, xmlMode: true });
  parser.end(xml);
  return text;
}

export function decodedXmlValue(value: string): string {
  return parsedXmlText(`<openwork-value>${value}</openwork-value>`, "");
}

export function xmlText(xml: string): string {
  return parsedXmlText(xml, " ").replace(/\s+/g, " ").trim();
}

function xmlTagPattern(name: string): string {
  return `(?:[A-Za-z_][\\w.-]*:)?${name}`;
}

function xmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const regex = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source))) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? "";
    attributes[name] = decodedXmlValue(value);
  }
  return attributes;
}

export function xmlBlocks(xml: string, name: string): XmlBlock[] {
  const tag = xmlTagPattern(name);
  const regex = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "g");
  const blocks: XmlBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml))) {
    blocks.push({ attributes: xmlAttributes(match[1]), inner: match[2] });
  }
  return blocks;
}

export function xmlStartTagAttributes(xml: string, name: string): Array<Record<string, string>> {
  const tag = xmlTagPattern(name);
  const regex = new RegExp(`<${tag}\\b([^>]*)\\/?\\s*>`, "g");
  const attributes: Array<Record<string, string>> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml))) attributes.push(xmlAttributes(match[1]));
  return attributes;
}

export function firstXmlText(xml: string, name: string): string | undefined {
  const block = xmlBlocks(xml, name)[0];
  if (!block) return undefined;
  return parsedXmlText(block.inner, "").trim();
}

/**
 * Iterate `<name ...>...</name>` blocks including self-closing `<name .../>`
 * forms. Used for worksheet cells, where empty styled cells are self-closing.
 */
export function xmlElements(xml: string, name: string): XmlBlock[] {
  const tag = xmlTagPattern(name);
  const regex = new RegExp(`<${tag}\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/${tag}>)`, "g");
  const blocks: XmlBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml))) {
    blocks.push({ attributes: xmlAttributes(match[1]), inner: match[3] ?? "" });
  }
  return blocks;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

export function normalizedZipPath(...segments: string[]): string {
  const parts: string[] = [];
  for (const segment of segments.join("/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

export function relationshipTargets(xml: string | null, basePath: string): Map<string, string> {
  const targets = new Map<string, string>();
  if (!xml) return targets;
  for (const attributes of xmlStartTagAttributes(xml, "Relationship")) {
    const id = attributes.Id;
    const target = attributes.Target;
    if (!id || !target || attributes.TargetMode === "External" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    targets.set(id, target.startsWith("/") ? normalizedZipPath(target.slice(1)) : normalizedZipPath(basePath, target));
  }
  return targets;
}
