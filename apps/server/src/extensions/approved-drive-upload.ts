import { createHash } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import { realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { GOOGLE_DRIVE_UPLOAD_MAX_BYTES } from "@openwork/types/google-drive-upload";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { openWorkspaceFileForReading, proveHandleInPlace } from "../workspace-file-identity.js";
import { resolveAuthorizedFile } from "./cloud-uploads.js";
import { OPENWORK_CLOUD_UPLOADS_EXTENSION_ID } from "./cloud-upload-constants.js";

export type DriveUploadArgs = { path: string; folderId?: string; connectionId?: string };

export async function prepareDriveUploadFile(config: ServerConfig, args: DriveUploadArgs, context: Record<string, unknown>) {
  if (config.readOnly) throw new ApiError(403, "read_only", "This server is read-only; nothing was uploaded.");
  const path = isAbsolute(args.path)
    ? await realpath(args.path)
    : await resolveAuthorizedFile(config, context, args.path, GOOGLE_DRIVE_UPLOAD_MAX_BYTES);
  if (!(await stat(path)).isFile()) throw new ApiError(400, "invalid_file", "The upload file is not a regular file.");
  const opened = await openWorkspaceFileForReading(dirname(path), path, "The upload file");
  try {
    if (opened.info.size < 1 || opened.info.size > GOOGLE_DRIVE_UPLOAD_MAX_BYTES) {
      throw new ApiError(413, "file_too_large", `Uploads support non-empty files up to ${GOOGLE_DRIVE_UPLOAD_MAX_BYTES} bytes.`);
    }
    const baseline = await opened.handle.stat({ bigint: true });
    return new PreparedDriveUploadFile({ ...args, path }, opened.handle, opened.info, baseline);
  } catch (error) {
    await opened.handle.close();
    throw error;
  }
}

export class PreparedDriveUploadFile {
  readonly args: Readonly<DriveUploadArgs>;
  private used = false;
  constructor(args: DriveUploadArgs, readonly file: FileHandle, readonly info: Stats, private readonly baseline: BigIntStats) {
    this.args = Object.freeze({ ...args });
  }
  async consume(args: Record<string, unknown>) {
    if (this.used || args.path !== this.args.path || args.folderId !== this.args.folderId || args.connectionId !== this.args.connectionId) {
      throw new ApiError(403, "upload_approval_mismatch", "This approval is only for the selected file and Drive destination.");
    }
    this.used = true;
    await this.verify();
    return this;
  }
  async verify() {
    const current = await this.file.stat();
    const precise = await this.file.stat({ bigint: true });
    if (precise.size !== BigInt(this.info.size) || precise.mtimeNs !== this.baseline.mtimeNs || precise.ctimeNs !== this.baseline.ctimeNs
      || !await proveHandleInPlace(current, this.args.path, dirname(this.args.path))) {
      throw new ApiError(409, "file_changed", "The file changed while awaiting upload approval. Nothing was uploaded; ask again for the current file.");
    }
  }
  approvalIdentity() {
    return createHash("sha256").update([this.baseline.dev, this.baseline.ino, this.baseline.size, this.baseline.mtimeNs, this.baseline.ctimeNs].join(":")).digest("hex");
  }
  close() { return this.file.close(); }
}

const approvedRequests = new WeakMap<Request, PreparedDriveUploadFile>();
export function attachApprovedDriveUpload(request: Request, file: PreparedDriveUploadFile) {
  approvedRequests.set(request, file);
}
export function takeApprovedDriveUpload(request: Request) {
  const file = approvedRequests.get(request);
  approvedRequests.delete(request);
  return file;
}

export type PrepareDriveUpload = (args: DriveUploadArgs, context: Record<string, unknown>, signal: AbortSignal) => Promise<{
  path: string;
  approvalIdentity?: string;
  upload(): Promise<unknown>;
  close(): Promise<void>;
}>;

export function createDriveUploadPreflight(config: ServerConfig, hostRequest: (
  path: string, init: RequestInit, file: PreparedDriveUploadFile,
) => Promise<unknown>): PrepareDriveUpload {
  return async (args, context, signal) => {
    signal.throwIfAborted();
    const prepared = await prepareDriveUploadFile(config, args, context);
    return {
      path: prepared.args.path,
      approvalIdentity: prepared.approvalIdentity(),
      close: () => prepared.close(),
      upload: () => {
        signal.throwIfAborted();
        return hostRequest("/experimental/extensions/call", {
          method: "POST", signal,
          body: JSON.stringify({ extensionId: OPENWORK_CLOUD_UPLOADS_EXTENSION_ID, action: "drive_upload_file", args: prepared.args, context }),
        }, prepared);
      },
    };
  };
}
