import { Parser } from "htmlparser2";

/**
 * Bounded OOXML package primitives shared by the Office attachment normalizer,
 * the spreadsheet tools, and the artifact spreadsheet preview: a defensive ZIP
 * reader, a minimal ZIP writer, and DTD-free XML text helpers. Everything here
 * is platform-neutral (Uint8Array, DataView, TextEncoder, and the Web Streams
 * compression API), so the same code runs in Node, Bun, and Chromium. Every
 * limit protects the host process from hostile workbooks; callers must not
 * bypass them.
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
  data: Uint8Array;
};

export type XmlBlock = {
  attributes: Record<string, string>;
  inner: string;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

export function utf8Bytes(text: string): Uint8Array {
  return textEncoder.encode(text);
}

export function utf8Text(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).byteLength;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readStreamBounded(stream: ReadableStream<Uint8Array>, limit: number, label: string): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`ZIP entry ${label} inflated beyond its declared size.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes(chunks);
}

function byteStream(data: Uint8Array): ReadableStream<BufferSource> {
  // Copy into a plain ArrayBuffer-backed view: callers may pass Node Buffers or
  // views over shared memory, which the streams API does not accept.
  const chunk = new Uint8Array(data.byteLength);
  chunk.set(data);
  return new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function inflateRaw(data: Uint8Array, limit: number, label: string): Promise<Uint8Array> {
  const stream = byteStream(data).pipeThrough(new DecompressionStream("deflate-raw"));
  return await readStreamBounded(stream, limit, label);
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = byteStream(data).pipeThrough(new CompressionStream("deflate-raw"));
  return await readStreamBounded(stream, MAX_ENTRY_UNCOMPRESSED_BYTES + 1024, "(deflate)");
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = dataView(bytes);
  const start = Math.max(0, bytes.byteLength - 0xffff - 22);
  for (let offset = bytes.byteLength - 22; offset >= start; offset -= 1) {
    if (offset < 0 || view.getUint32(offset, true) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
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

export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  if (bytes.byteLength > MAX_COMPRESSED_BYTES) throw new Error("ZIP input exceeds compressed byte limit.");
  const view = dataView(bytes);
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const countOnDisk = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const centralEnd = centralOffset + centralSize;
  if (disk !== 0 || centralDisk !== 0 || countOnDisk !== count) throw new Error("Multi-disk ZIP archives are not supported.");
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported.");
  if (count > MAX_ZIP_ENTRIES) throw new Error(`ZIP entry count ${count} exceeds limit ${MAX_ZIP_ENTRIES}.`);
  if (centralOffset + centralSize > bytes.byteLength) throw new Error("ZIP central directory is out of bounds.");
  if (centralEnd > eocd) throw new Error("ZIP central directory overlaps the end-of-central-directory record.");

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > centralEnd || view.getUint32(cursor, true) !== ZIP_CENTRAL_DIRECTORY_HEADER) throw new Error("Invalid ZIP central directory entry.");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported.");
    if (cursor + 46 + nameLength + extraLength + commentLength > centralEnd) throw new Error("ZIP central directory entry is out of bounds.");
    const name = utf8Text(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
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

export async function readZipEntryData(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = dataView(bytes);
  const cursor = entry.localOffset;
  if (cursor + 30 > bytes.byteLength || view.getUint32(cursor, true) !== ZIP_LOCAL_FILE_HEADER) throw new Error(`Invalid local ZIP header for ${entry.name}.`);
  const localFlags = view.getUint16(cursor + 6, true);
  const localMethod = view.getUint16(cursor + 8, true);
  const localCompressedSize = view.getUint32(cursor + 18, true);
  const localUncompressedSize = view.getUint32(cursor + 22, true);
  const nameLength = view.getUint16(cursor + 26, true);
  const extraLength = view.getUint16(cursor + 28, true);
  rejectUnsafeZipFlags(localFlags, entry.name);
  if (localMethod !== entry.method) throw new Error(`ZIP method mismatch for ${entry.name}.`);
  if (!localSizeMatches(localFlags, localCompressedSize, entry.compressedSize) || !localSizeMatches(localFlags, localUncompressedSize, entry.uncompressedSize)) throw new Error(`ZIP size mismatch for ${entry.name}.`);
  if (cursor + 30 + nameLength + extraLength > bytes.byteLength) throw new Error(`ZIP local header for ${entry.name} is out of bounds.`);
  const localName = utf8Text(bytes.subarray(cursor + 30, cursor + 30 + nameLength));
  if (localName !== entry.name) throw new Error(`ZIP local header name mismatch for ${entry.name}.`);
  const dataStart = cursor + 30 + nameLength + extraLength;
  if (dataStart + entry.compressedSize > bytes.byteLength) throw new Error(`ZIP data for ${entry.name} is out of bounds.`);
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  const data = entry.method === ZIP_STORED ? compressed.slice() : await inflateRaw(compressed, entry.uncompressedSize, entry.name);
  if (data.byteLength !== entry.uncompressedSize) throw new Error(`ZIP uncompressed size mismatch for ${entry.name}.`);
  return data;
}

export function zipEntryMap(entries: ZipEntry[]): Map<string, ZipEntry> {
  const map = new Map<string, ZipEntry>();
  for (const entry of entries) map.set(entry.name, entry);
  return map;
}

export async function readZipTextEntry(bytes: Uint8Array, entries: Map<string, ZipEntry>, name: string): Promise<string | null> {
  const entry = entries.get(name);
  if (!entry) return null;
  const xml = utf8Text(await readZipEntryData(bytes, entry));
  assertSafeOfficeXml(xml);
  return xml;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a deflated ZIP archive that `listZipEntries` accepts: no data
 * descriptors, no ZIP64, one disk, and entry sizes recorded in both headers.
 */
