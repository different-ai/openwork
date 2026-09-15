import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { denFetch, signIn } from "../evals/packages/behaviors/src/den.ts";
import type { DenSession } from "../evals/packages/behaviors/src/den.ts";
import { signInDesktopAs } from "../evals/packages/behaviors/src/desktop-boot.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import type { Place } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";
import { output, secret } from "../packages/world/src/outputs.ts";
import { bootAcmeDemo } from "./acme-demo.ts";
import type { AcmeDemoWorld } from "./acme-demo.ts";

export interface RegistrationReceipt {
  key: string;
  phase: string;
  url: string | null;
  status: number;
  ok: boolean;
  connectionId: string | null;
  /** Sanitized response supplied by the portable script; never a success payload. */
  errorBody: unknown;
  lookupMethod?: string;
  authType?: string;
  credentialMode?: string;
  orgWide?: boolean;
}

export interface AcmeDemoEng105World extends AcmeDemoWorld {
  orgId: string;
  jordanSession: DenSession;
  registrations: RegistrationReceipt[];
  reapplyRegistrations: RegistrationReceipt[];
  setupExitCodes: number[];
  mcpUrls: { home: string; clocks: string; calendar: string };
}

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RELEASE_TAG = "v0.18.46";
const RELEASE_SHA = "a0d6bd1de8debf4f09d22b8538e124b2ff45b339";

/** Source fallback, not packaged-binary validation. Worktree .git files are supported. */
export async function assertReleaseSource(): Promise<void> {
  const git = async (args: string[]) => (await execFileAsync("git", args, { cwd: REPO_ROOT })).stdout.trim();
  if (await git(["rev-parse", `${RELEASE_TAG}^{}`]) !== RELEASE_SHA) throw new Error("ENG105 release tag SHA mismatch");
  const allowed = (path: string) => path === "worlds/acme-demo-eng105.ts"
    || path.startsWith("docs/") || path.startsWith("scripts/demo/") || path.startsWith("evals/specs/");
  // Compare the actual worktree (including staged/unstaged changes) with the tag.
  const changed = await git(["diff", "--name-only", RELEASE_SHA, "--"]);
  const untracked = await git(["ls-files", "--others", "--exclude-standard"]);
  const forbidden = `${changed}\n${untracked}`.split("\n").filter((path) => path && !allowed(path));
  if (forbidden.length) throw new Error(`ENG105 requires ${RELEASE_TAG} product source; non-overlay changes: ${forbidden.join(", ")}`);
}

/** Register before boot resources so this runs only after our Den and desktops stop. */
export async function preserveReleaseGeneratedTypes(stack: AsyncDisposableStack): Promise<void> {
  const relativePath = "ee/apps/den-web/next-env.d.ts";
  const path = join(REPO_ROOT, relativePath);
  const original = await readFile(path, "utf8");
  const released = (await execFileAsync("git", ["show", `${RELEASE_SHA}:${relativePath}`], { cwd: REPO_ROOT })).stdout;
  if (original !== released) throw new Error("ENG105 next-env source does not match the release; preserved");
  const expected = original.replace('import "./.next/dev/types/routes.d.ts";\n',
    'import "./.next/dev/types/routes.d.ts";\nimport "./.next/dev/types/root-params.d.ts";\n');
  stack.defer(async () => {
    const current = await readFile(path, "utf8");
    if (current !== original) {
      if (current !== expected) throw new Error("ENG105 preserved unexpected next-env changes; inspect before next boot");
      await writeFile(path, original);
    }
    await assertReleaseSource();
    console.log("ENG105 teardown: release provenance ready for the next cold boot");
  });
}

function isReceipt(value: unknown): value is RegistrationReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof Reflect.get(value, "key") === "string"
    && typeof Reflect.get(value, "phase") === "string"
    && (Reflect.get(value, "url") === null || typeof Reflect.get(value, "url") === "string")
    && typeof Reflect.get(value, "status") === "number"
    && typeof Reflect.get(value, "ok") === "boolean"
    && (Reflect.get(value, "connectionId") === null || typeof Reflect.get(value, "connectionId") === "string")
    && Object.hasOwn(value, "errorBody");
}

function field(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const result: unknown = Reflect.get(value, key);
  return typeof result === "string" ? result : null;
}

