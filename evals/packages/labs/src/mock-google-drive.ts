import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface MockDriveFileSeed {
  id: string;
  name: string;
  mimeType: string;
  /** Stored bytes; Docs, Sheets and Slides keep their exports instead. */
  content?: Uint8Array;
  parents?: string[];
  /** Export bytes by MIME type, for Docs, Sheets and Slides. */
  exports?: Record<string, Uint8Array>;
  /** For a Drive shortcut: the ID of the file it points to. */
  shortcutTo?: string;
}

export interface MockDriveFileSnapshot {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  revision: string | null;
  version: string;
  contentBase64: string;
  exports: Record<string, string>;
}

interface MockDriveFile {
  id: string;
  name: string;
  mimeType: string;
  content: Buffer;
  exports: Record<string, Buffer>;
  parents: string[];
  shortcutTo?: string;
  trashed: boolean;
  revision: number;
  version: number;
  modifiedTime: string;
}

const isNative = (mimeType: string) => mimeType.startsWith("application/vnd.google-apps.");
const md5 = (bytes: Buffer) => createHash("md5").update(bytes).digest("hex");

function googleError(response: ServerResponse, status: number, message: string, reason: string) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code: status, message, errors: [{ message, domain: "global", reason }] } }));
}

/** Stateful Drive files per account: metadata, ranged downloads, exports and content replacement. */
export function mockDrive(seed: Record<string, MockDriveFileSeed[]> = {}) {
  const accounts = new Map<string, Map<string, MockDriveFile>>();
  let created = 0;
  const filesFor = (email: string) => {
    const key = email.toLowerCase();
    let files = accounts.get(key);
    if (!files) accounts.set(key, files = new Map());
    return files;
  };
  for (const [email, files] of Object.entries(seed)) {
    for (const file of files) {
      filesFor(email).set(file.id, {
        id: file.id, name: file.name, mimeType: file.mimeType, content: Buffer.from(file.content ?? new Uint8Array()),
        exports: Object.fromEntries(Object.entries(file.exports ?? {}).map(([mime, bytes]) => [mime, Buffer.from(bytes)])),
        parents: file.parents ?? ["root-folder"], ...(file.shortcutTo ? { shortcutTo: file.shortcutTo } : {}),
        trashed: false, revision: 1, version: 1, modifiedTime: new Date().toISOString(),
      });
    }
  }

  function resource(file: MockDriveFile) {
    return {
      id: file.id, name: file.name, mimeType: file.mimeType, parents: file.parents, trashed: file.trashed,
      version: String(file.version), modifiedTime: file.modifiedTime, webViewLink: `https://drive.google.test/file/d/${file.id}/view`,
      ...(file.shortcutTo ? { shortcutDetails: { targetId: file.shortcutTo } } : {}),
      ...(isNative(file.mimeType) ? {} : { size: String(file.content.byteLength), md5Checksum: md5(file.content), headRevisionId: `rev-${file.revision}` }),
    };
  }

  function bump(file: MockDriveFile, content: Buffer) {
    file.content = content;
    file.revision += 1;
    file.version += 1;
    file.modifiedTime = new Date().toISOString();
  }

  return {
    owns: (email: string, id: string) => filesFor(email).has(id),
    snapshot(email: string): MockDriveFileSnapshot[] {
      return [...filesFor(email).values()].map((file) => ({
        id: file.id, name: file.name, mimeType: file.mimeType, parents: file.parents,
        revision: isNative(file.mimeType) ? null : `rev-${file.revision}`, version: String(file.version),
        contentBase64: file.content.toString("base64"),
        exports: Object.fromEntries(Object.entries(file.exports).map(([mime, bytes]) => [mime, bytes.toString("base64")])),
      }));
    },
    /** Someone else edits the file in Drive. */
    edit(email: string, id: string, content: Buffer) {
      const file = filesFor(email).get(id);
      if (!file) return false;
      if (isNative(file.mimeType)) {
        file.exports = Object.fromEntries(Object.keys(file.exports).map((mime) => [mime, content]));
        file.version += 1;
        file.modifiedTime = new Date().toISOString();
      } else {
        bump(file, content);
      }
      return true;
    },
    /** A completed upload: native target types convert the upload into an export source. */
    create(email: string, input: { name: string; mimeType: string; uploadMimeType: string; content: Buffer; parents: string[] }) {
      const file: MockDriveFile = {
        id: `drive-file-${++created}`, name: input.name, mimeType: input.mimeType,
        content: isNative(input.mimeType) ? Buffer.alloc(0) : input.content,
        exports: isNative(input.mimeType) ? { [input.uploadMimeType]: input.content } : {},
        parents: input.parents.length ? input.parents : ["root-folder"], trashed: false, revision: 1, version: 1, modifiedTime: new Date().toISOString(),
      };
      filesFor(email).set(file.id, file);
      return resource(file);
    },
    replace(email: string, id: string, content: Buffer) {
      const file = filesFor(email).get(id);
      if (!file) return null;
      bump(file, content);
      return resource(file);
    },
    /** GET metadata, alt=media (with Range) and export; false when the path is not a known file request. */
    handle(request: IncomingMessage, response: ServerResponse, url: URL, email: string | null) {
      const match = /^\/drive\/v3\/files\/([A-Za-z0-9_-]+)(\/export)?$/.exec(url.pathname);
      if (!match || request.method !== "GET") return false;
      if (![...accounts.values()].some((files) => files.has(match[1]))) return false;
      if (!email) {
        googleError(response, 401, "Request had invalid authentication credentials.", "authError");
        return true;
      }
      const file = filesFor(email).get(match[1]);
      if (!file) {
        googleError(response, 404, `File not found: ${match[1]}.`, "notFound");
        return true;
      }
      if (match[2]) {
        if (!isNative(file.mimeType)) {
          googleError(response, 403, "Export only supports Docs Editors files.", "fileNotExportable");
          return true;
        }
        const mimeType = url.searchParams.get("mimeType") ?? "";
        const bytes = file.exports[mimeType] ?? Buffer.from(`${file.name} exported as ${mimeType}`);
        response.writeHead(200, { "content-type": mimeType, "content-length": String(bytes.byteLength) });
        response.end(bytes);
        return true;
      }
      if (url.searchParams.get("alt") !== "media") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(resource(file)));
        return true;
      }
      if (isNative(file.mimeType)) {
        googleError(response, 403, "Only files with binary content can be downloaded. Use Export with Docs Editors files.", "fileNotDownloadable");
        return true;
      }
      const range = /^bytes=(\d+)-(\d+)?$/.exec(String(request.headers.range ?? ""));
      if (request.headers.range && !range) {
        response.writeHead(416);
        response.end();
        return true;
      }
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] === undefined ? file.content.byteLength - 1 : Number(range[2]), file.content.byteLength - 1);
        if (start > end) {
          response.writeHead(416, { "content-range": `bytes */${file.content.byteLength}` });
          response.end();
          return true;
        }
        const bytes = file.content.subarray(start, end + 1);
        response.writeHead(206, { "content-type": file.mimeType, "content-length": String(bytes.byteLength), "content-range": `bytes ${start}-${end}/${file.content.byteLength}` });
        response.end(bytes);
        return true;
      }
      response.writeHead(200, { "content-type": file.mimeType, "content-length": String(file.content.byteLength) });
      response.end(file.content);
      return true;
    },
  };
}