export async function buildZip(files: ZipFileInput[]): Promise<Uint8Array> {
  if (files.length > MAX_ZIP_ENTRIES) throw new Error(`ZIP entry count ${files.length} exceeds limit ${MAX_ZIP_ENTRIES}.`);
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;
  let totalUncompressed = 0;

  for (const file of files) {
    if (file.data.byteLength > MAX_ENTRY_UNCOMPRESSED_BYTES) throw new Error(`ZIP entry ${file.name} exceeds per-entry uncompressed limit.`);
    totalUncompressed += file.data.byteLength;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error("ZIP archive exceeds total uncompressed limit.");
    const deflated = await deflateRaw(file.data);
    // Store an entry that would compress past the reader's ratio bound, so a
    // workbook this writer produces is always one this reader accepts.
    const useDeflate = deflated.byteLength < file.data.byteLength
      && file.data.byteLength / Math.max(1, deflated.byteLength) <= MAX_ZIP_COMPRESSION_RATIO;
    const stored = useDeflate ? deflated : file.data;
    const method = useDeflate ? ZIP_DEFLATE : ZIP_STORED;
    const name = utf8Bytes(file.name);
    const checksum = crc32(file.data);

    const local = new Uint8Array(30);
    const localView = dataView(local);
    localView.setUint32(0, ZIP_LOCAL_FILE_HEADER, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, stored.byteLength, true);
    localView.setUint32(22, file.data.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    localChunks.push(local, name, stored);

    const central = new Uint8Array(46);
    const centralView = dataView(central);
    centralView.setUint32(0, ZIP_CENTRAL_DIRECTORY_HEADER, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, stored.byteLength, true);
    centralView.setUint32(24, file.data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    centralChunks.push(central, name);
    offset += local.byteLength + name.byteLength + stored.byteLength;
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = dataView(end);
  endView.setUint32(0, ZIP_END_OF_CENTRAL_DIRECTORY, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return concatBytes([...localChunks, ...centralChunks, end]);
}

export function assertSafeOfficeXml(xml: string): void {
  if (utf8ByteLength(xml) > MAX_ENTRY_UNCOMPRESSED_BYTES) throw new Error("Office XML exceeds the parser input limit.");
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
 * forms. Used for worksheet rows and cells, where empty styled cells are
 * self-closing.
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