function required(value: unknown, key: string): string {
  const result = field(value, key);
  if (!result) throw new Error(`ENG105: missing ${key} in public API response`);
  return result;
}

function endpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("ENG105 MCP URLs must be HTTPS without credentials, query, or fragment");
  }
  return url.href;
}

/** Only owns a cold local Acme topology; never attaches to an existing Den/app. */
export async function bootAcmeDemoEng105(
  stack: AsyncDisposableStack,
  place: Place,
): Promise<AcmeDemoEng105World> {
  await assertReleaseSource();
  if (place.kind !== "local") throw new Error("ENG105 demo-org seed requires the local lane");
  const overrides = ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DESKTOP_CDP_URL", "OPENWORK_EVAL_CDP_URL",
    "OPENWORK_EVAL_ELECTRON_BINARY", "OPENWORK_EVAL_DEN_RUNTIME_PREPARED", "ELECTRON_RENDERER_URL"];
  if (overrides.some((key) => process.env[key])) throw new Error("ENG105 refuses shared/attached/prebuilt runtime overrides");
  const homeUrl = endpoint(process.env.ENG105_HOME_MCP_URL ?? "https://acme-home-demo.vercel.app/mcp");
  const clocksUrl = endpoint(process.env.ENG105_CLOCKS_MCP_URL ?? "https://world-clocks-demo.vercel.app/mcp");
  const calendarUrl = endpoint(process.env.ENG105_CALENDAR_MCP_URL ?? "https://personal-calendar-demo-mcp-app.vercel.app/mcp");
  // Demo invitation mail stays in Den's dev outbox; never inherit a mail provider.
  process.env.RESEND_API_KEY = "";
  process.env.SMTP_HOST = "";
  await preserveReleaseGeneratedTypes(stack);
  const world = await bootAcmeDemo(stack, place);
  const { den, jordan } = world;
  const auth = { authorization: `Bearer ${den.admin.token}` };
  const org = await denFetch(den.ref, "/v1/org", { headers: auth });
  if (!org.response.ok) throw new Error(`ENG105 organization: HTTP ${org.response.status}`);
  if (typeof org.body !== "object" || org.body === null) throw new Error("ENG105 organization response missing");
  const orgId = required(Reflect.get(org.body, "organization"), "id");
  const headers = { ...auth, "x-openwork-org-id": orgId };

  const email = `jordan@${den.admin.email.split("@")[1]}`;
  const password = "Eng105-Jordan-Demo-Only!";
  const invite = await denFetch(den.ref, "/v1/invitations", {
    method: "POST", headers, body: JSON.stringify({ email, role: "member" }),
  });
  if (!invite.response.ok) throw new Error(`ENG105 invitation: HTTP ${invite.response.status}`);
  const inviteToken = required(invite.body, "inviteToken");
  const signup = await denFetch(den.ref, `/api/auth/sign-up/email?invite=${encodeURIComponent(inviteToken)}`, {
    method: "POST", body: JSON.stringify({ name: "Jordan Demo", email, password, invite: inviteToken }),
  });
  if (!signup.response.ok) throw new Error(`ENG105 invited signup: HTTP ${signup.response.status}`);
  const jordanSession = await signIn(den.ref, { email, password });
  const accept = await denFetch(den.ref, "/v1/orgs/invitations/accept", {
    method: "POST", headers: { authorization: `Bearer ${jordanSession.token}` },
    body: JSON.stringify({ id: inviteToken }),
  });
  if (!accept.response.ok) throw new Error(`ENG105 invitation acceptance: HTTP ${accept.response.status}`);
  den.members.jordan = jordanSession;
  await signInDesktopAs(jordan, den.ref, jordanSession);

  const minted = await denFetch(den.ref, "/v1/api-keys", {
    method: "POST", headers, body: JSON.stringify({ name: "ENG105 world provisioning" }),
  });
  if (!minted.response.ok) throw new Error(`ENG105 admin key: HTTP ${minted.response.status}`);
  const apiKey = required(minted.body, "key");
  const stateDir = await mkdtemp(join(tmpdir(), "eng105-den-"));
  stack.defer(() => rm(stateDir, { recursive: true, force: true }));
  const setupExitCodes: number[] = [];
  const apply = async (): Promise<RegistrationReceipt[]> => {
    let stdout: string;
    let code = 0;
    try {
      ({ stdout } = await execFileAsync("bash", ["scripts/demo/setup-eng105-den.sh", "--connections-only"], {
        cwd: REPO_ROOT, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, DEN_API_URL: den.ref.apiUrl, DEN_API_KEY: apiKey,
          DEMO_STATE_DIR: stateDir, DEMO_EXPECTED_ORG_ID: orgId, DEMO_KEY_PREFIX: "",
          DEMO_TEAMMATE_EMAIL: "", DEMO_HOME_URL: homeUrl, DEMO_CALENDAR_URL: calendarUrl,
          DEMO_CLOCKS_URL: clocksUrl,
          DEMO_CALENDAR_ISSUER: new URL(calendarUrl).origin },
      }));
    } catch (error) {
      // Script reports sanitized JSON even on a partial apply; never print exec errors/env.
      if (typeof error !== "object" || error === null || typeof Reflect.get(error, "stdout") !== "string") {
        throw new Error("ENG105 setup script failed without a JSON receipt");
      }
      stdout = String(Reflect.get(error, "stdout"));
      const exitCode: unknown = Reflect.get(error, "code");
      code = typeof exitCode === "number" ? exitCode : 1;
    }
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed) || !parsed.every(isReceipt)) throw new Error("ENG105 setup script returned invalid receipts");
    setupExitCodes.push(code);
    return parsed;
  };
  const registrations = await apply();
  // Only reapply a completed setup: an uncertain failure is not automatically retried.
  const reapplyRegistrations = setupExitCodes[0] === 0 ? await apply() : [];
  return { ...world, orgId, jordanSession, registrations, reapplyRegistrations, setupExitCodes,
    mcpUrls: { home: homeUrl, clocks: clocksUrl, calendar: calendarUrl } };
}

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const world = await bootAcmeDemoEng105(stack, resolvePlace());
  const { den, alex, jordan, jordanSession, orgId, registrations, reapplyRegistrations, setupExitCodes } = world;
  await hold({
    name: "acme-demo-eng105",
    outputs: {
      releaseTag: output(RELEASE_TAG, { group: "Build" }),
      releaseSha: output(RELEASE_SHA, { group: "Build" }),
      lane: output("local-release-source", { group: "Build", note: "Not packaged-binary validation" }),
      denWeb: output(den.ref.webUrl, { group: "URLs" }),
      denApi: output(den.ref.apiUrl, { group: "URLs" }),
      alexCdp: output(alex.handle.cdpUrl, { group: "URLs" }),
      jordanCdp: output(jordan.handle.cdpUrl, { group: "URLs" }),
      homeMcpUrl: output(world.mcpUrls.home, { group: "Hosted MCP URLs" }),
      clocksMcpUrl: output(world.mcpUrls.clocks, { group: "Hosted MCP URLs" }),
      calendarMcpUrl: output(world.mcpUrls.calendar, { group: "Hosted MCP URLs" }),
      alexEmail: output(den.admin.email, { group: "Accounts", note: "Acme org owner, signed in" }),
      alexPassword: secret(den.admin.password, { group: "Accounts" }),
      jordanEmail: output(jordanSession.email, { group: "Accounts", note: "invited member, fresh desktop signed in" }),
      jordanPassword: secret(jordanSession.password, { group: "Accounts" }),
      orgId: output(orgId, { group: "Org" }),
      dashboards: output("enabled", { group: "Org", note: "DEN_DASHBOARDS_ENABLED=true" }),
      registrations: output(JSON.stringify(registrations), { group: "Receipts", note: "Registration is not provider connectivity or UI proof" }),
      reapplyRegistrations: output(JSON.stringify(reapplyRegistrations), { group: "Receipts" }),
      setupExitCodes: output(JSON.stringify(setupExitCodes), { group: "Receipts", note: "Reapply only follows successful initial apply" }),
      supersededApiKeyContract: output('Historical dev smoke: HTTP 400 {"error":"invalid_request","message":"apiKey is required when authType is apikey."}', { group: "Historical diagnostic", note: "Superseded by OAuth; not attempted in normal startup" }),
      calendarConnect: output("Each member clicks Connect in Your Connections; no member credentials seeded", { group: "Next steps" }),
      journey: output("Den Web Dashboard: Add MCP App, then grant Jordan access. Not chat Save as app.", { group: "Next steps" }),
    },
  });
}

if (import.meta.main) await main();
