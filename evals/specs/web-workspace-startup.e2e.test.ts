import { expect } from "vitest";
import { denFetch, grantOpenWorkWebAccess } from "@openwork/behaviors";
import { addInitScript, navigate } from "@openwork/cdp";
import { checkedExec, defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import { installCloudStartupFaults } from "@openwork/labs";
import { browserScript, eventually, evalIn, spec } from "@openwork/testkit";
import type { Seed } from "@openwork/testkit";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function cloudStartup(seed: Seed) {
  const den = await seed.den({
    web: false,
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DEN_ORG_MODE: "multi_org",
      DEN_GATEWAY_KEY: "startup-fixture-gateway-key", DEN_OPENWORK_WEB_ENABLED: "true",
      DEN_BOOTSTRAP_ADMIN_EMAILS: "startup-admin@openwork.test",
      STRIPE_OPENWORK_WEB_PRICE_ID: "price_startup_fixture",
      PROVISIONER_MODE: "daytona", DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
      DAYTONA_API_URL: process.env.DAYTONA_API_URL, DAYTONA_SNAPSHOT: process.env.DAYTONA_SNAPSHOT,
      DAYTONA_SHARED_VOLUME_NAME: `startup-fixture-${process.pid}`,
      DAYTONA_USE_DEPRECATED_POLLING: "false", DAYTONA_HEALTHCHECK_TIMEOUT_MS: "120000",
      WORKER_PROVISIONING_RECONCILE_INTERVAL_MS: "0", CLOUD_IDLE_LOOP_SECONDS: "0",
    },
    org: { name: "Startup Test", admin: { name: "Test Admin", email: "startup-admin@openwork.test" } },
  });
  const member = den.admin;
  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  const rows = record(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.filter(record) : [];
  const orgId = rows[0]?.id;
  if (typeof orgId !== "string") throw new Error("Missing isolated test organization");
  await grantOpenWorkWebAccess(den.admin, orgId, "Hosted workspace startup test");

  const app = await seed.appWeb({ name: "web-workspace-startup", workspacePath: seed.tmpPath("startup") });
  const sandboxId = app.handle.sandboxId;
  if (!sandboxId) throw new Error("This journey requires a Daytona appWeb surface");
  await execInSandbox(defaultDaytonaExec, sandboxId,
    `pnpm --filter @openwork/app build:web >/tmp/startup-app-build.log 2>&1 && pnpm --filter @openwork-ee/utils build >/tmp/startup-utils-build.log 2>&1 && pnpm --filter @openwork-ee/den-gateway build >/tmp/startup-gateway-build.log 2>&1 || exit 1; nohup env PORT=8789 DEN_API_BASE=${den.ref.apiUrl} DEN_GATEWAY_KEY=startup-fixture-gateway-key DEN_GATEWAY_WEB_ROOT=/workspace/apps/app/dist node /workspace/ee/apps/den-gateway/dist/server.js </dev/null >/tmp/startup-gateway.log 2>&1 &`,
    { context: "build source web app and real Den Gateway", timeoutMs: 240_000 });
  const preview = await checkedExec(defaultDaytonaExec, ["preview-url", sandboxId, "-p", "8789"], "startup gateway preview", { timeoutMs: 30_000 });
  const gatewayUrl = preview.stdout.split(/\s+/).find((value) => value.startsWith("https://"));
  if (!gatewayUrl) throw new Error("Missing gateway preview");
  await eventually(async () => (await fetch(`${gatewayUrl}/__gw/health`, { signal: AbortSignal.timeout(10_000) })).status,
    { within: 60_000, intervalMs: 1_000, label: "Den Gateway health", until: (status) => status === 200 });
  await addInitScript(app.client, browserScript((input) => {
    localStorage.setItem("openwork.den.authToken", input.token);
    localStorage.setItem("openwork.den.activeOrgId", input.orgId);
    // Capture observed UI transitions, not backend time estimates. No secrets,
    // URLs or response bodies are retained in the witness.
    const states: { state: string; ms: number }[] = [];
    Object.assign(window, { startupWitness: states });
    const observer = new MutationObserver(() => {
      const status = document.querySelector('[data-testid="cloud-workspace-takeover"]');
      const state = status?.getAttribute("data-cloud-workspace-state") ??
        (document.querySelector('[data-testid="web-startup-screen"]')?.textContent ||
          (document.querySelector('button[aria-label="Run task"]') ? "composer-visible" :
            document.querySelector('[data-testid="session-startup-skeleton"]') ? "chat-skeleton" : "app-starting"));
      if (states.at(-1)?.state !== state) states.push({ state, ms: Math.round(performance.now()) });
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true });
  }, [{ token: member.token, orgId }]));
  await addInitScript(app.client, browserScript(installCloudStartupFaults, []));
  return { app, gatewayUrl, member, orgId };
}

const test = spec.world(cloudStartup, {
  timeout: 900_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
  needs: { env: ["DAYTONA_API_KEY", "DAYTONA_SNAPSHOT"] },
});

test("WEB-STARTUP-01 real Daytona cold boot keeps one workspace status until chat is usable", async ({ world, user, step, evidence }) => {
  const startedAt = Date.now();
  await navigate(world.app.client, world.gatewayUrl);
  await step("a real cold workspace boot has one calm status and no inferred file progress", async () => {
    await user.see({ text: /(?:Starting|Creating) your cloud workspace/ }, { timeoutMs: 90_000 });
    await user.notSee({ text: "Restoring your files" });
    await user.notSee({ text: "Reserving your computer" });
    await user.looks([
      "The sidebar is visible while the main pane shows a small cloud workspace startup status.",
      "There is no three-step checklist, progress bar, or large bordered startup card.",
    ]);
  });
  await step("cloud readiness hands off to the real composer", async () => {
    await user.see("Run task", { timeoutMs: 240_000 });
    const usableMs = Date.now() - startedAt;
    await user.notSee({ text: "Starting your cloud workspace…" });
    await user.notSee({ text: "Connecting to your workspace…" });
    const witness = await evalIn(world.app, () => Reflect.get(window, "startupWitness"));
    expect(Array.isArray(witness) && witness.some((entry) => record(entry) && entry.state === "composer-visible")).toBe(true);
    expect(Array.isArray(witness) && witness.some((entry) => record(entry) && entry.state === "chat-skeleton")).toBe(false);
    evidence.recordAssertionEvidence("Real Daytona hosted-web startup timing", JSON.stringify({ observedAfterMs: usableMs, states: witness, snapshot: process.env.DAYTONA_SNAPSHOT, measurement: "browser performance timestamps; includes auth, access, provisioning, gateway and route hydration" }), true);
    await user.looks(["The main pane shows the new-chat composer rather than a startup card or loading skeleton."]);
  });

  // Explicit fault-injection checks are separate from the real measurement.
  await step("a delayed web access check shares the quiet startup presentation", async () => {
    await evalIn(world.app, () => sessionStorage.setItem("eval.cloud-startup-fault", "access"));
    await user.reload();
    await user.see({ text: "Checking workspace access…" });
    await user.looks(["A small Checking workspace access status is visible without a large access card or a Reload action."]);
    await evalIn(world.app, () => sessionStorage.removeItem("eval.cloud-startup-fault"));
    await user.see("Run task", { timeoutMs: 120_000 });
  });
  await step("a ready instance with delayed workspace data keeps the connection status", async () => {
    await evalIn(world.app, () => sessionStorage.setItem("eval.cloud-startup-fault", "connecting"));
    await user.reload();
    await user.see({ text: "Connecting to your workspace…" }, { timeoutMs: 30_000 });
    await user.notSee({ text: "Pulling in the latest messages for this task." });
    await user.notSee({ text: "Create or connect a workspace" });
    await user.looks(["The sidebar remains visible with Connecting to your workspace and elapsed time in the main pane, without chat skeleton cards."]);
  });
  await step("a prolonged wake offers a status check without restarting or signing out", async () => {
    await evalIn(world.app, () => sessionStorage.setItem("eval.cloud-startup-fault", "waking"));
    await user.reload();
    await user.see({ text: "Your cloud workspace is taking longer than usual" }, { timeoutMs: 65_000 });
    await user.see({ role: "button", label: "Check again" });
    await user.notSee({ role: "button", label: "Sign out" });
    await user.looks(["The workspace wait has elapsed time and a Check again action, without a checklist or progress bar."]);
  });
  await step("a confirmed failure has recovery actions in the same workspace pane", async () => {
    await evalIn(world.app, () => sessionStorage.setItem("eval.cloud-startup-fault", "failed"));
    await user.reload();
    await user.see({ text: "Workspace needs attention" });
    await user.see({ role: "button", label: "Retry" });
    await user.notSee({ text: "Restoring your files" });
    await user.looks(["Workspace needs attention appears in the main pane with Retry and Sign out actions; the sidebar remains visible."]);
    await evalIn(world.app, () => sessionStorage.removeItem("eval.cloud-startup-fault"));
    await user.reload();
    await user.see("Run task", { timeoutMs: 120_000 });
  });
});
