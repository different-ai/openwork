import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNativeConnector, denFetch } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, SkipError, type Place, type Seed } from "@openwork/env";
import { startMockGoogle } from "@openwork/labs";
import { engineParity } from "./engine-parity.ts";
import { parityRecord } from "./engine-gateway-parity.ts";

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string response field");
  return value;
}

/** Real app, server, v2 engine and Den gateway; only Google and inference are synthetic. */
export async function engineDriveUpload(seed: Seed, context: { place: Place }) {
  if (process.env.OPENWORK_EVAL_DEN_API_URL) throw new SkipError("owned local Den for loopback Google witnesses");
  if (!await localMysqlIsRunning() || !await localRedisIsRunning()) throw new SkipError("local MySQL and Redis");
  await using setup = new AsyncDisposableStack();
  const base = setup.use(await engineParity(seed, context));
  const mailboxes = { selected: "drive-selected@test.example", other: "drive-default@test.example" };
  const google = setup.use(await startMockGoogle({ accounts: Object.values(mailboxes), port: 0 }));
  const preload = new URL("../packages/labs/src/gmail-draft-egress.mjs", import.meta.url);
  const den = await seed.den({ web: false, org: { name: `Engine Drive upload ${Date.now()}`, members: { first: {} } }, env: {
    NODE_OPTIONS: `--import=${preload.href}`, RESEND_API_KEY: "", SMTP_HOST: "",
    DEN_GOOGLE_API_BASE_URL: google.apiUrl, DEN_GOOGLE_OAUTH_AUTHORIZE_URL: google.authorizeUrl,
    DEN_GOOGLE_OAUTH_TOKEN_URL: google.tokenUrl, DEN_GOOGLE_OAUTH_USERINFO_URL: google.userinfoUrl,
  } });
  const member = den.members.first;
  if (!member) throw new Error("Missing seeded member");
  async function connect(name: string, email: string) {
    const connector = await createNativeConnector(den.admin, { providerKey: "google-workspace", name, clientId: "fixture-client", clientSecret: "synthetic-secret", features: ["driveFile"] });
    const start = await denFetch(member!, `/v1/mcp-connections/${connector.id}/connect/start`, { headers: { authorization: `Bearer ${member!.token}` } });
    if (!start.response.ok) throw new Error(`Google OAuth start HTTP ${start.response.status}`);
    const url = new URL(text(parityRecord(start.body).authorizeUrl));
    if (url.origin !== google.apiUrl) throw new Error("Refusing non-witness Google OAuth");
    url.searchParams.set("prompt", "consent select_account");
    const chooser = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (chooser.status !== 200) throw new Error("Google witness did not offer account choice");
    await chooser.text(); await google.chooseAccount(email, { timeoutMs: 10_000 });
    return connector.id;
  }
  await connect("Drive Default", mailboxes.other);
  const selectedId = await connect("Drive Selected", mailboxes.selected);
  const issued = await denFetch(member, "/v1/mcp/token", { method: "POST", headers: { authorization: `Bearer ${member.token}` }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
  if (!issued.response.ok) throw new Error(`MCP token HTTP ${issued.response.status}`);
  const token = text(parityRecord(issued.body).token);
  const workspace = /\/workspace\/([^/]+)\/session/.exec(await base.route())?.[1];
  if (!workspace) throw new Error("Missing Drive upload workspace");
  const connected = await base.request(`/workspace/${workspace}/mcp/openwork-cloud/reconcile`, "POST", {
    config: { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } }, trigger: "drive-upload-fixture",
  });
  if (connected.status !== 200) throw new Error(`Connect reconciliation failed: ${connected.status}`);
  const resources = setup.move();
  return {
    ...base, google, mailboxes, selectedId,
    /** A local Office file the member asks to put in Drive. */
    async writeWorkspaceFile(name: string, bytes: Uint8Array) {
      await writeFile(join(base.workspacePath, name), bytes);
    },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}
