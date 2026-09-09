import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import { app, blankReleaseApp } from "../../evals/packages/env/src/desktop-app.ts";
import { server } from "../../evals/packages/env/src/den.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";
import { resolvePlace } from "../../evals/packages/env/src/place.ts";
import type { Place } from "../../evals/packages/env/src/place.ts";
import { daytonaSandbox } from "../../evals/packages/hosts/src/resolve.ts";
import type { DesktopRelease, DesktopReleaseDistribution } from "../../evals/packages/hosts/src/types.ts";
import { hold } from "../../packages/world/src/hold.ts";
import { output, secret } from "../../packages/world/src/outputs.ts";
import type { WorldOutput } from "../../packages/world/src/outputs.ts";

export type PreviewScenario = "blank" | "fresh" | "team" | "restricted" | "workspace";
export type PreviewSurface = "den" | "desktop";

export function parsePreviewOptions(argv: readonly string[]) {
  let scenario: PreviewScenario = "fresh";
  let lifetimeMinutes = 120;
  let releaseVersion: string | undefined;
  let distribution: DesktopReleaseDistribution | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === "--scenario" && (value === "blank" || value === "fresh" || value === "team" || value === "restricted" || value === "workspace")) {
      scenario = value;
    } else if (argv[i] === "--lifetime" && value !== undefined && /^\d+$/.test(value) && Number(value) <= 1440) {
      lifetimeMinutes = Number(value);
    } else if (argv[i] === "--release" && value !== undefined && /^\d+\.\d+\.\d+$/.test(value)) {
      releaseVersion = value;
    } else if (argv[i] === "--distribution" && (value === "public" || value === "cloud" || value === "enterprise")) {
      distribution = value;
    } else {
      throw new Error("Use --scenario blank|fresh|team|restricted|workspace, --release <x.y.z>, --distribution public|cloud|enterprise, and --lifetime <minutes, 0 keeps running, maximum 1440>.");
    }
  }
  if ((releaseVersion === undefined) !== (distribution === undefined)) {
    throw new Error("Published previews require both --release <x.y.z> and --distribution public|cloud|enterprise.");
  }
  if (scenario === "blank" && releaseVersion === undefined) {
    throw new Error("The blank scenario requires an exact published --release and --distribution.");
  }
  if (releaseVersion !== undefined && scenario !== "blank") {
    throw new Error("Published release previews support only --scenario blank.");
  }
  const release: DesktopRelease | undefined = releaseVersion && distribution
    ? { version: releaseVersion, distribution }
    : undefined;
  return { scenario, lifetimeMinutes, release };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new Error(`Published desktop preview is missing ${key} metadata.`);
  return value;
}

async function noVncRfbBanner(viewerUrl: string): Promise<string> {
  const endpoint = new URL("/websockify", viewerUrl);
  endpoint.protocol = "wss:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, ["binary"]);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("noVNC did not reach the desktop RFB server"));
    }, 10_000);
    socket.onmessage = (event) => {
      clearTimeout(timer);
      socket.close();
      resolve(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
    };
    socket.onerror = () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("noVNC WebSocket failed"));
    };
  });
}

