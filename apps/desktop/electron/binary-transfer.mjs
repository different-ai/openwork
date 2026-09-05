import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DESKTOP_TRANSFER_MAX_BYTES = 250_000_000;
const MAX_HEADERS = 64;
const MAX_FIELDS = 32;
const MAX_METADATA_LENGTH = 1_024;
const MAX_RESPONSE_TEXT_BYTES = 1_000_000;

function transferError(message, code) {
  return Object.assign(new Error(message), { code });
}

function boundedString(value, label, { required = false, maxLength = MAX_METADATA_LENGTH } = {}) {
  if (typeof value !== "string") {
    if (!required && value === undefined) return undefined;
    throw transferError(`${label} must be a string.`, "invalid-metadata");
  }
  const result = value.trim();
  if (required && !result) throw transferError(`${label} is required.`, "invalid-metadata");
  if (result.length > maxLength) throw transferError(`${label} is too long.`, "invalid-metadata");
  if (/\0|[\r\n]/.test(result)) throw transferError(`${label} contains invalid characters.`, "invalid-metadata");
  return result;
}

function boundedRecord(value, label, maximumEntries) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw transferError(`${label} must be an object.`, "invalid-metadata");
  }
  const entries = Object.entries(value);
  if (entries.length > maximumEntries) {
    throw transferError(`${label} has too many entries.`, "invalid-metadata");
  }
  return Object.fromEntries(entries.map(([key, entryValue]) => [
    boundedString(key, `${label} name`, { required: true, maxLength: 128 }),
    boundedString(entryValue, `${label} value`, { required: false, maxLength: 8_192 }) ?? "",
  ]));
}

function boundedByteCount(value, label, { allowUndefined = false } = {}) {
  if (allowUndefined && value === undefined) return DESKTOP_TRANSFER_MAX_BYTES;
  if (!Number.isSafeInteger(value)) throw transferError(`${label} must be an integer.`, "invalid-size");
  if (value === 0) throw transferError(`${label} must be greater than zero.`, "zero-byte-file");
  if (value < 0) throw transferError(`${label} must be greater than zero.`, "invalid-size");
  if (value > DESKTOP_TRANSFER_MAX_BYTES) {
    throw transferError(`${label} exceeds the ${DESKTOP_TRANSFER_MAX_BYTES}-byte limit.`, "file-too-large");
  }
  return value;
}

function urlWithinPrefix(candidate, prefixValue) {
  if (typeof prefixValue !== "string" || !prefixValue.trim()) return false;
  let prefix;
  try {
    prefix = new URL(prefixValue.trim());
  } catch {
    return false;
  }
  if (prefix.protocol !== candidate.protocol || prefix.host !== candidate.host) return false;
  const prefixPath = prefix.pathname.replace(/\/+$/, "");
  return !prefixPath || candidate.pathname === prefixPath || candidate.pathname.startsWith(`${prefixPath}/`);
}

function remoteUrl(value, allowedUrlPrefixes) {
  const raw = boundedString(value, "URL", { required: true, maxLength: 8_192 });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw transferError("URL is invalid.", "invalid-url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw transferError("URL must use HTTP or HTTPS.", "invalid-url");
  }
  if (["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw transferError("Dedicated file transfers are only available for remote destinations.", "loopback-url");
  }
  // The renderer never gets to pick an arbitrary destination: the URL must sit
  // under a remote workspace endpoint the main process itself has on record.
  const prefixes = Array.isArray(allowedUrlPrefixes) ? allowedUrlPrefixes : [];
  if (!prefixes.some((prefixValue) => urlWithinPrefix(parsed, prefixValue))) {
    throw transferError("URL does not belong to a connected remote workspace.", "unauthorized-url");
  }
  return parsed.toString();
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// A download destination must sit directly inside an authorized workspace
// root. The root itself is app-owned state that a workspace-content writer
// cannot rename, and exclusive creation never follows a final symlink, so no
// attacker-controllable directory component exists between this validation
// and the exclusive open: there is no parent that could be swapped for a
// symbolic link to redirect creation outside the workspace.
async function resolveAuthorizedPath(candidateValue, rootsValue) {
  const candidateRaw = boundedString(candidateValue, "Destination path", {
    required: true,
    maxLength: 32_768,
  });
  if (!path.isAbsolute(candidateRaw)) {
    throw transferError("Transfer path must be absolute.", "unauthorized-path");
  }
  const candidate = path.resolve(candidateRaw);
  const roots = Array.isArray(rootsValue) ? rootsValue : [];
  let insideNestedOnly = false;
  for (const rootValue of roots) {
    if (typeof rootValue !== "string" || !path.isAbsolute(rootValue)) continue;
    const root = path.resolve(rootValue);
    if (!isInside(root, candidate)) continue;
    if (candidate === root || path.dirname(candidate) !== root) {
      insideNestedOnly = true;
      continue;
    }
    const rootInfo = await lstat(root).catch(() => null);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
      throw transferError("Authorized workspace root is unavailable or symbolic.", "unauthorized-path");
    }
    const rootRealPath = await realpath(root).catch(() => null);
    if (!rootRealPath) continue;
    const existing = await lstat(candidate).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw transferError("Destination path must not be a symbolic link.", "symlink-path");
    }
    return { path: candidate, rootRealPath };
  }
  if (insideNestedOnly) {
    throw transferError(
      "Download destinations must sit directly inside an authorized workspace root.",
      "nested-destination",
    );
  }
  throw transferError("Transfer path is outside every authorized workspace root.", "unauthorized-path");
}

