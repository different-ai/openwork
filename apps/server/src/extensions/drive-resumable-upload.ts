import { open } from "node:fs/promises";
import { GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES, GOOGLE_DRIVE_UPLOAD_MAX_BYTES, isGoogleDriveUploadSessionUrl } from "@openwork/types/google-drive-upload";
import { ApiError } from "../errors.js";

type UploadFetch = (input: string, init?: RequestInit) => Promise<Response>;

function fail(message: string): never {
  throw new ApiError(502, "drive_upload_unconfirmed", message);
}

function committedOffset(response: Response, total: number, sentThrough: number) {
  const range = response.headers.get("range");
  if (!range) return 0;
  const match = /^bytes=0-([0-9]+)$/.exec(range);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > Math.min(total, sentThrough)) fail("Google returned invalid upload progress. No new session was created.");
  return offset;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function completedReceipt(response: Response, size: number) {
  const value: unknown = await response.json().catch(() => null);
  if (!isRecord(value) || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(value.id)) fail("Google returned no completed file id. Check Drive before retrying.");
  if (value.size !== undefined && value.size !== String(size)) fail("Google returned an unexpected completed file size. Check Drive before retrying.");
  // Never echo unexpected provider fields (especially bearer session URLs) to the model.
  const file: Record<string, string> = { id: value.id };
  for (const field of ["name", "mimeType", "modifiedTime", "webViewLink", "size"]) {
    const entry = value[field];
    if (typeof entry === "string" && entry.length <= 4096) file[field] = entry;
  }
  return { ok: true, file };
}

/** Bounded chunks; uncertain writes probe the SAME session, never create another file. */
export async function uploadDriveResumableFile(input: {
  path: string;
  uploadUrl: string;
  size: number;
  mimeType: string;
  fetch: UploadFetch;
  signal?: AbortSignal;
}) {
  if (!isGoogleDriveUploadSessionUrl(input.uploadUrl)) throw new ApiError(502, "invalid_upload_session", "The upload destination is not a Google Drive session.");
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > GOOGLE_DRIVE_UPLOAD_MAX_BYTES) throw new ApiError(413, "file_too_large", "Google Drive supports files up to 5 TiB.");
  const file = await open(input.path, "r");
  try {
    const initial = await file.stat();
    if (!initial.isFile() || initial.size !== input.size) throw new ApiError(409, "file_changed", "The file changed before upload. No bytes were sent.");
    let offset = 0;
    let recoveries = 0;
    let sentThrough = 0;
    const put = (body: Uint8Array<ArrayBuffer>, contentRange: string) => input.fetch(input.uploadUrl, {
      method: "PUT", redirect: "manual",
      headers: { "content-type": input.mimeType, "content-range": contentRange },
      body,
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
    while (true) {
      input.signal?.throwIfAborted();
      const current = await file.stat();
      if (current.size !== initial.size || current.mtimeMs !== initial.mtimeMs) throw new ApiError(409, "file_changed", "The file changed during upload. Completion is not confirmed; do not retry automatically.");
      const length = Math.min(GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES, input.size - offset);
      const bytes = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const part = await file.read(bytes, read, length - read, offset + read);
        if (!part.bytesRead) throw new ApiError(409, "file_changed", "The file was truncated during upload.");
        read += part.bytesRead;
      }
      sentThrough = Math.max(sentThrough, offset + length);
      let response: Response;
      try {
        response = await put(bytes, length ? `bytes ${offset}-${offset + length - 1}/${input.size}` : `bytes */${input.size}`);
      } catch {
        input.signal?.throwIfAborted();
        if (++recoveries > 2) fail("Google did not confirm the upload. Check Drive before retrying; no new session was created.");
        try { response = await put(new Uint8Array(0), `bytes */${input.size}`); }
        catch { fail("Google did not confirm the upload status. Check Drive before retrying; no new session was created."); }
      }
      if (response.status === 200 || response.status === 201) {
        return await completedReceipt(response, input.size);
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        if (++recoveries > 2) fail("Google could not confirm the upload. Check Drive before retrying.");
        try { response = await put(new Uint8Array(0), `bytes */${input.size}`); }
        catch { fail("Google did not confirm the upload status. Check Drive before retrying."); }
        if (response.status === 200 || response.status === 201) {
          return await completedReceipt(response, input.size);
        }
      }
      if (response.status !== 308) {
        const status = response.status;
        await response.body?.cancel();
        fail(status === 404 || status === 410 ? "The Google upload session expired. Check Drive before starting another upload." : `Google returned HTTP ${status}; upload completion is not confirmed. Check Drive before retrying.`);
      }
      const next = committedOffset(response, input.size, sentThrough);
      await response.body?.cancel();
      if (next < offset) fail("Google's upload progress moved backwards. No new session was created.");
      if (next === offset && ++recoveries > 2) fail("Google's upload made no progress. Completion is not confirmed.");
      offset = next;
    }
  } finally {
    await file.close();
  }
}