async function waitForNoVnc(viewerUrl: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(viewerUrl, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`viewer returned HTTP ${response.status}`);
      const banner = await noVncRfbBanner(viewerUrl);
      if (!banner.startsWith("RFB 003.")) throw new Error(`unexpected RFB banner ${JSON.stringify(banner)}`);
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      await delay(1_000);
    }
  }
  throw new Error(`Desktop preview transport did not become ready: ${last}`);
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
export async function bootPreview(stack: AsyncDisposableStack, place: Place, surface: PreviewSurface, scenario: PreviewScenario, release?: DesktopRelease) {
  if (place.kind !== "daytona") throw new Error("Interactive previews require --place daytona.");
  if (release && surface !== "desktop") throw new Error("Published releases are supported only by preview-desktop.");
  const base = place.denBase();
  if (base.kind !== "daytona" || !/^[0-9a-f]{40}$/.test(base.ref)) {
    throw new Error("Set OPENWORK_EVAL_REF to the reviewed, pushed full 40-character commit SHA before booting a preview.");
  }
  if (["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DAYTONA_DEN_SANDBOX", "OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX", "OPENWORK_EVAL_DAYTONA_SANDBOX"].some((key) => process.env[key]?.trim())) {
    throw new Error("Preview worlds require isolated infrastructure. Remove existing sandbox/reuse overrides before starting.");
  }
  const fresh = scenario === "fresh" || scenario === "blank";
  const den = stack.use(await server({
    place, provision: !fresh, web: true,
    daytonaAutoStopMinutes: 0,
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
  const releaseDesktop = release ? stack.use(await blankReleaseApp({ place, release })) : undefined;
  const desktop = surface === "desktop" && !release ? stack.use(await app({ den, place, ...(fresh ? { signIn: false } : { as: "admin" }) })) : undefined;
  const desktopHandle = releaseDesktop?.handle ?? desktop?.handle;
  if (desktopHandle) {
    const sandbox = desktopHandle.sandboxId;
    if (!sandbox) throw new Error("Desktop preview did not return its owned Daytona sandbox.");
    const host = daytonaSandbox(sandbox);
    if (!host.previewUrl) throw new Error("Daytona host cannot expose its viewer.");
    const url = new URL(await host.previewUrl(6080));
    url.search = "autoconnect=1&resize=scale&reconnect=1&reconnect_delay=2000";
    await waitForNoVnc(url.href);
    outputs.preview = output(url.href, { group: "Preview", note: "Real Linux Electron app · noVNC · clipboard in the side toolbar" });
    outputs.desktopSandbox = output(sandbox, { group: "World" });
    if (!releaseDesktop || releaseDesktop.startup.state === "cdp-responsive") {
      outputs.cdp = secret(desktopHandle.cdpUrl, { group: "Services" });
    }
  }
  if (releaseDesktop) {
    const meta = releaseDesktop.handle.meta ?? {};
    const profilePath = releaseDesktop.handle.profileDir;
    if (!profilePath) throw new Error("Published desktop preview is missing its profile path.");
    outputs.releaseVersion = output(requiredString(meta, "releaseVersion"), { group: "Release" });
    outputs.distribution = output(requiredString(meta, "releaseDistribution"), { group: "Release" });
    outputs.platform = output("linux", { group: "Release" });
    outputs.architecture = output("x64", { group: "Release" });
    outputs.releaseAsset = output(requiredString(meta, "releaseAsset"), { group: "Release" });
    outputs.releaseDigest = output(requiredString(meta, "releaseDigest"), { group: "Release" });
    outputs.releaseArchive = output(requiredString(meta, "releaseArchive"), { group: "Release" });
    outputs.releaseBinary = output(requiredString(meta, "releaseBinary"), { group: "Release" });
    outputs.releaseInstall = output(requiredString(meta, "releaseInstallRoot"), { group: "Release" });
    outputs.releaseManifest = output(requiredString(meta, "releaseManifest"), { group: "Release" });
    outputs.startup = output(releaseDesktop.startup.state, { group: "Desktop", note: releaseDesktop.startup.detail });
    outputs.desktopLog = output(requiredString(meta, "log"), { group: "Desktop" });
    outputs.profilePath = output(profilePath, { group: "Desktop" });
    outputs.desktopPid = output(requiredString(meta, "remotePid"), { group: "Desktop" });
    outputs.protocolHandler = output(requiredString(meta, "protocolHandler"), { group: "Desktop" });
    outputs.relaunchShortcut = output(requiredString(meta, "relaunchShortcut"), { group: "Desktop" });
    outputs.browserShortcut = output(requiredString(meta, "browserShortcut"), { group: "Desktop" });
  }
  outputs.denRef = output(base.ref, { group: "World", ...(release ? { note: "Pinned Den/tooling source; independent from published desktop bytes" } : {}) });
  return { den, desktop: releaseDesktop ?? desktop, outputs };
}

export async function runPreview(surface: PreviewSurface, argv = process.argv.slice(2)): Promise<void> {
  const { scenario, lifetimeMinutes, release } = parsePreviewOptions(argv);
  process.env.OPENWORK_WORLD_PREVIEW_DAYTONA = "1";
  await using stack = new AsyncDisposableStack();
  const { outputs } = await bootPreview(stack, resolvePlace(), surface, scenario, release);
  const expires = lifetimeMinutes === 0 ? undefined : new Date(Date.now() + lifetimeMinutes * 60_000);
  outputs.expires = output(expires?.toISOString() ?? "Until stopped", { group: "World", note: "Session lifetime, not an idle timer" });
  const timer = expires ? setTimeout(() => process.kill(process.pid, "SIGTERM"), lifetimeMinutes * 60_000) : undefined;
  try {
    await hold({ name: `preview-${surface}`, outputs });
  } finally {
    clearTimeout(timer);
  }
}
