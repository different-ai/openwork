import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;

function nowMs() {
  return Date.now();
}

function isSecretName(name) {
  const lower = String(name ?? "").toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if (lower === "credentials.json" || lower === "credentials.yml" || lower === "credentials.yaml") return true;
  return lower.endsWith(".key") || lower.endsWith(".pem") || lower.endsWith(".p12") || lower.endsWith(".pfx");
}

function normalizeZipPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectoryEmpty(targetPath) {
  try {
    const entries = await readdir(targetPath);
    return entries.length === 0;
  } catch {
    return true;
  }
}

async function collectFiles(root, current = root) {
  const out = [];
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(root, absolute)));
    } else if (entry.isFile()) {
      const rel = normalizeZipPath(path.relative(root, absolute));
      out.push({ absolute, rel });
    }
  }
  return out;
}

async function collectWorkspaceEntries(workspaceRoot) {
  const entries = [];
  const excluded = [];

  const configPath = path.join(workspaceRoot, "opencode.json");
  if (await pathExists(configPath)) {
    if (isSecretName(path.basename(configPath))) {
      excluded.push("opencode.json");
    } else {
      entries.push({ absolute: configPath, rel: "opencode.json" });
    }
  }

  const opencodeDir = path.join(workspaceRoot, ".opencode");
  if (await pathExists(opencodeDir)) {
    for (const file of await collectFiles(workspaceRoot, opencodeDir)) {
      if (isSecretName(path.basename(file.absolute))) {
        if (!excluded.includes(file.rel)) excluded.push(file.rel);
        continue;
      }
      entries.push(file);
    }
  }

  return { entries, excluded };
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localFileHeader(nameBuffer, data, checksum) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralDirectoryHeader(nameBuffer, data, checksum, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_HEADER, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(entryCount, 8);
  header.writeUInt16LE(entryCount, 10);
  header.writeUInt32LE(centralSize, 12);
  header.writeUInt32LE(centralOffset, 16);
  header.writeUInt16LE(0, 20);
  return header;
}

async function writeZip(outputPath, files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const checksum = crc32(data);
    const local = localFileHeader(nameBuffer, data, checksum);
    chunks.push(local, nameBuffer, data);
    central.push(centralDirectoryHeader(nameBuffer, data, checksum, offset), nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  chunks.push(...central, endOfCentralDirectory(files.length, centralSize, centralOffset));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.concat(chunks));
}

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error("Failed to find ZIP central directory.");
}

function listZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new Error("Invalid ZIP central directory entry.");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntryData(buffer, entry) {
  const cursor = entry.localOffset;
  if (buffer.readUInt32LE(cursor) !== ZIP_LOCAL_FILE_HEADER) {
    throw new Error(`Invalid ZIP local header for ${entry.name}.`);
  }
  const nameLength = buffer.readUInt16LE(cursor + 26);
  const extraLength = buffer.readUInt16LE(cursor + 28);
  const dataStart = cursor + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return zlib.inflateRawSync(compressed, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}.`);
}

function isSafeArchivePath(name) {
  if (!name || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  const normalized = normalizeZipPath(name);
  return !normalized.split("/").some((part) => part === ".." || part === "");
}

function defaultOpenworkConfig(targetDir, preset = "starter") {
  return {
    version: 1,
    workspace: {
      name: path.basename(targetDir) || "Workspace",
      createdAt: nowMs(),
      preset,
    },
    authorizedRoots: [targetDir],
    reload: null,
  };
}

export async function exportWorkspaceConfig({ workspace, outputPath }) {
  if (!workspace?.path || workspace.workspaceType === "remote") {
    throw new Error("Workspace export is only supported for local workspaces");
  }
  const workspaceRoot = workspace.path;
  if (!(await pathExists(workspaceRoot))) {
    throw new Error(`Workspace path not found: ${workspaceRoot}`);
  }

  const { entries, excluded } = await collectWorkspaceEntries(workspaceRoot);
  if (entries.length === 0) throw new Error("No workspace config files found to export");

  const files = [];
  const included = [];
  for (const entry of entries) {
    files.push({ name: entry.rel, data: await readFile(entry.absolute) });
    included.push(entry.rel);
  }
  files.push({
    name: "manifest.json",
    data: `${JSON.stringify({
      version: 1,
      createdAtMs: nowMs(),
      workspace: { id: workspace.id, name: workspace.name, path: workspace.path },
      included,
      excluded,
    }, null, 2)}\n`,
  });
  await writeZip(outputPath, files);
  return { outputPath, included: included.length, excluded };
}

export async function importWorkspaceConfig({ archivePath, targetDir, name }) {
  if (await pathExists(targetDir)) {
    if (!(await isDirectoryEmpty(targetDir))) throw new Error("Target folder must be empty");
  }
  await mkdir(targetDir, { recursive: true });

  const buffer = await readFile(archivePath);
  for (const entry of listZipEntries(buffer)) {
    if (entry.name === "manifest.json" || entry.name.endsWith("/")) continue;
    if (!isSafeArchivePath(entry.name)) throw new Error("Archive contains an unsafe path");
    if (!(entry.name === "opencode.json" || entry.name.startsWith(".opencode/"))) continue;
    if (isSecretName(path.basename(entry.name))) continue;
    const outPath = path.join(targetDir, ...entry.name.split("/"));
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, readZipEntryData(buffer, entry));
  }

  const opencodeDir = path.join(targetDir, ".opencode");
  if (!(await pathExists(opencodeDir))) throw new Error("Archive is missing .opencode config");

  const openworkPath = path.join(opencodeDir, "openwork.json");
  let preset = "starter";
  let workspaceName = typeof name === "string" && name.trim() ? name.trim() : null;

  if (await pathExists(openworkPath)) {
    const raw = await readFile(openworkPath, "utf8");
    try {
      const config = JSON.parse(raw);
      config.authorizedRoots = [targetDir];
      if (!workspaceName && typeof config.workspace?.name === "string" && config.workspace.name.trim()) {
        workspaceName = config.workspace.name.trim();
      }
      if (typeof config.workspace?.preset === "string" && config.workspace.preset.trim()) {
        preset = config.workspace.preset.trim();
      }
      await writeFile(openworkPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    } catch {
      const config = defaultOpenworkConfig(targetDir, preset);
      await writeFile(openworkPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    }
  } else {
    const config = defaultOpenworkConfig(targetDir, preset);
    await writeFile(openworkPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  return {
    workspaceName: workspaceName || path.basename(targetDir) || "Workspace",
    preset,
  };
}
