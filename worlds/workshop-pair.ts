/**
 * One private Den (Gateway, workshop model, five OAuth connectors) plus ONE
 * ordinary member's Daytona desktop. Every stage is timed in status.json. A
 * failed stage does not tear the pair down: the world keeps holding so the
 * operator can inspect, fix and rerun checks. `pnpm world down` (or the
 * provider TTL) removes it. Checks run separately: worlds/workshop-pair-check.ts.
 */
import { assertTrustedWorkshopRef, assertVerifiedWorkshopSnapshot } from "./lib/workshop-trust.ts";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Surface } from "../evals/packages/cdp/src/index.ts";
import { control as runControl, waitUntilInteractive } from "../evals/packages/behaviors/src/desktop.ts";
import type { Den } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import { chrome } from "../evals/packages/hosts/src/browser.ts";
import { createDaytonaHost, defaultDaytonaExec } from "../evals/packages/hosts/src/daytona.ts";
import { deleteSandboxes, execInSandbox, provisionDesktopSandbox } from "../evals/packages/hosts/src/provision.ts";
import { parsePrivatePreview, privateSandboxId } from "../evals/packages/hosts/src/private-web-preview.ts";
import { hold } from "../packages/world/src/hold.ts";
import { trackResource } from "../packages/world/src/ledger.ts";
import { output, secret } from "../packages/world/src/outputs.ts";
import type { WorldOutput } from "../packages/world/src/outputs.ts";
import { targetFromEnv } from "../packages/world/src/target.ts";
import { configureWorkshop, WORKSHOP_MAX_ATTENDEES } from "./lib/workshop-setup.ts";
import { assertDaytonaCapacity } from "./lib/workshop-capacity.ts";
import { pagedSnapshotListExec } from "./lib/workshop-snapshot.ts";
import { grantOpenWorkWebAccess } from "../evals/packages/behaviors/src/workflows.ts";
import { redactWorkshopDiagnostic } from "./lib/workshop-redaction.ts";
import { unlockWorkshopDesktop } from "./lib/workshop-unlock.ts";
import { linkWorkshopRuntime, selectWorkshopModel } from "./lib/workshop-models.ts";
import { connectWorkshopBrowser, foregroundWorkshopDesktop, installWorkshopBrowser, WORKSHOP_BROWSER_LAUNCHER, WORKSHOP_BROWSER_PROFILE, workshopRemoteScript } from "./lib/workshop-browser.ts";
import { freshComposer, verifyMember, verifySandbox, verifyViewer, workshopAccountPassword } from "./workshop-fleet.ts";

export const summary = "One private Den/Gateway with the workshop model and five OAuth connectors, plus one ordinary member's Daytona desktop; holds on failure for inspection.";
export const supportedTargets = ["daytona/linux"];
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface PairStage { name: string; startedAt: string; endedAt?: string; seconds?: number; ok?: boolean; error?: string }

export function parsePairOptions(argv: readonly string[]) {
  let lifetimeMinutes = 240;
  let outputDir = "";
  let timezone = "America/Los_Angeles";
  let seats = 1;
  let concurrency = 10;
  let snapshot: string | undefined;
  let budgetUsd = 200;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag || !value || seen.has(flag)) throw new Error("Pair flags require one value each, without duplicates.");
    seen.add(flag);
    if (flag === "--lifetime" && /^\d+$/.test(value) && Number(value) >= 30 && Number(value) <= 1440) lifetimeMinutes = Number(value);
    else if (flag === "--output-dir" && isAbsolute(value)) outputDir = resolve(value);
    else if (flag === "--timezone" && /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(value) && Intl.supportedValuesOf("timeZone").includes(value)) timezone = value;
    else if (flag === "--seats" && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= WORKSHOP_MAX_ATTENDEES) seats = Number(value);
    else if (flag === "--budget-usd" && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0 && Number(value) <= 2000) budgetUsd = Number(value);
    else if (flag === "--concurrency" && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 20) concurrency = Number(value);
    else if (flag === "--snapshot" && /^workshop-desktop-[a-z0-9-]{1,80}$/.test(value)) snapshot = value;
    else throw new Error("Use --output-dir <private absolute path outside git>, optional --seats 1..99 (default 1), --budget-usd <infrastructure ceiling, default 200>, --snapshot workshop-desktop-<name> (clean, signed-out), --concurrency 1..20 (default 10), --lifetime 30..1440 (minutes, default 240) and --timezone <IANA zone, default America/Los_Angeles>.");
  }
  if (!outputDir) throw new Error("Pair requires --output-dir outside git (it holds a member test login and a private viewer link).");
  const rel = relative(REPO_ROOT, outputDir);
  if (rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("Pair output directory must be outside this checkout.");
  return { lifetimeMinutes, outputDir, timezone, seats, concurrency, snapshot, budgetUsd };
}

