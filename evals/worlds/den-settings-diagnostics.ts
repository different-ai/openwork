import { randomUUID } from "node:crypto";
import type { Seed } from "@openwork/env";
import type { DenSession } from "@openwork/behaviors";
import { denFetch, freshSession } from "@openwork/behaviors";
import type { DesktopStartupReport } from "@openwork/types/den/diagnostics";
import { healthFixture } from "./den-service-readiness.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
function memberId(body: unknown): string {
  const id = field(field(body, "currentMember"), "id");
  if (typeof id !== "string") throw new Error("Missing genuine organization membership");
  return id;
}

export function localSettingsDiagnostics(seed: Seed) { return settingsDiagnostics(seed, "self_hosted"); }
export function cloudSettingsDiagnostics(seed: Seed) { return settingsDiagnostics(seed, "cloud"); }

/** What real desktop apps send after launch: three connected launches and one that failed on the certificate. */
export function desktopLaunches(now = Date.now()): DesktopStartupReport[] {
  const observedAt = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const connected = (minutesAgo: number, window: number, engine: number, signedIn: number, orgTools: number): DesktopStartupReport => ({
    attemptId: randomUUID(), appVersion: "0.19.2", platform: "darwin", observedAt: observedAt(minutesAgo), success: true,
    steps: { window, engine, signed_in: signedIn, org_tools: orgTools }, failedStep: null, reason: null,
  });
  return [
    connected(50, 600, 1100, 1600, 1800),
    connected(40, 650, 1200, 1750, 2000),
    connected(30, 700, 1400, 2900, 4200),
    {
      attemptId: randomUUID(), appVersion: "0.18.7", platform: "win32", observedAt: observedAt(18), success: false,
      steps: { window: 800, engine: 1500, signed_in: null, org_tools: null }, failedStep: "signed_in", reason: "certificate",
    },
  ];
}

async function report(seed: Seed, session: DenSession, launch: DesktopStartupReport) {
  const sent = await seed.api(session, "/v1/diagnostics/desktop-startup", { method: "POST", body: JSON.stringify(launch) });
  if (sent.response.status !== 204) throw new Error(`Desktop startup report was not accepted: ${sent.response.status}`);
}

/** Real sessions, membership, ownership transfer, reports and UI; only external service health is mocked. */
async function settingsDiagnostics(seed: Seed, deployment: "cloud" | "self_hosted") {
  const stack = new AsyncDisposableStack();
  try {
    const fixture = stack.use(await healthFixture());
    const den = await seed.den({
      org: {
        name: "Diagnostics settings",
        admin: { name: "Installation Operator" },
        members: { owner: { name: "Organization Owner" }, member: { name: "Workspace Member" } },
      },
      env: {
        DEN_DEPLOYMENT: deployment,
        GATEWAY_ENABLED: "false", GATEWAY_PROXY_BASE_URL: "", GATEWAY_PUBLIC_BASE_URL: "",
        DEN_HEADLESS_RUNNER_URL: fixture.url,
        DEN_HEADLESS_RUNNER_TOKEN: "readiness-fixture-service-token-not-production",
        DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "", DEN_WORKBOT_URL: "",
        SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", SMTP_PORT: "", SMTP_SECURE: "", RESEND_API_KEY: "", EMAIL_FROM: "",
      },
    });
    const operatorContext = await seed.api(den.admin, "/v1/org");
    const ownerContext = await seed.api(den.members.owner, "/v1/org");
    const operatorId = memberId(operatorContext.body), ownerId = memberId(ownerContext.body);
    const promote = await seed.api(den.admin, `/v1/members/${ownerId}/role`, { method: "POST", body: JSON.stringify({ role: "admin" }) });
    if (!promote.response.ok) throw new Error(`Real admin promotion failed: ${promote.response.status}`);
    const transfer = await seed.api(den.admin, `/v1/members/${ownerId}/transfer-ownership`, { method: "POST" });
    if (!transfer.response.ok) throw new Error(`Real ownership transfer failed: ${transfer.response.status}`);
    // Role changes revoke sessions. Sign in again rather than bypassing that boundary.
    den.members.owner = await freshSession(den.members.owner);
    const demote = await seed.api(den.members.owner, `/v1/members/${operatorId}/role`, { method: "POST", body: JSON.stringify({ role: "member" }) });
    if (!demote.response.ok) throw new Error(`Real operator role change failed: ${demote.response.status}`);
    den.admin = await freshSession(den.admin);
    // Return ownership before the framework deletes this disposable organization.
    stack.defer(async () => {
      const owner = await freshSession(den.members.owner);
      const headers = { authorization: `Bearer ${owner.token}` };
      const promoteBack = await denFetch(owner, `/v1/members/${operatorId}/role`, { method: "POST", headers, body: JSON.stringify({ role: "admin" }) });
      if (!promoteBack.response.ok) throw new Error(`Cleanup promotion failed: ${promoteBack.response.status}`);
      const transferBack = await denFetch(owner, `/v1/members/${operatorId}/transfer-ownership`, { method: "POST", headers });
      if (!transferBack.response.ok) throw new Error(`Cleanup ownership transfer failed: ${transferBack.response.status}`);
    });
    // Two people launch the desktop app through the same endpoint the app uses.
    const [first, second, third, failed] = desktopLaunches();
    await report(seed, den.members.owner, first);
    await report(seed, den.members.member, second);
    await report(seed, den.members.owner, third);
    await report(seed, den.members.member, failed);
    const viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
    const operator = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard", headless: true, viewport });
    const owner = await seed.web({ den, signedInAs: den.members.owner, startPath: "/dashboard", headless: true, viewport });
    const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/dashboard", headless: true, viewport });
    return { den, operator, owner, member, fixtureCalls: fixture.calls, unexpectedFixtureCalls: fixture.unexpected, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
