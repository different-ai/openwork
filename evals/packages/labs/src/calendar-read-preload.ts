// Retirement and Cloud upload witness for the existing desktop Calendar boundary spec.
// No real provider request may escape this process.
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const externalRequests: string[] = [];
const cloudUploads: Array<{
  path: string;
  authorization: string | null;
  files: Array<{ name: string; type: string; bytes: number[] }>;
  fields: Record<string, string>;
}> = [];
let resumable: { metadata: Record<string, unknown>; authorization: string | null; bytes: number; chunks: number[]; contentRanges: string[]; credentialForwarded: boolean; sha256?: string } | undefined;
const contentHash = createHash("sha256");
const sessionUrl = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fixture-session-secret";
const witness = createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ externalRequests, cloudUploads, ...(resumable ? { resumable } : {}) }));
});
witness.listen(0, "127.0.0.1", () => {
  const address = witness.address();
  if (address && typeof address !== "string") console.log(`Calendar witness: http://127.0.0.1:${address.port}`);
});
witness.unref();

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return originalFetch(input, init);
  if (url.origin === "https://cloud.example.test" && url.pathname === "/v1/direct-uploads/google-workspace/drive-upload-sessions") {
    if (init?.method !== "POST" || typeof init.body !== "string") throw new Error("Session preparation requires JSON metadata");
    const metadata: Record<string, unknown> = JSON.parse(init.body);
    resumable = { metadata, authorization: new Headers(init.headers).get("authorization"), bytes: 0, chunks: [], contentRanges: [], credentialForwarded: false };
    return Response.json({ ok: true, uploadUrl: sessionUrl, size: metadata.size });
  }
  if (url.href === sessionUrl && resumable) {
    if (init?.method !== "PUT" || !(init.body instanceof Uint8Array) || init.redirect !== "manual") throw new Error("Session transport requires bounded bytes and manual redirects");
    const headers = new Headers(init.headers);
    resumable.credentialForwarded ||= headers.has("authorization");
    resumable.contentRanges.push(headers.get("content-range") ?? "");
    resumable.chunks.push(init.body.byteLength); resumable.bytes += init.body.byteLength; contentHash.update(init.body);
    if (resumable.bytes < Number(resumable.metadata.size)) return new Response(null, { status: 308, headers: { range: `bytes=0-${resumable.bytes - 1}` } });
    resumable.sha256 = contentHash.digest("hex");
    return Response.json({ id: "resumable-file", name: resumable.metadata.name, size: String(resumable.bytes) });
  }
  if (url.origin === "https://cloud.example.test" && [
    "/v1/direct-uploads/google-workspace/drive-files",
    "/v1/direct-uploads/google-workspace/gmail-drafts",
  ].includes(url.pathname)) {
    const authorization = new Headers(init?.headers).get("authorization");
    if (init?.method !== "POST" || !(init.body instanceof FormData)) {
      externalRequests.push(url.href);
      throw new Error("Cloud upload witness requires multipart POST");
    }
    const files = [];
    const fields: Record<string, string> = {};
    for (const [key, value] of init.body) {
      if (typeof value === "string") fields[key] = value;
      else files.push({ name: value.name, type: value.type, bytes: [...new Uint8Array(await value.arrayBuffer())] });
    }
    cloudUploads.push({ path: url.pathname, authorization, files, fields });
    if (authorization !== "Bearer cloud-member-fixture") return Response.json({ message: "Member authorization required" }, { status: 401 });
    return Response.json(url.pathname.endsWith("/drive-files")
      ? { ok: true, file: { id: "cloud-file" } }
      : { ok: true, draftId: "cloud-draft", threadId: "cloud-thread" });
  }
  // Record before rejecting so a caught refresh/revoke/provider failure cannot pass silently.
  externalRequests.push(url.href);
  throw new Error("Unexpected external request in Google retirement witness");
}, originalFetch);