// Path-based validation is inherently time-of-check/time-of-use racy: a parent
// directory can be swapped for a symbolic link after validation. This binds the
// transfer to the opened file handle instead: the handle's device and inode
// must match the freshly resolved path, and that resolved path must still sit
// inside the authorized root. All bytes then flow through the verified handle,
// which no later path swap can redirect.
async function verifyOpenFileWithinRoot(file, candidatePath, rootRealPath, label) {
  const resolvedPath = await realpath(candidatePath).catch(() => null);
  if (!resolvedPath || !isInside(rootRealPath, resolvedPath)) {
    throw transferError(`${label} escapes the authorized workspace.`, "unauthorized-path");
  }
  const handleInfo = await file.stat();
  const pathInfo = await lstat(resolvedPath).catch(() => null);
  if (!pathInfo || pathInfo.dev !== handleInfo.dev || pathInfo.ino !== handleInfo.ino) {
    throw transferError(`${label} changed while the transfer was starting.`, "path-changed");
  }
  return handleInfo;
}

async function responseText(response, maximumBytes = MAX_RESPONSE_TEXT_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw transferError("Text response is too large.", "response-too-large");
    }
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

function responseMetadata(response) {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
  };
}

function timeoutSignal(timeoutMs, parentSignal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return parentSignal;
  return parentSignal
    ? AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

async function writeAll(file, value) {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
    if (bytesWritten === 0) throw transferError("Download could not be written.", "write-failed");
    offset += bytesWritten;
  }
}