export function seatKey(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1 || index > WORKSHOP_MAX_ATTENDEES) throw new Error(`Seat index must be 1..${WORKSHOP_MAX_ATTENDEES}.`);
  return `attendee${String(index).padStart(2, "0")}`;
}

export function isProviderThrottle(error: unknown): boolean {
  return /Too Many Requests|ThrottlerException|\b429\b/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * Retry only provider rate limiting, and only before any sandbox exists: the
 * throttled calls (snapshot lookup, create) fail before a resource is owned.
 */
export async function retryThrottled<T>(run: () => Promise<T>, attempts = 5, baseMs = 4_000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await run(); }
    catch (error) {
      if (attempt >= attempts || !isProviderThrottle(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseMs * attempt + Math.floor(Math.random() * 2_000)));
    }
  }
}

/** Run every seat; one seat failing never stops or tears down the others. */
export async function forEachSeat<T>(count: number, concurrency: number, run: (index: number) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(count);
  let next = 1;
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next <= count) {
      const index = next++;
      try { results[index - 1] = { status: "fulfilled", value: await run(index) }; }
      catch (reason) { results[index - 1] = { status: "rejected", reason }; }
    }
  }));
  return results;
}

/** The attendee's local clock: "today"/"tomorrow" must not be UTC dates. */
export function workshopTimezoneScript(timezone: string): string {
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(timezone)) throw new Error("Invalid IANA timezone.");
  return `set -eu
test -f /usr/share/zoneinfo/${timezone}
sudo ln -sf /usr/share/zoneinfo/${timezone} /etc/localtime
echo ${timezone} | sudo tee /etc/timezone >/dev/null
test "$(date +%Z)" != UTC || test "${timezone}" = Etc/UTC
`;
}

/** One Den plus one desktop per seat, 4 CPU / 8 GiB each at list price, plus disk. */
export function pairInfrastructureUsd(lifetimeMinutes: number, seats = 1): number {
  const sandboxes = seats + 1;
  return sandboxes * 4 * 0.083 * lifetimeMinutes / 60 + sandboxes * 12 / 21 * lifetimeMinutes / 1440;
}

