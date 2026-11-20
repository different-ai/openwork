import { join } from "node:path";
import { addInitScript, attachSurface, browserScript, evaluateOnSurface, navigate } from "@openwork/cdp";
import { denFetch } from "@openwork/behaviors";
import { localHost } from "@openwork/hosts";
import { resolvePlace } from "../packages/env/src/place.ts";
import { server } from "../packages/env/src/den.ts";
import { uxDenProxy } from "./sandbox-ux-signed-in.ts";
import { uxDockerDatabase } from "./sandbox-ux-docker-db.ts";
import { isRecord } from "./packaged-sandbox-fixtures.ts";
import { openPermissions, packagedDemoDesktop } from "./sandbox-demo-desktop.ts";
import { button, film, poll, requireDemo, testId } from "./sandbox-demo-film.ts";

export async function orgDemo(cleanup: AsyncDisposableStack, root: string, signal: AbortSignal, attempt: string, buildSha: string) {
  let mysql = process.env.OPENWORK_EVAL_MYSQL_URL;
  requireDemo(mysql && new URL(mysql).hostname === "127.0.0.1" && new URL(mysql).port === "13306", "Expected test MySQL on 127.0.0.1:13306");
  process.env.DATABASE_REDIS_URL = "redis://127.0.0.1:6379";
  if (attempt === "web-tunnel" || attempt === "desktop-tunnel") {
    const db = await uxDockerDatabase();
    cleanup.defer(db.close);
    mysql = db.mysql;
    process.env.DATABASE_REDIS_URL = db.redis;
    process.env.OPENWORK_EVAL_MYSQL_URL = mysql;
  }
  const place = resolvePlace({ OPENWORK_EVAL_MYSQL_URL: mysql });
  requireDemo(place.kind === "local", "Expected local Den placement");
  const desktopOnly = attempt === "desktop";
  const den = await server({ place, web: !desktopOnly, org: { name: "Sandbox Demo Organization", admin: { name: "Demo Owner" }, members: { member: { name: "Demo Member" } } } }).catch(() => { throw new Error(`Local Den ${desktopOnly ? "API" : "API/web"} provisioning failed`); });
  cleanup.use(den);
  const { admin } = den;
  const member = den.members.member;
  requireDemo(member, "No seeded Den member");
  const adminAuth = { authorization: `Bearer ${admin.token}` };
  const context = await denFetch(admin, "/v1/org", { headers: adminAuth });
  const org = isRecord(context.body) ? context.body.organization : null;
  requireDemo(isRecord(org) && typeof org.id === "string", "No seeded organization ID");
  const enabled = await denFetch(admin, `/v1/admin/organizations/${org.id}/capabilities`, { method: "PUT", headers: adminAuth, body: JSON.stringify({ capabilities: { sandboxTools: true } }) });
  requireDemo(enabled.response.ok, "Local Den rollout flag could not be enabled");
  const shots: string[] = [];
  const directories: string[] = [];
  const assertPolicy = () => poll("actual member received host_execution deny", () => denFetch(member, "/v1/me/desktop-config", { headers: { authorization: `Bearer ${member.token}`, "X-OpenWork-Sandbox-Only": "1", "X-OpenWork-Sandbox-Modes": "1" } }), row => row.response.ok && isRecord(row.body) && isRecord(row.body.agentPermissions) && Array.isArray(row.body.agentPermissions.rules) && row.body.agentPermissions.rules.some(rule => isRecord(rule) && rule.action === "host_execution" && rule.effect === "deny"));
  if (desktopOnly) {
    const set = await denFetch(admin, "/v1/agent-permissions/everyone", { method: "PUT", headers: { ...adminAuth, "X-OpenWork-Sandbox-Only": "1", "X-OpenWork-Sandbox-Modes": "1" }, body: JSON.stringify({ settings: { hostExecution: { decision: "deny" } } }) });
    requireDemo(set.response.ok, `Could not seed fallback local policy (HTTP ${set.response.status})`);
    await assertPolicy();
  } else {
    await using browser = new AsyncDisposableStack();
    const host = localHost();
    const handle = await host.spawnChrome("sandbox-demo-den", { startUrl: "about:blank", headless: true });
    browser.defer(() => host.disposeSurface(handle));
    const web = browser.use(await attachSurface(handle));
    const origin = new URL(den.ref.webUrl).origin;
    requireDemo(new URL(origin).hostname === "127.0.0.1", "Den web must be local");
    const path = "/dashboard/members/teams/everyone?tab=agents";
    {
      await using initialSession = await addInitScript(web.client, browserScript((origin, token) => {
        if (location.origin === origin) localStorage.setItem("openwork:web:auth-token", token);
      }, [origin, admin.token]));
      await navigate(web.client, new URL(path, origin).href);
      await poll("Den Agent Permissions editor loaded", () => evaluateOnSurface(web, () => !!document.querySelector('[data-testid="sandbox-force-requirement"]')), Boolean, 55_000);
    }
    const directory = join(root, "den-film");
    await film(web, directory, signal, async ui => {
      await ui.click(testId("sandbox-force-requirement"));
      await poll("Force is checked in the Den editor", () => evaluateOnSurface(web, () => !!document.querySelector('[data-testid="agent-permission-hostExecution"][data-decision="deny"]')), Boolean, 4000);
      await ui.click(button("Save changes"));
      await assertPolicy();
      const still = join(root, "06-org-lock-den.png");
      await ui.still(still);
      shots.push(still);
    }, 10_000);
    directories.push(directory);
  }
  const proxy = await uxDenProxy(den.ref.apiUrl);
  cleanup.defer(proxy.close);
  const desktop = await packagedDemoDesktop(cleanup, { root, signal, buildSha, den: { webUrl: proxy.url, apiUrl: proxy.url, member } });
  const directory = join(root, "member-film");
  await film(desktop.app, directory, signal, async ui => {
    await openPermissions(ui);
    await ui.see("sandbox-use-managed");
    await ui.see("sandbox-force-managed");
    const locked = await evaluateOnSurface(desktop.app, () => ["use", "force"].every(mode => !!document.querySelector(`[data-testid="sandbox-${mode}-switch"][aria-checked="true"]:is(:disabled,[aria-disabled="true"])`)));
    requireDemo(locked, "Both managed switches were not checked and locked");
    await desktop.settings(body => body.managedForce === true && body.effectiveForceSandbox === true);
    const still = join(root, "06-org-lock-desktop.png");
    await ui.still(still);
    shots.push(still);
  }, desktopOnly ? 20_250 : 11_000);
  directories.push(directory);
  return { directories, shots, outcome: `Member desktop returned managedForce=true and effectiveForceSandbox=true; both switches checked and locked. ${desktopOnly ? "Desktop segment only; local policy seeded off camera." : "Hard cut: seeded local Den admin / Everyone, then packaged desktop as a member."}` };
}