// Uploads deliberately take bytes, not a path. The renderer only ever holds
// bytes it was already allowed to read (a user-selected File), so the main
// process gains no filesystem read authority on the renderer's behalf and no
// configuration value can widen what an upload may exfiltrate.
export async function uploadMultipartFromBytes(input, options) {
  const url = remoteUrl(input?.url, options?.allowedUrlPrefixes);
  const expectedBytes = boundedByteCount(input?.size, "File size");
  const bytes = input?.bytes;
  let data = null;
  if (bytes instanceof ArrayBuffer) {
    data = new Uint8Array(bytes);
  } else if (ArrayBuffer.isView(bytes)) {
    // Copy into an owned buffer so the payload is an immutable snapshot.
    data = new Uint8Array(bytes.byteLength);
    data.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
  if (!data) throw transferError("Upload bytes are required.", "invalid-file");
  boundedByteCount(data.byteLength, "File size");
  if (data.byteLength !== expectedBytes) {
    throw transferError(
      `File size changed: expected ${expectedBytes} bytes but received ${data.byteLength}.`,
      "size-mismatch",
    );
  }
  const filename = boundedString(input?.filename, "Filename", { required: true });
  if (filename !== path.basename(filename) || /[\\/]/.test(filename)) {
    throw transferError("Filename must not contain a path.", "invalid-metadata");
  }
  const fieldName = boundedString(input?.fieldName ?? "file", "File field name", { required: true, maxLength: 128 });
  const contentType = boundedString(input?.contentType, "Content type", { maxLength: 256 });
  const fields = boundedRecord(input?.fields, "Multipart fields", MAX_FIELDS);
  const headers = boundedRecord(input?.headers, "Headers", MAX_HEADERS);
  const method = boundedString(input?.method ?? "POST", "Method", { required: true, maxLength: 16 });
  const signal = timeoutSignal(input?.timeoutMs, options?.signal);
  const form = new FormData();
  form.append(fieldName, new Blob([data], contentType ? { type: contentType } : undefined), filename);
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const response = await options.fetcher(url, {
    method,
    headers,
    body: form,
    credentials: "omit",
    cache: "no-store",
    // The endpoint allowlist covers only the initial URL, so a redirect
    // must never be followed to an unvalidated destination.
    redirect: "error",
    signal,
  });
  return { ...responseMetadata(response), body: await responseText(response) };
}

// Downloads stream into a private staging file inside an app-owned directory
// first, and only a fully successful download is placed into the workspace.
// The staging directory sits outside every authorized workspace root, so a
// process with workspace write access cannot swap its parents; its cleanup is
// the only path-based removal this module performs. Inside the workspace the
// destination is created exclusively, verified by device and inode, written
// through the verified handle, and never unlinked by path: failure cleanup
// truncates through the handle instead.
export async function downloadBinaryToPath(input, options) {
  const url = remoteUrl(input?.url, options?.allowedUrlPrefixes);
  const destination = await resolveAuthorizedPath(input?.destinationPath, options?.authorizedRoots);
  const destinationPath = destination.path;
  const maxBytes = boundedByteCount(input?.maxBytes, "Maximum download size", { allowUndefined: true });
  const headers = boundedRecord(input?.headers, "Headers", MAX_HEADERS);
  const method = boundedString(input?.method ?? "GET", "Method", { required: true, maxLength: 16 });
  const signal = timeoutSignal(input?.timeoutMs, options?.signal);
  const stagingDir = boundedString(options?.stagingDir, "Staging directory", { required: true, maxLength: 32_768 });
  if (!path.isAbsolute(stagingDir)) {
    throw transferError("Staging directory must be absolute.", "invalid-staging");
  }
  let stagingPath;
  let stagingFile;
  let destinationFile;
  try {
    const response = await options.fetcher(url, {
      method,
      headers,
      credentials: "omit",
      cache: "no-store",
      // The endpoint allowlist covers only the initial URL, so a redirect
      // must never be followed to an unvalidated destination.
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      return { ...responseMetadata(response), body: await responseText(response), path: null, bytes: 0 };
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw transferError(`Download exceeds the ${maxBytes}-byte limit.`, "file-too-large");
    }
    await mkdir(stagingDir, { recursive: true });
    stagingPath = path.join(stagingDir, `download-${randomUUID()}.part`);
    stagingFile = await open(stagingPath, "wx+");
    const reader = response.body?.getReader();
    let bytes = 0;
    if (reader) {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw transferError(`Download exceeds the ${maxBytes}-byte limit.`, "file-too-large");
        }
        await writeAll(stagingFile, value);
      }
    }
    if (bytes === 0) throw transferError("Download response was empty.", "zero-byte-file");
    // Only a complete download reaches the workspace. Revalidate the
    // destination, create it exclusively ("wx" never follows a final
    // symlink), and prove by device and inode that the created file resides
    // inside the authorized root before a single byte is written to it.
    await resolveAuthorizedPath(input?.destinationPath, options?.authorizedRoots);
    try {
      destinationFile = await open(destinationPath, "wx");
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw transferError("Download destination already exists.", "destination-exists");
      }
      throw error;
    }
    await verifyOpenFileWithinRoot(destinationFile, destinationPath, destination.rootRealPath, "Download destination");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < bytes) {
      signal?.throwIfAborted();
      const { bytesRead } = await stagingFile.read(buffer, 0, Math.min(buffer.length, bytes - position), position);
      if (bytesRead === 0) {
        throw transferError("Downloaded data changed while it was being saved.", "size-mismatch");
      }
      await writeAll(destinationFile, buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    await destinationFile.sync();
    await destinationFile.close();
    destinationFile = undefined;
    return { ...responseMetadata(response), path: destinationPath, bytes };
  } catch (error) {
    // Cleanup goes through the verified handle, never through the path, so a
    // swapped parent cannot turn cleanup into an out-of-workspace deletion.
    if (destinationFile) {
      await destinationFile.truncate(0).catch(() => undefined);
      await destinationFile.close().catch(() => undefined);
    }
    throw error;
  } finally {
    await stagingFile?.close().catch(() => undefined);
    if (stagingPath) {
      await rm(stagingPath, { force: true }).catch(() => undefined);
    }
  }
}
