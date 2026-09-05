import { randomBytes } from "node:crypto";
import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import { app } from "../../evals/packages/env/src/desktop-app.ts";
import { server } from "../../evals/packages/env/src/den.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";
import { resolvePlace } from "../../evals/packages/env/src/place.ts";
import type { Place } from "../../evals/packages/env/src/place.ts";
import { daytonaSandbox } from "../../evals/packages/hosts/src/resolve.ts";
import { hold } from "../../packages/world/src/hold.ts";
import { output, secret } from "../../packages/world/src/outputs.ts";
import type { WorldOutput } from "../../packages/world/src/outputs.ts";

export type PreviewScenario = "fresh" | "team" | "restricted" | "workspace";
export type PreviewSurface = "den" | "desktop";

export function parsePreviewOptions(argv: readonly string[]) {
  let scenario: PreviewScenario = "fresh";
  let lifetimeMinutes = 120;
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === "--scenario" && (value === "fresh" || value === "team" || value === "restricted" || value === "workspace")) {
      scenario = value;
    } else if (argv[i] === "--lifetime" && value !== undefined && /^\d+$/.test(value) && Number(value) <= 1440) {
      lifetimeMinutes = Number(value);
    } else {
      throw new Error("Use --scenario fresh|team|restricted|workspace and --lifetime <minutes, 0 keeps running, maximum 1440>.");
    }
  }
  return { scenario, lifetimeMinutes };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function setupTeam(den: Den, restricted: boolean): Promise<void> {
  const headers = { authorization: `Bearer ${den.admin.token}` };
  // OAuth metadata only: no live provider call or account authorization.
  for (const [name, url] of [["Notion", "https://mcp.notion.com/mcp"], ["Linear", "https://mcp.linear.app/mcp"]]) {
    const result = await denFetch(den.ref, "/v1/mcp-connections", {
      method: "POST", headers,
      body: JSON.stringify({ name, url, authType: "oauth", credentialMode: "per_member", access: { orgWide: true, memberIds: [], teamIds: [] } }),
    });
    if (!result.response.ok) throw new Error(`Could not seed ${name}: HTTP ${result.response.status}`);
  }
  if (!restricted) return;
  const result = await denFetch(den.ref, "/v1/desktop-policies", { headers });
  if (!result.response.ok || !record(result.body) || !Array.isArray(result.body.desktopPolicies) || !Array.isArray(result.body.definitions)) {
    throw new Error("Could not load desktop policy definitions for this preview.");
  }
  const policy = result.body.desktopPolicies.find((entry: unknown) => record(entry) && entry.isDefault === true);
  if (!record(policy) || typeof policy.id !== "string") throw new Error("Preview has no default desktop policy.");
  const restrictedPolicy: Record<string, boolean> = {};
  for (const definition of result.body.definitions) {
    if (record(definition) && typeof definition.id === "string" && typeof definition.restrictedValue === "boolean") {
      restrictedPolicy[definition.id] = definition.restrictedValue;
    }
  }
  if (Object.keys(restrictedPolicy).length === 0) throw new Error("No restricted policy values returned by Den.");
  const saved = await denFetch(den.ref, `/v1/desktop-policies/${encodeURIComponent(policy.id)}`, {
    method: "PATCH", headers, body: JSON.stringify({ policyName: "Restricted preview", policy: restrictedPolicy }),
  });
  if (!saved.response.ok) throw new Error(`Could not apply restricted preview policy: HTTP ${saved.response.status}`);
}

/** Owned, disposable infrastructure only. Never attach a preview to an existing test or production sandbox. */
export async function bootPreview(stack: AsyncDisposableStack, place: Place, surface: PreviewSurface, scenario: PreviewScenario) {
  if (place.kind !== "daytona") throw new Error("Interactive previews require --place daytona.");
  const base = place.denBase();
  if (base.kind !== "daytona" || !/^[0-9a-f]{40}$/.test(base.ref)) {
    throw new Error("Set OPENWORK_EVAL_REF to the reviewed, pushed full 40-character commit SHA before booting a preview.");
  }
  if (["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DAYTONA_DEN_SANDBOX", "OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX", "OPENWORK_EVAL_DAYTONA_SANDBOX"].some((key) => process.env[key]?.trim())) {
    throw new Error("Preview worlds require isolated infrastructure. Remove existing sandbox/reuse overrides before starting.");
  }
  const fresh = scenario === "fresh";
  const den = stack.use(await server({
    place, provision: !fresh, web: true,
    ...(!fresh ? { org: { name: "Preview team", admin: { name: "Preview owner", email: `preview-${randomBytes(6).toString("hex")}@example.test` } } } : {}),
    env: { OPENWORK_DEV_MODE: "1", DEN_REQUIRE_EMAIL_VERIFICATION: "false", RESEND_API_KEY: "", SMTP_HOST: "" },
  }));
  if (scenario === "team" || scenario === "restricted") await setupTeam(den, scenario === "restricted");
  const outputs: Record<string, WorldOutput> = {
    preview: output(fresh ? `${den.ref.webUrl}/?mode=sign-up` : `${den.ref.webUrl}/dashboard`, { group: "Preview" }),
    denWeb: output(den.ref.webUrl, { group: "Services" }),
    denApi: output(den.ref.apiUrl, { group: "Services" }),
    emailOutbox: output(`${den.ref.apiUrl}/v1/dev/emails`, { group: "Services", note: "Test mail only; no messages leave this world" }),
    scenario: output(scenario, { group: "World" }),
    ref: output(base.ref, { group: "World" }),
  };
  if (den.placement?.kind === "daytona") outputs.denSandbox = output(den.placement.sandboxId, { group: "World" });
  if (!fresh) {
    outputs.email = output(den.admin.email, { group: "Test account" });
    outputs.password = secret(den.admin.password, { group: "Test account" });
  }
  const desktop = surface === "desktop" ? stack.use(await app({ den, place, ...(fresh ? { signIn: false } : { as: "admin" }) })) : undefined;
  if (desktop) {
    const sandbox = desktop.handle.sandboxId;
    if (!sandbox) throw new Error("Desktop preview did not return its owned Daytona sandbox.");
    const host = daytonaSandbox(sandbox);
    if (!host.previewUrl) throw new Error("Daytona host cannot expose its viewer.");
    const url = new URL(await host.previewUrl(6080));
    url.search = "autoconnect=1&resize=scale&reconnect=1&reconnect_delay=2000";
    outputs.preview = output(url.href, { group: "Preview", note: "Real Linux Electron app · noVNC · clipboard in the side toolbar" });
    outputs.desktopSandbox = output(sandbox, { group: "World" });
    outputs.cdp = secret(desktop.handle.cdpUrl, { group: "Services" });
  }
  return { den, desktop, outputs };
}

export async function runPreview(surface: PreviewSurface, argv = process.argv.slice(2)): Promise<void> {
  const { scenario, lifetimeMinutes } = parsePreviewOptions(argv);
  await using stack = new AsyncDisposableStack();
  const { outputs } = await bootPreview(stack, resolvePlace(), surface, scenario);
  const expires = lifetimeMinutes === 0 ? undefined : new Date(Date.now() + lifetimeMinutes * 60_000);
  outputs.expires = output(expires?.toISOString() ?? "Until stopped", { group: "World", note: "Session lifetime, not an idle timer" });
  const timer = expires ? setTimeout(() => process.kill(process.pid, "SIGTERM"), lifetimeMinutes * 60_000) : undefined;
  try {
    await hold({ name: `preview-${surface}`, outputs });
  } finally {
    clearTimeout(timer);
  }
}
