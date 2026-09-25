import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
import { targetFromEnv } from "../../packages/world/src/target.ts";
import { trackResource } from "../../packages/world/src/ledger.ts";
import { progress } from "../../packages/world/src/events.ts";

const previewSteps = progress();
import { provisionWindowsReleaseSandbox } from "../../evals/packages/hosts/src/windows-release.ts";
import { sourceFor, sourcesFromEnv } from "../../packages/world/src/source.ts";
import { seedsFromEnv } from "../../packages/world/src/seed.ts";
import type { WorldOutput } from "../../packages/world/src/outputs.ts";

export type PreviewScenario = "blank" | "fresh" | "team" | "restricted" | "workspace";
export type PreviewSurface = "den" | "desktop";

export function parsePreviewOptions(argv: readonly string[], allowExternalRelease = false) {
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
  if (scenario === "blank" && releaseVersion === undefined && !allowExternalRelease) {
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

async function localSourceRef(): Promise<string> {
  const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    timeout: 10_000,
  });
  return stdout.trim();
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
  const target = targetFromEnv();
  if (release && surface !== "desktop") throw new Error("Published releases are supported only by preview-desktop.");
  if (target.os === "windows" && (surface !== "desktop" || !release || scenario !== "blank")) {
    throw new Error("Daytona Windows supports only a blank exact published preview-desktop release.");
  }
  if (release && place.kind !== "daytona") throw new Error("Published release previews require --place daytona.");
  const base = place.denBase();
  if (base.kind === "daytona" && !/^[0-9a-f]{40}$/.test(base.ref)) {
    throw new Error("Set OPENWORK_EVAL_REF to the reviewed, pushed full 40-character commit SHA before booting a preview.");
  }
  // Local previews run this checkout: Den on the local MySQL/Redis and the
  // desktop as a native window on this machine.
  const ref = base.kind === "daytona" ? base.ref : await localSourceRef();
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
    ref: output(ref, { group: "World", ...(base.kind === "local" ? { note: "Local checkout HEAD; uncommitted changes included" } : {}) }),
  };
  if (den.placement?.kind === "daytona") outputs.denSandbox = output(den.placement.sandboxId, { group: "World" });
  if (!fresh) {
    outputs.email = output(den.admin.email, { group: "Test account" });
    outputs.password = secret(den.admin.password, { group: "Test account" });
  }
  const windowsRelease = release && target.os === "windows"
    ? stack.use(await provisionWindowsReleaseSandbox({
        release,
        lifetimeMinutes: Number(process.env.OPENWORK_WORLD_PREVIEW_LIFETIME_MINUTES ?? "120"),
        onCreated: (sandbox, name) => trackResource({ kind: "daytona-windows-preview", id: sandbox, match: name, label: "Windows published desktop" }),
        step: (id, label) => previewSteps.step(id, label),
        // Provisioning chatter belongs in the world log, not over the live step list.
        log: (line) => console.log(line),
      }))
    : undefined;
  const releaseDesktop = release && !windowsRelease ? stack.use(await blankReleaseApp({ place, release })) : undefined;
  // Fresh stays a true first launch: only what the app itself creates, no harness workspace.
  const desktop = surface === "desktop" && !release
    ? stack.use(await app({ den, place, ...(fresh ? { signIn: false, workspace: false } : { as: "admin" }) }))
    : undefined;
  const desktopHandle = releaseDesktop?.handle ?? desktop?.handle;
  if (desktopHandle && place.kind === "local") {
    outputs.preview = output(den.ref.webUrl, { group: "Preview", note: "The OpenWork desktop window is open on this machine; Den web is linked here" });
    outputs.cdp = secret(desktopHandle.cdpUrl, { group: "Services" });
  } else if (desktopHandle) {
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
  if (windowsRelease) {
    await waitForNoVnc(windowsRelease.viewerUrl);
    outputs.preview = secret(windowsRelease.viewerUrl, { group: "Preview", note: "Private Windows noVNC viewer; reveal only in your terminal" });
    outputs.desktopSandbox = output(windowsRelease.sandbox, { group: "World" });
    if (windowsRelease.cdpUrl) outputs.cdp = secret(windowsRelease.cdpUrl, { group: "Services" });
    outputs.releaseVersion = output(windowsRelease.release.version, { group: "Release" });
    outputs.distribution = output(windowsRelease.release.distribution, { group: "Release" });
    outputs.platform = output("windows", { group: "Release" });
    outputs.architecture = output("x64", { group: "Release" });
    outputs.releaseAsset = output(windowsRelease.release.assetName, { group: "Release" });
    outputs.releaseDigest = output(windowsRelease.release.digest, { group: "Release" });
    outputs.releaseArchive = output(windowsRelease.installerPath, { group: "Release" });
    outputs.releaseBinary = output(windowsRelease.installPath, { group: "Release" });
    outputs.releaseInstall = output(windowsRelease.installPath.replace(/\\[^\\]+$/, ""), { group: "Release" });
    outputs.startup = output(windowsRelease.startup.state, { group: "Desktop", note: windowsRelease.startup.detail });
    outputs.desktopLog = output(windowsRelease.logPath, { group: "Desktop" });
    outputs.profilePath = output(windowsRelease.profilePath, { group: "Desktop" });
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
  outputs.denRef = output(ref, { group: "World", ...(release ? { note: "Pinned Den/tooling source; independent from published desktop bytes" } : {}) });
  return { den, desktop: releaseDesktop ?? desktop ?? windowsRelease, outputs };
}

/** Deps are injectable so the Freestyle contract is unit-testable without a VM. */
export interface FreestyleDesktopDeps {
  ensureSnapshot(sha: string): Promise<unknown>;
  launch(sha: string, lifetimeMinutes: number): Promise<{ id: string; snapshotId: string; url: string; expiresAt: string; outputs: Record<string, { value: string }> }>;
  remove(id: string): Promise<void>;
  track(id: string): Promise<void>;
}

async function defaultFreestyleDeps(): Promise<FreestyleDesktopDeps> {
  const { ensureSnapshot } = await import("../../packages/freestyle/src/builder.ts");
  const { launchPreview, deletePreview } = await import("../../packages/freestyle/src/index.ts");
  return {
    ensureSnapshot: (sha) => ensureSnapshot(sha, undefined, (message) => console.error(message), "desktop"),
    launch: (sha, lifetimeMinutes) => launchPreview({ gitSha: sha, lifetimeMinutes, world: "desktop" }),
    remove: (id) => deletePreview(id),
    track: (id) => trackResource({ kind: "freestyle-preview", id, match: id, label: "Freestyle signed-out desktop" }),
  };
}

/**
 * The Freestyle desktop snapshot is a signed-out first launch with no Den, so
 * only `fresh` from a pushed commit maps onto it. Anything else is refused
 * before a VM is created rather than quietly booting a different world.
 */
export function freestyleDesktopPlan(input: {
  surface: PreviewSurface;
  argv: readonly string[];
  sources: ReturnType<typeof sourcesFromEnv>;
  seeds: ReturnType<typeof seedsFromEnv>;
}): { sha: string; lifetimeMinutes: number } {
  if (input.surface !== "desktop") throw new Error("preview-den cannot run on Freestyle; use Daytona or local.");
  const parsed = parsePreviewOptions(input.argv);
  if (parsed.release) throw new Error("Freestyle desktop runs a pushed commit, not a published release; use --place daytona for releases.");
  if (input.argv.includes("--scenario") && parsed.scenario !== "fresh") {
    throw new Error("Freestyle desktop supports only the signed-out fresh scenario.");
  }
  if (input.seeds.length > 1 || input.seeds.some((seed) => seed.name !== "fresh" || seed.arg !== undefined)) {
    throw new Error("Freestyle desktop supports only --seed fresh.");
  }
  const unknown = Object.keys(input.sources).filter((key) => key !== "*" && key !== "desktop");
  if (unknown.length > 0) throw new Error(`Freestyle desktop has no ${unknown.join(", ")} component; it runs without a Den.`);
  const source = sourceFor(input.sources, "desktop");
  if (source?.kind !== "sha") throw new Error("Freestyle desktop needs --source desktop=sha:<full-pushed-sha> or ref:<branch>.");
  if (!input.argv.includes("--lifetime")) return { sha: source.sha, lifetimeMinutes: 120 };
  if (parsed.lifetimeMinutes < 10 || parsed.lifetimeMinutes > 1430) {
    throw new Error("Freestyle desktop lifetime must be 10-1430 minutes; Freestyle VMs always have a provider TTL.");
  }
  return { sha: source.sha, lifetimeMinutes: parsed.lifetimeMinutes };
}

export async function bootFreestyleDesktop(
  stack: AsyncDisposableStack,
  plan: { sha: string; lifetimeMinutes: number },
  deps: FreestyleDesktopDeps,
): Promise<Record<string, WorldOutput>> {
  await deps.ensureSnapshot(plan.sha);
  const preview = await deps.launch(plan.sha, plan.lifetimeMinutes);
  stack.defer(() => deps.remove(preview.id));
  await deps.track(preview.id);
  const status = preview.outputs.desktopStatus?.value;
  if (status !== "ready-signed-out") throw new Error("Freestyle desktop did not report a signed-out ready state.");
  return {
    preview: secret(preview.url, { group: "Preview", note: "Private signed-out Linux desktop (noVNC); reveal only in your terminal" }),
    desktopStatus: output(status, { group: "Desktop" }),
    scenario: output("fresh", { group: "World" }),
    ref: output(plan.sha, { group: "World", note: "Pushed commit baked into the Freestyle snapshot" }),
    placement: output("freestyle", { group: "World" }),
    freestyleVm: output(preview.id, { group: "World" }),
    snapshotId: output(preview.snapshotId, { group: "World" }),
    expires: output(preview.expiresAt, { group: "World", note: "Freestyle provider TTL; the VM is deleted even if this driver stops" }),
  };
}

export async function runPreview(surface: PreviewSurface, argv = process.argv.slice(2), freestyleDeps?: FreestyleDesktopDeps): Promise<void> {
  const target = targetFromEnv();
  if (target.provider === "freestyle") {
    const plan = freestyleDesktopPlan({ surface, argv, sources: sourcesFromEnv(), seeds: seedsFromEnv() });
    await using stack = new AsyncDisposableStack();
    const outputs = await bootFreestyleDesktop(stack, plan, freestyleDeps ?? await defaultFreestyleDeps());
    const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), plan.lifetimeMinutes * 60_000);
    try {
      await hold({ name: `preview-${surface}`, outputs });
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  if (target.os === "windows" && target.provider === "daytona" && surface === "desktop") process.env.OPENWORK_WORLD_PREVIEW_DAYTONA = "1";
  const sources = sourcesFromEnv();
  const parsed = parsePreviewOptions(argv, sourceFor(sources, "desktop")?.kind === "release");
  const seeds = seedsFromEnv();
  // Existing script arguments are still accepted, but never let two independent
  // source/seed mechanisms disagree about what this world is going to boot.
  const desktopSource = sourceFor(sources, "desktop");
  const denSource = sourceFor(sources, "den");
  const unsupportedSources = Object.keys(sources).filter((key) => !["*", "desktop", "den"].includes(key));
  if (unsupportedSources.length > 0) throw new Error(`Preview does not have components: ${unsupportedSources.join(", ")}.`);
  if (desktopSource && desktopSource.kind !== "release" && !(desktopSource.kind === "local" && target.provider === "local")) {
    throw new Error("Preview desktop --source must be a published release, or local when running on this computer.");
  }
  if (surface === "den" && desktopSource) throw new Error("preview-den cannot select a desktop source.");
  if (denSource?.kind === "release") throw new Error("Den source must be a reviewed commit SHA or local checkout, not a desktop release.");
  if (target.provider === "local" && denSource?.kind === "sha") {
    throw new Error("Local previews use this working tree for Den; --source den=sha:<sha> requires Daytona.");
  }
  if (target.provider === "local" && desktopSource?.kind === "release") {
    throw new Error("Published release previews require Daytona; local desktop previews use this checkout.");
  }
  if (parsed.release && desktopSource) throw new Error("Choose either --source desktop=release:... or -- --release, not both.");
  if (denSource?.kind === "sha") {
    if (process.env.OPENWORK_EVAL_REF?.trim() && process.env.OPENWORK_EVAL_REF !== denSource.sha) {
      throw new Error("Den --source conflicts with OPENWORK_EVAL_REF.");
    }
    process.env.OPENWORK_EVAL_REF = denSource.sha;
  }
  if (denSource?.kind === "local" && target.provider === "daytona") {
    throw new Error("A remote Den requires a pushed SHA, not a local checkout.");
  }
  // Resolve Place only after the Den source has been pinned. DaytonaPlace
  // captures its ref in the constructor; resolving earlier would boot `dev`.
  const place = resolvePlace();
  const seedNames = seeds.map((seed) => seed.name);
  if (new Set(seedNames).size !== seedNames.length || seedNames.length > 1) throw new Error("Preview accepts one scenario seed; choose fresh, team, restricted, workspace, or blank.");
  const seed = seeds[0];
  if (seed?.arg || (seed && !["fresh", "team", "restricted", "workspace", "blank"].includes(seed.name))) {
    throw new Error("Preview --seed accepts exactly fresh, team, restricted, workspace, or blank without arguments.");
  }
  if (seed && argv.includes("--scenario")) throw new Error("Choose either --seed or -- --scenario, not both.");
  const scenario = seed?.name === "fresh" || seed?.name === "team" || seed?.name === "restricted" || seed?.name === "workspace" || seed?.name === "blank"
    ? seed.name : desktopSource ? "blank" : parsed.scenario;
  const release = desktopSource?.kind === "release"
    ? { version: desktopSource.version, distribution: desktopSource.distribution } : parsed.release;
  if (release && scenario !== "blank") throw new Error("Published release previews support only --scenario blank.");
  if (scenario === "blank" && !release) throw new Error("The blank scenario requires an exact published release.");
  const { lifetimeMinutes } = parsed;
  if (target.os === "windows" && lifetimeMinutes > 1410) throw new Error("Windows previews support --lifetime 0-1410 (30 minutes reserved for sandbox startup).");
  if (place.kind === "daytona" && !process.env.OPENWORK_EVAL_REF?.trim()) {
    try {
      const { stdout } = await promisify(execFile)("git", ["ls-remote", "--exit-code", "origin", "refs/heads/dev"], {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        timeout: 30_000,
      });
      const ref = stdout.trim().split(/\s+/)[0];
      if (!ref || !/^[0-9a-f]{40}$/.test(ref)) throw new Error("Remote dev did not return a full commit SHA.");
      process.env.OPENWORK_EVAL_REF = ref;
      console.error(`preview  defaulting to origin/dev at ${ref}`);
    } catch (cause) {
      throw new Error("Could not resolve remote dev for this preview. Check access to origin or set OPENWORK_EVAL_REF to a reviewed, pushed full 40-character commit SHA.", { cause });
    }
  }
  if (place.kind === "daytona") process.env.OPENWORK_WORLD_PREVIEW_DAYTONA = "1";
  process.env.OPENWORK_WORLD_PREVIEW_LIFETIME_MINUTES = String(lifetimeMinutes);
  await using stack = new AsyncDisposableStack();
  const { outputs } = await bootPreview(stack, place, surface, scenario, release);
  const expires = lifetimeMinutes === 0 ? undefined : new Date(Date.now() + lifetimeMinutes * 60_000);
  outputs.expires = output(expires?.toISOString() ?? "Until stopped", { group: "World", note: "Session lifetime, not an idle timer" });
  const timer = expires ? setTimeout(() => process.kill(process.pid, "SIGTERM"), lifetimeMinutes * 60_000) : undefined;
  try {
    await hold({ name: `preview-${surface}`, outputs });
  } finally {
    clearTimeout(timer);
  }
}
