import { createNativeConnector, denFetch, type DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, SkipError, type Seed } from "@openwork/env";
import { startMockGoogle } from "@openwork/labs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected response object");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string response field");
  return value;
}
function objects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (typeof value !== "object" || value === null) return [];
  const record = object(value);
  return [record, ...Object.values(record).flatMap((entry) => {
    if (typeof entry !== "string") return objects(entry);
    try { return objects(JSON.parse(entry)); } catch { return []; }
  })];
}

/** A real Den gateway and OAuth callbacks; only Google's service is synthetic. No engine needed for external-client file transport. */
export async function driveUploads(seed: Seed) {
  if (process.env.OPENWORK_EVAL_DEN_API_URL) throw new SkipError("owned local Den for loopback Google witnesses");
  if (!await localMysqlIsRunning() || !await localRedisIsRunning()) throw new SkipError("local MySQL and Redis");
  const stack = new AsyncDisposableStack();
  try {
    const mailboxes = { selected: "drive-selected@test.example", other: "drive-default@test.example", second: "drive-second@test.example" };
    const google = stack.use(await startMockGoogle({ accounts: Object.values(mailboxes), port: 0 }));
    const preload = new URL("../packages/labs/src/gmail-draft-egress.mjs", import.meta.url);
    const den = await seed.den({ web: false, org: { name: `Drive uploads ${Date.now()}`, members: { first: {}, second: {} } }, env: {
      NODE_OPTIONS: `--import=${preload.href}`, RESEND_API_KEY: "", SMTP_HOST: "",
      DEN_GOOGLE_API_BASE_URL: google.apiUrl, DEN_GOOGLE_OAUTH_AUTHORIZE_URL: google.authorizeUrl,
      DEN_GOOGLE_OAUTH_TOKEN_URL: google.tokenUrl, DEN_GOOGLE_OAUTH_USERINFO_URL: google.userinfoUrl,
    } });
    const first = den.members.first; const second = den.members.second;
    if (!first || !second) throw new Error("Missing seeded members");
    const native = (name: string, features = ["driveFile"]) => createNativeConnector(den.admin, { providerKey: "google-workspace", name, clientId: "fixture-client", clientSecret: "synthetic-secret", features });
    const other = await native("Drive Default");
    const selected = await native("Drive Selected");
    const unavailable = await native("Drive Unconnected");
    const readOnly = await native("Drive Read Only", ["driveRead"]);
    async function connect(member: DenSession, id: string, email: string) {
      const start = await denFetch(member, `/v1/mcp-connections/${id}/connect/start`, { headers: { authorization: `Bearer ${member.token}` } });
      if (!start.response.ok) throw new Error(`Google OAuth start HTTP ${start.response.status}`);
      const url = new URL(text(object(start.body).authorizeUrl));
      if (url.origin !== google.apiUrl) throw new Error("Refusing non-witness Google OAuth");
      url.searchParams.set("prompt", "consent select_account");
      const chooser = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      if (chooser.status !== 200) throw new Error("Google witness did not offer account choice");
      await chooser.text(); await google.chooseAccount(email, { timeoutMs: 10_000 });
    }
    await connect(first, other.id, mailboxes.other);
    await connect(first, selected.id, mailboxes.selected);
    await connect(first, readOnly.id, mailboxes.selected);
    await connect(second, other.id, mailboxes.second);
    async function mint(member: DenSession) {
      const result = await denFetch(member, "/v1/mcp/token", { method: "POST", headers: { authorization: `Bearer ${member.token}` }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
      if (!result.response.ok) throw new Error(`MCP token HTTP ${result.response.status}`);
      return text(object(result.body).token);
    }
    const tokens = { first: await mint(first), second: await mint(second) };
    let rpcId = 0;
    const mcp = async (name: string, args: Record<string, unknown>, identity: "first" | "second" = "first") => {
      const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, { method: "POST", headers: { authorization: `Bearer ${tokens[identity]}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(60_000) }).catch(() => { throw new Error(`Real Den MCP ${name} failed before acknowledgement`); });
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
      const raw = await response.text().catch(() => { throw new Error(`Real Den MCP ${name} response stream failed`); }); const line = raw.split("\n").find((part) => part.startsWith("data:"));
      const envelope = object(JSON.parse(line ? line.slice(5) : raw));
      if (envelope.error) throw new Error("MCP protocol error"); return object(envelope.result);
    };
    const orgResult = await denFetch(den.admin, "/v1/org", { headers: { authorization: `Bearer ${den.admin.token}` } });
    const orgId = text(object(object(orgResult.body).organization).id);
    return {
      google, mailboxes, selectedId: selected.id, unavailableId: unavailable.id, readOnlyId: readOnly.id,
      mcp, objects,
      async rollout(enabled: boolean) {
        const result = await denFetch(den.admin, `/v1/admin/organizations/${orgId}/capabilities`, { method: "PUT", headers: { authorization: `Bearer ${den.admin.token}` }, body: JSON.stringify({ capabilities: { driveResumableUploads: enabled } }) });
        if (!result.response.ok) throw new Error(`Feature rollout HTTP ${result.response.status}: ${result.text.slice(0, 300)}`);
      },
      async host(path: "drive-files" | "drive-upload-sessions", body: BodyInit, identity: "first" | "second" | "missing" = "first", json = false) {
        const headers = new Headers(json ? { "content-type": "application/json" } : {});
        if (identity !== "missing") headers.set("authorization", `Bearer ${tokens[identity]}`);
        const response = await fetch(`${den.ref.apiUrl}/v1/direct-uploads/google-workspace/${path}`, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) });
        return { status: response.status, body: await response.json() };
      },
      async requests() {
        const response = await fetch(`${google.apiUrl}/requests`, { signal: AbortSignal.timeout(10_000) });
        const entries = object(await response.json()).requests;
        if (!Array.isArray(entries)) throw new Error("Missing provider witness");
        return entries.map(object).filter((entry) => String(entry.path).startsWith("/upload/"));
      },
      async put(uploadUrl: string, bytes: Uint8Array, range: string) {
        if (new URL(uploadUrl).origin !== google.apiUrl) throw new Error("Refusing non-witness file transport");
        try {
          return await fetch(uploadUrl, { method: "PUT", redirect: "manual", headers: { "content-type": "application/octet-stream", "content-range": range }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(30_000) });
        } catch { throw new Error(`Synthetic Google PUT failed for ${bytes.byteLength} bytes before acknowledgement`); }
      },
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
