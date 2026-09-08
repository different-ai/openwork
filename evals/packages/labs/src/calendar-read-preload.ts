// Retirement and Cloud upload witness for the existing desktop Calendar boundary spec.
// No real provider request may escape this process.
import { createServer } from "node:http";

const externalRequests: string[] = [];
const cloudUploads: Array<{
  path: string;
  authorization: string | null;
  files: Array<{ name: string; type: string; bytes: number[] }>;
  fields: Record<string, string>;
}> = [];
const witness = createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ externalRequests, cloudUploads }));
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