async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) {
    throw new Error("Output directory must be caller-owned, mode 0700, and not a symlink.");
  }
  const canonical = await realpath(path);
  for (let directory = canonical; directory !== dirname(directory); directory = dirname(directory)) {
    const git = await lstat(join(directory, ".git")).then(() => true, () => false);
    if (git) throw new Error("Pair output directory must not be inside any Git worktree.");
  }
}
async function privateJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function screenshot(surface: Surface, path: string) {
  const image: unknown = await surface.client.send("Page.captureScreenshot", { format: "png" });
  if (typeof image !== "object" || image === null || !("data" in image) || typeof image.data !== "string") return;
  await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parsePairOptions(argv);
  const target = targetFromEnv();
  if (target.provider !== "daytona" || target.os !== "linux") throw new Error("Workshop pair supports only --place daytona --os linux.");
  const upstreamKey = process.env.OPENAI_API_KEY;
  if (!upstreamKey?.trim()) throw new Error("Fetch OPENAI_API_KEY into the controller environment before starting.");
  const estimateUsd = pairInfrastructureUsd(options.lifetimeMinutes, options.seats);
  if (estimateUsd > options.budgetUsd) throw new Error(`Estimated infrastructure $${estimateUsd.toFixed(0)} exceeds --budget-usd ${options.budgetUsd}; shorten --lifetime, use fewer --seats, or raise --budget-usd deliberately.`);
  console.log(`Workshop: ${options.seats} seats for ${options.lifetimeMinutes} min, estimated infrastructure $${estimateUsd.toFixed(0)} (budget $${options.budgetUsd}).`);
  await assertDaytonaCapacity(options.seats + 1);
  await privateDirectory(options.outputDir);
  const place = resolvePlace();
  const base = place.denBase();
  if (base.kind !== "daytona" || !/^[a-f0-9]{40}$/.test(base.ref)) throw new Error("Pin OPENWORK_EVAL_REF to a full pushed commit SHA.");
  await assertTrustedWorkshopRef(base.ref, REPO_ROOT);
  if (options.snapshot) await assertVerifiedWorkshopSnapshot(options.snapshot, base.ref, REPO_ROOT);

  const startedAtMs = Date.now();
  const deadline = startedAtMs + options.lifetimeMinutes * 60_000;
  const remaining = () => Math.max(60, Math.min(86400, Math.floor((deadline - Date.now()) / 1000)));
  const runId = randomBytes(6).toString("hex");
  const hostEmail = `host-${runId}@workshop.test`;
  const hostPassword = workshopAccountPassword();
  const keys = Array.from({ length: options.seats }, (_, index) => seatKey(index + 1));
  const passwords = Object.fromEntries(keys.map((key) => [key, workshopAccountPassword()]));
  const privateValues = [upstreamKey, hostPassword, ...Object.values(passwords)];
  const redact = (text: string) => redactWorkshopDiagnostic(text, privateValues);
  const stages: PairStage[] = [];
  const seats: Record<string, { ready: boolean; stages: PairStage[]; readySeconds?: number; failure?: string }> = Object.fromEntries(keys.map((key) => [key, { ready: false, stages: [] }]));
  const status: Record<string, unknown> = { runId, ref: base.ref, timezone: options.timezone, snapshot: options.snapshot ?? null, seatCount: options.seats,
    startedAt: new Date(startedAtMs).toISOString(), expiresAt: new Date(deadline).toISOString(), ready: false, readySeats: 0, stages, seats };
  const statusPath = join(options.outputDir, "status.json");
  const shared: Record<string, unknown> = { runId, ref: base.ref, expiresAt: status.expiresAt };
  const outputs: Record<string, WorldOutput> = { ref: output(base.ref), status: output(statusPath), hostSheet: output(join(options.outputDir, "host-sheet.html"), { note: "Private: every attendee link" }) };
  let writing = Promise.resolve();
  const saveStatus = () => { writing = writing.then(() => privateJson(statusPath, status)).catch(() => {}); return writing; };
  async function stage<T>(list: PairStage[], label: string, name: string, run: () => Promise<T>, diagnostic?: () => Surface | undefined, shotDir = options.outputDir): Promise<T> {
    const entry: PairStage = { name, startedAt: new Date().toISOString() };
    list.push(entry); await saveStatus();
    console.log(`Workshop ${label}: ${name}…`);
    const t0 = Date.now();
    try {
      const value = await run();
      Object.assign(entry, { ok: true, endedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) });
      console.log(`Workshop ${label}: ${name} ok (${entry.seconds}s).`);
      return value;
    } catch (error) {
      Object.assign(entry, { ok: false, endedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), error: redact(error instanceof Error ? error.message : String(error)).slice(0, 4000) });
      const surface = diagnostic?.();
      if (surface) await screenshot(surface, join(shotDir, `failed-${name}.png`)).catch(() => {});
      throw error;
    } finally { await saveStatus(); }
  }

  await using stack = new AsyncDisposableStack();
  let failure: unknown;
  try {
    const { server } = await import("../evals/packages/env/src/den.ts");
    const { app } = await import("../evals/packages/env/src/desktop-app.ts");
    let den!: Den;
    await stage(stages, "den", "den", async () => {
      const oldEmail = process.env.OPENWORK_EVAL_DEMO_EMAIL, oldPassword = process.env.OPENWORK_EVAL_DEMO_PASSWORD;
      process.env.OPENWORK_EVAL_DEMO_EMAIL = hostEmail; process.env.OPENWORK_EVAL_DEMO_PASSWORD = hostPassword;
      try {
        den = stack.use(await server({ place, org: { name: `Workshop ${runId}`, admin: { email: hostEmail, password: hostPassword, name: "Workshop host" },
          members: Object.fromEntries(keys.map((key, index) => [key, { email: `${key}-${runId}@workshop.test`, name: `Attendee ${String(index + 1).padStart(2, "0")}`, password: passwords[key] }])) },
          daytonaPrivate: true, daytonaSeedDemo: false, daytonaTtlMinutes: Math.floor(remaining() / 60), daytonaAutoStopMinutes: 0, daytonaPreviewExpirySeconds: remaining(),
          env: { OPENWORK_DEV_MODE: "0", OPENWORK_WORKSHOP_PRIVATE_COHOST: "1", DEN_REQUIRE_EMAIL_VERIFICATION: "false", GATEWAY_ENABLED: "true", GATEWAY_PORT: "8791",
            GATEWAY_EGRESS_ALLOWED_ORIGINS: "https://api.openai.com", DEN_DB_ENCRYPTION_KEY: randomBytes(32).toString("hex"), BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
            GATEWAY_WEBHOOK_SECRET: randomBytes(32).toString("hex"), DEN_DEMO_OWNER_EMAIL: hostEmail, DEN_DEMO_OWNER_PASSWORD: hostPassword,
            RESEND_API_KEY: "", SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", EMAIL_FROM: "" } }));
      } finally {
        if (oldEmail === undefined) delete process.env.OPENWORK_EVAL_DEMO_EMAIL; else process.env.OPENWORK_EVAL_DEMO_EMAIL = oldEmail;
        if (oldPassword === undefined) delete process.env.OPENWORK_EVAL_DEMO_PASSWORD; else process.env.OPENWORK_EVAL_DEMO_PASSWORD = oldPassword;
      }
      privateValues.push(den.admin.token, ...Object.values(den.members).map((member) => member.token));
      if (den.placement?.kind !== "daytona") throw new Error("Den has no owned Daytona placement.");
      const backend = await verifySandbox(den.placement.sandboxId);
      await trackResource({ kind: "daytona", id: backend.id, label: "workshop-pair-den" });
      for (const path of ["/v1/dev/emails", "/v1/dev/emails/last"]) {
        const response = await fetch(`${den.ref.apiUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
        if (response.status !== 404) throw new Error("Den exposed development email routes.");
      }
      Object.assign(shared, { denSandbox: backend.id, denApiUrl: den.ref.apiUrl, denWebUrl: den.ref.webUrl });
    });
    const setup = await stage(stages, "den", "models-and-connectors", () => configureWorkshop(den, { upstreamKey, allowanceUsd: 5, attendees: options.seats }));
    Object.assign(shared, { orgId: setup.orgId, connections: setup.connections });
    // Automations need OpenWork Web access; a fictional workshop org gets the
    // complimentary grant from the Den's own bootstrap admin, not billing.
    await stage(stages, "den", "automations-access", () => grantOpenWorkWebAccess(den.admin, setup.orgId, "Hands-on workshop (fictional org)"));

    const results = await forEachSeat(options.seats, options.concurrency, async (index) => {
      const key = seatKey(index);
      const seatState = seats[key];
      const member = den.members[key];
      const seatSetup = setup.members.find((entry) => entry.key === key);
      if (!seatState || !member || !seatSetup) throw new Error(`Seat ${key} was not provisioned.`);
      const seatDir = join(options.outputDir, key);
      await privateDirectory(seatDir);
      const control: Record<string, unknown> = { ...shared, member: key, memberId: seatSetup.memberId, modelId: seatSetup.modelId,
        memberLogin: { email: member.email, password: passwords[key], token: member.token, apiUrl: member.apiUrl, webUrl: member.webUrl } };
      const controlPath = join(seatDir, "control.json");
      const save = async () => {
        await privateJson(controlPath, control);
        // A single-seat run keeps the original pair layout for existing checks.
        if (options.seats === 1) await privateJson(join(options.outputDir, "control.json"), control);
      };
      await save();
      const seatStarted = Date.now();
      let diagnostic: Surface | undefined;
      const seatStage = <T>(name: string, run: () => Promise<T>) => stage(seatState.stages, key, name, run, () => diagnostic, seatDir);
      try {
        await seatStage("member-budget", () => verifyMember(member, setup.orgId, seatSetup.memberId));
        const desktopId = await seatStage("desktop-sandbox", async () => {
          // Spread the first wave out: ten simultaneous provider calls are throttled.
          await new Promise((resolve) => setTimeout(resolve, ((index - 1) % options.concurrency) * 1_500));
          const provisioned = await retryThrottled(() => provisionDesktopSandbox({ ref: base.ref, name: `workshop-${runId}-${key}`, private: true, secrets: false,
            // The org has more than one page of snapshots: look ours up across all pages.
            ...(options.snapshot ? { snapshot: options.snapshot, exec: pagedSnapshotListExec(defaultDaytonaExec) } : {}),
            ttlMinutes: Math.floor(remaining() / 60), autoStopMinutes: 0, log: () => {},
            onCreated: async (sandbox) => {
              stack.defer(() => deleteSandboxes([sandbox], { log: () => {} }));
              await trackResource({ kind: "daytona", id: sandbox, label: `workshop-${key}` });
            } }));
          if (!provisioned.created) throw new Error("Only newly created desktop sandboxes are owned.");
          const id = await privateSandboxId(provisioned.sandbox);
          await verifySandbox(id);
          control.desktopSandbox = id; await save();
          return id;
        });
        const host = stack.use(createDaytonaHost({ sandboxId: desktopId, repoRoot: REPO_ROOT, previewExpirySeconds: remaining(), log: () => {} }));
        const browser = await seatStage("browser-and-five-oauth", async () => {
          // A clean snapshot already carries the browser launcher (no profile).
          if (!options.snapshot) await installWorkshopBrowser(desktopId);
          await unlockWorkshopDesktop(desktopId);
          await execInSandbox(defaultDaytonaExec, desktopId, workshopRemoteScript(workshopTimezoneScript(options.timezone)), { timeoutMs: 30_000, context: "set the attendee's local timezone" });
          const surface = stack.use(await chrome({ name: `workshop-${key}`, host, profileDir: WORKSHOP_BROWSER_PROFILE, headless: false, startUrl: "about:blank" }));
          diagnostic = surface;
          const oauth = await connectWorkshopBrowser(surface, member, setup.orgId, setup.connections);
          control.guest = oauth.guest; await save();
          return surface;
        });
        const desktop = await seatStage("desktop-signed-in", async () => {
          const surface = stack.use(await app({ den, place, host, as: key, enterpriseActivated: true, workspacePath: "/home/daytona/workshop/workspace",
            env: { VITE_DISABLE_OPENWORK_MODELS: "0", OPENWORK_ENGINE_V2_PREVIEW: "1", OPENWORK_AUTOMATION_RUNNER: "on", BROWSER: WORKSHOP_BROWSER_LAUNCHER, TZ: options.timezone } }));
          diagnostic = surface;
          return surface;
        });
        await seatStage("workshop-model-visible", async () => {
          // A fresh desktop opens a draft with no session id; binding needs a task.
          await runControl(desktop, "session.create_task");
          control.modelVisibleWithoutRuntimeLink = await selectWorkshopModel(desktop, seatSetup.modelId).then(() => true, () => false);
          if (!control.modelVisibleWithoutRuntimeLink) {
            await linkWorkshopRuntime(desktop, member, setup.orgId, desktop.workspaceId);
            await desktop.client.send("Page.reload", { ignoreCache: true });
            await waitUntilInteractive(desktop, { timeoutMs: 90_000 });
            await selectWorkshopModel(desktop, seatSetup.modelId);
          }
          await save();
          await foregroundWorkshopDesktop(browser, desktop);
          await freshComposer(desktop, seatSetup.modelId);
          await screenshot(desktop, join(seatDir, "ready.png"));
        });
        await seatStage("private-interactive-viewer", async () => {
          const signed = await defaultDaytonaExec(["preview-url", desktopId, "-p", "6080", "--expires", String(remaining())], { timeoutMs: 30_000 });
          if (signed.code !== 0) throw new Error("Could not mint the private viewer link.");
          const origin = parsePrivatePreview(signed.stdout, desktopId, 6080).browserOrigin;
          const viewer = `${origin}/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1&reconnect_delay=2000`;
          await verifyViewer(viewer, desktopId);
          control.viewer = viewer; await save();
          await writeFile(join(options.outputDir, `${key}.html`), attendeeCard(key, viewer, String(status.expiresAt)), { mode: 0o600 });
          outputs[key] = secret(viewer, { group: "Attendee desktops", note: "Interactive private desktop; give only to this attendee" });
        });
        seatState.ready = true;
        seatState.readySeconds = Math.round((Date.now() - seatStarted) / 1000);
        status.readySeats = Object.values(seats).filter((seat) => seat.ready).length;
        await saveStatus();
      } catch (error) {
        seatState.failure = redact(error instanceof Error ? error.message : String(error)).slice(0, 2000);
        await saveStatus();
        throw error;
      }
    });
    status.readySeats = Object.values(seats).filter((seat) => seat.ready).length;
    status.ready = results.every((result) => result.status === "fulfilled");
    status.readySeconds = Math.round((Date.now() - startedAtMs) / 1000);
    console.log(`Workshop: ${status.readySeats}/${options.seats} seats ready in ${status.readySeconds}s.`);
  } catch (error) {
    failure = error;
    status.failure = redact(error instanceof Error ? error.message : String(error)).slice(0, 4000);
    console.error(`Workshop: shared stage failed; holding for inspection. ${status.failure}`);
  }
  await saveStatus();
  await writeFile(join(options.outputDir, "host-sheet.html"), hostSheet(seats, String(status.expiresAt)), { mode: 0o600 });
  outputs.ready = output(`${String(status.readySeats)}/${options.seats}`);
  // Hold whether or not every seat passed. Teardown: pnpm world down workshop-pair --stage <stage>.
  await hold({ name: "workshop-pair", outputs });
  if (failure || status.ready !== true) process.exitCode = 1;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function attendeeCard(key: string, viewer: string, expiresAt: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${key} · OpenWork workshop</title>
<body style="font:16px/1.5 system-ui;max-width:640px;margin:40px auto;padding:0 16px">
<h1>Your OpenWork workshop desktop</h1>
<p><a href="${escapeHtml(viewer)}" rel="noreferrer" style="font-size:20px">Open my desktop</a></p>
<p>This link is yours alone: anyone with it controls your desktop. Don't forward it. It works until ${escapeHtml(new Date(expiresAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" }))} Pacific.</p>
<p>OpenWork is already signed in, and your fictional Outlook, Calendar, OneDrive, Jira and Confluence are connected. Everything here is fictional sample data.</p>
<p>If the screen looks frozen, reload this page. If something goes wrong, raise your hand.</p></body></html>`;
}
function hostSheet(seats: Record<string, { ready: boolean; failure?: string }>, expiresAt: string): string {
  const rows = Object.entries(seats).map(([key, seat]) => `<tr><td><a href="${key}.html">${key}</a></td><td>${seat.ready ? "ready" : `<b>not ready</b> ${escapeHtml(seat.failure ?? "")}`}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Private workshop host sheet</title>
<body style="font:15px/1.5 system-ui;margin:32px"><h1>Private host sheet</h1><p>Give each person only their own card. Never share this page. Expires ${escapeHtml(expiresAt)}.</p>
<table border="1" cellpadding="6" style="border-collapse:collapse">${rows}</table></body></html>`;
}

if (import.meta.main) await main();
