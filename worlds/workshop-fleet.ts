import { randomBytes } from "node:crypto";
import { assertTrustedWorkshopRef } from "./lib/workshop-trust.ts";
import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Surface } from "../evals/packages/cdp/src/index.ts";
import { control, parseSessionToolCalls, waitFor, waitUntilInteractive, evalIn } from "../evals/packages/behaviors/src/desktop.ts";
import { linkWorkshopRuntime, selectWorkshopModel } from "./lib/workshop-models.ts";
import { engineSessionProbe } from "../evals/packages/behaviors/src/engine-session-probe.ts";
import type { EngineSessionProbePart } from "../evals/packages/behaviors/src/engine-session-probe.ts";
import { readComposerState, sendComposerMessage, waitForAssistantReply } from "../evals/packages/behaviors/src/composer.ts";
import { denFetch } from "../evals/packages/behaviors/src/den.ts";
import type { DenSession } from "../evals/packages/behaviors/src/den.ts";
import type { Den, PersonShape } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import { chrome } from "../evals/packages/hosts/src/browser.ts";
import { createDaytonaHost, defaultDaytonaExec } from "../evals/packages/hosts/src/daytona.ts";
import { deleteSandboxes, provisionDesktopSandbox } from "../evals/packages/hosts/src/provision.ts";
import { parsePrivatePreview, privateSandboxId } from "../evals/packages/hosts/src/private-web-preview.ts";
import { hold } from "../packages/world/src/hold.ts";
import { trackResource } from "../packages/world/src/ledger.ts";
import { output, secret } from "../packages/world/src/outputs.ts";
import type { WorldOutput } from "../packages/world/src/outputs.ts";
import { sourceFor, sourcesFromEnv } from "../packages/world/src/source.ts";
import { targetFromEnv } from "../packages/world/src/target.ts";
import { configureWorkshop, WORKSHOP_BUDGET_CAVEAT } from "./lib/workshop-setup.ts";
import { redactWorkshopDiagnostic } from "./lib/workshop-redaction.ts";
import { unlockWorkshopDesktop } from "./lib/workshop-unlock.ts";
import { readWorkshopAudit, validateAuditedPilotRead } from "./lib/workshop-pilot-audit.ts";
import { connectWorkshopBrowser, foregroundWorkshopDesktop, installWorkshopBrowser, verifyWorkshopBrowserHandoff, WORKSHOP_BROWSER_LAUNCHER, WORKSHOP_BROWSER_PROFILE } from "./lib/workshop-browser.ts";

export const summary = "Private shared Den/Gateway and isolated workshop Linux desktops; pilot must pass before fan-out.";
export const supportedTargets = ["daytona/linux"];
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DAYTONA_ORG = "802dbb61-97d4-445a-9c80-e9255852a4e0";

export function parseWorkshopOptions(argv: readonly string[]) {
  let count: 1 | 20 = 1;
  let lifetimeMinutes = 1440;
  let outputDir = "";
  let ref: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag || !value || seen.has(flag)) throw new Error("Workshop flags require one value each, without duplicates.");
    seen.add(flag);
    if (flag === "--count" && (value === "1" || value === "20")) count = value === "1" ? 1 : 20;
    else if (flag === "--lifetime" && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 1440) lifetimeMinutes = Number(value);
    else if (flag === "--output-dir" && isAbsolute(value)) outputDir = resolve(value);
    else if (flag === "--ref" && /^[0-9a-f]{40}$/.test(value)) ref = value;
    else throw new Error("Use --count 1|20, --lifetime 1..1440, --output-dir <private absolute path outside git>, and optional --ref <full SHA>.");
  }
  if (!outputDir) throw new Error("Workshop requires --output-dir outside git (contains secret viewer links).");
  const rel = relative(REPO_ROOT, outputDir);
  if (rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("Workshop output directory must be outside this checkout.");
  return { count, lifetimeMinutes, outputDir, ref };
}

export function attendeeKey(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1 || index > 20) throw new Error("Attendee index must be 1..20.");
  return `attendee${String(index).padStart(2, "0")}`;
}

/** Conservative bound: snapshot fallback 4 CPU/8 GiB, shared backend 4/8, 24h. */
export function workshopBudget(count: 1 | 20, lifetimeMinutes: number) {
  if ((count !== 1 && count !== 20) || !Number.isSafeInteger(lifetimeMinutes) || lifetimeMinutes < 1 || lifetimeMinutes > 1440) throw new Error("Unapproved workshop size or lifetime.");
  const computeUsd = (count + 1) * 4 * 0.083 * lifetimeMinutes / 60;
  const diskReserveUsd = 12 * (count + 1) / 21 * lifetimeMinutes / 1440;
  const infrastructureUsd = computeUsd + diskReserveUsd;
  if (infrastructureUsd > 180) throw new Error("Workshop exceeds approved infrastructure ceiling including disk reserve.");
  return { computeUsd, diskReserveUsd, infrastructureUsd, modelAllowancePerMemberUsd: 5, totalEstimatedModelAllowanceUsd: 100 };
}

/** Pilot is deliberately outside the worker pool. Settle in-flight owners before teardown. */
export async function bootAttendees<T>(count: 1 | 20, boot: (index: number) => Promise<T>, concurrency = 2): Promise<T[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 5) throw new Error("Workshop worker concurrency must be 1..5.");
  const results = [await boot(1)];
  if (count === 1) return results;
  let next = 2;
  let failure: unknown;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next <= count && failure === undefined) {
      const index = next++;
      try { results[index - 1] = await boot(index); } catch (error) { failure = error; }
    }
  }));
  if (failure !== undefined) throw failure;
  return results;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function randomSecret(): string { return randomBytes(32).toString("hex"); }
/** Den account passwords have a 32-character maximum; service secrets do not. */
export function workshopAccountPassword(): string { return `Aa1!${randomBytes(20).toString("base64url")}`; }
function remainingSeconds(deadline: number): number {
  const seconds = Math.floor((deadline - Date.now()) / 1000);
  if (seconds < 60) throw new Error("Workshop lifetime exhausted before handover.");
  return Math.min(86400, seconds);
}
async function privateFile(path: string, content: string | Buffer): Promise<void> {
  // Never follow an existing output symlink or silently overwrite another run.
  await writeFile(path, content, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

export function validateSandboxInfo(info: unknown) {
  if (!record(info) || info.public !== false || info.organizationId !== DAYTONA_ORG || info.sandboxClass !== "container"
    || info.target !== "us" || typeof info.id !== "string" || !/^[0-9a-f-]{36}$/i.test(info.id)
    || typeof info.cpu !== "number" || info.cpu < 1 || info.cpu > 4
    || typeof info.memory !== "number" || info.memory < 1 || info.memory > 8
    || typeof info.disk !== "number" || info.disk < 1 || info.disk > 10) {
    throw new Error("Workshop sandbox failed privacy, organization, Linux placement, or 4 CPU/8 GiB/10 GiB disk maximum check.");
  }
  return { id: info.id, cpu: info.cpu, memoryGiB: info.memory, diskGiB: info.disk, public: false, organizationId: info.organizationId };
}
export async function verifySandbox(sandbox: string) {
  const result = await defaultDaytonaExec(["info", sandbox, "-f", "json"], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error("Could not read owned workshop sandbox information.");
  return validateSandboxInfo(JSON.parse(result.stdout));
}

async function rfb(url: string, expectOpen: boolean): Promise<void> {
  const endpoint = new URL("/websockify", url);
  endpoint.protocol = "wss:";
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(endpoint, ["binary"]);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => finish(new Error("Viewer WebSocket probe timed out.")), 15_000);
    const finish = (error?: Error) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(); };
    socket.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      finish(expectOpen && text.startsWith("RFB 003.") ? undefined : new Error("Viewer RFB authentication check failed."));
    };
    socket.onopen = () => { if (!expectOpen) finish(new Error("Unsigned viewer WebSocket unexpectedly opened.")); };
    socket.onerror = () => finish(expectOpen ? new Error("Signed viewer WebSocket failed.") : undefined);
  });
}
export async function verifyViewer(signed: string, sandboxId: string): Promise<void> {
  const origins = parsePrivatePreview(new URL(signed).origin, sandboxId, 6080);
  const get = (url: string) => fetch(url, { redirect: "error", headers: { "X-Daytona-Skip-Preview-Warning": "true" }, signal: AbortSignal.timeout(30_000) });
  const unsigned = await get(origins.unsignedOrigin);
  if (![401, 403].includes(unsigned.status)) throw new Error("Unsigned viewer HTTP access was not denied.");
  const response = await get(signed);
  if (!response.ok || !/novnc|vnc/i.test(await response.text())) throw new Error("Signed noVNC viewer unavailable.");
  await rfb(origins.unsignedOrigin, false);
  await rfb(signed, true);
}

async function memberGet(member: DenSession, orgId: string, path: string): Promise<unknown> {
  const result = await denFetch(member, path, { headers: { authorization: `Bearer ${member.token}`, "x-openwork-org-id": orgId } });
  if (!result.response.ok) throw new Error(`Workshop member verification failed: HTTP ${result.response.status}.`);
  return result.body;
}
export async function verifyMember(member: DenSession, orgId: string, memberId: string) {
  const context = await memberGet(member, orgId, "/v1/org");
  const current = record(context) ? context.currentMember : undefined;
  if (!record(current) || current.id !== memberId || current.role !== "member" || current.isOwner !== false) throw new Error("Workshop desktop is not an ordinary member.");
  const status = await memberGet(member, orgId, "/v1/gateway/usage-limits/me");
  const bucket = record(status) && Array.isArray(status.buckets) && status.buckets.length === 1 ? status.buckets[0] : undefined;
  if (!record(bucket) || bucket.baseAllowanceMicroUsd !== 5_000_000 || bucket.allowanceMicroUsd !== 5_000_000
    || bucket.extensionMicroUsd !== 0 || bucket.hardLimit !== true) throw new Error("Workshop effective member budget is not $5.");
  return bucket;
}

async function screenshot(surface: Surface, path: string) {
  const image = await surface.client.send("Page.captureScreenshot", { format: "png" });
  if (!record(image) || typeof image.data !== "string") throw new Error("Desktop screenshot was not returned.");
  await privateFile(path, Buffer.from(image.data, "base64"));
}
export async function freshComposer(surface: Surface, modelId?: string): Promise<void> {
  await control(surface, "session.create_task");
  if (modelId) await selectWorkshopModel(surface, modelId);
  await waitFor(surface, () => {
    const editor = document.querySelector<HTMLElement>('[contenteditable="true"][data-lexical-editor="true"]') ?? document.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editor || (editor.innerText ?? "").trim()) return false;
    editor.focus();
    return document.activeElement === editor && editor.getAttribute("role") === "textbox" && document.hasFocus();
  }, { timeoutMs: 45_000, label: "fresh empty focused attendee composer" });
  const composer = await readComposerState(surface);
  if (!composer.composerEditable || composer.draftText || composer.userMessageCount || composer.assistantMessageCount || composer.modelUnavailable) {
    throw new Error("Workshop handover must have a fresh, empty, usable composer.");
  }
}

export function validatePilotRead(parts: readonly EngineSessionProbePart[], finalText: string, connectionIds: readonly string[]) {
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
  for (const part of parts) {
    const workplace = connectionIds.some((id) => part.tool.includes(id)) || /(?:workshop|outlook|calendar|drive|jira|confluence)/i.test(part.tool);
    const readOnly = /read|search|list|get|find|query/i.test(part.tool) && !/create|update|delete|send|write|patch|remove/i.test(part.tool);
    if (part.type !== "tool" || !workplace || !readOnly || part.status !== "completed" || part.error || !/northwind/i.test(part.output)
      || /"isError"\s*:\s*true|"error"\s*:\s*"[^"\s]/i.test(part.output)) continue;
    const titles: string[] = [];
    const visit = (value: unknown, key: string, depth: number): void => {
      if (depth > 12) return;
      if (typeof value === "string") {
        if (/^(title|subject|name|summary)$/i.test(key) && value.trim().length >= 8) titles.push(value.trim());
        try { const nested: unknown = JSON.parse(value); if (nested !== value) visit(nested, "", depth + 1); } catch { /* Plain provider text. */ }
      } else if (Array.isArray(value)) { for (const child of value) visit(child, key, depth + 1); }
      else if (record(value)) { for (const [key, child] of Object.entries(value)) visit(child, key, depth + 1); }
    };
    try { visit(JSON.parse(part.output), "", 0); } catch { /* An unstructured claim is not proof of a successful read. */ }
    const title = titles.find((title) => normalize(finalText).includes(normalize(title)));
    if (title && /northwind/i.test(finalText) && finalText.includes("WORKSHOP_READY")) {
      return { tool: part.tool, callId: part.callId, title, completed: true };
    }
  }
  throw new Error("Pilot lacks a completed workplace MCP read and a final Northwind fact matching its actual result; no bulk launch.");
}

async function provePilot(surface: Surface, browser: Surface, workspaceId: string, member: DenSession, orgId: string, memberId: string, connectionIds: readonly string[], evidenceDir: string) {
  const before = await verifyMember(member, orgId, memberId);
  const auditBefore = await readWorkshopAudit(browser);
  const cursor = new Map<string, number>();
  for (const { service, entry } of auditBefore) cursor.set(service, Math.max(cursor.get(service) ?? 0, Number(entry.sequence) || 0));
  await sendComposerMessage(surface, "Read-only workshop readiness check. Use a directly exposed Workshop Jira or Workshop Outlook MCP tool to look up one Northwind item (at most 2 tool calls; do not modify anything; no shell or fetch workaround). Reply in under 80 words, naming Northwind and quoting the exact title or subject field from the successful tool result, followed by WORKSHOP_READY. If tools fail, explain the failure honestly without that marker; never claim a successful lookup.");
  const reply = await waitForAssistantReply(surface, { timeoutMs: 240_000 });
  await waitFor(surface, () => {
    const text = [...document.querySelectorAll<HTMLElement>('[data-message-role="assistant"]')].at(-1)?.innerText.trim() ?? "";
    const busy = [...document.querySelectorAll("button")].some((button) => /^(stop|stop task|stop generating)$/i.test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()));
    return text.includes("WORKSHOP_READY") && !busy && !document.querySelector('[data-status="pending"], [data-status="running"]') && !/^Working(?:\.{3}|…)?$/m.test(document.body.innerText);
  }, { timeoutMs: 240_000, label: "completed real Gateway-backed pilot turn" });
  if (!reply.text) throw new Error("Pilot has no generated assistant response.");
  const deadline = Date.now() + 60_000;
  let usageVerified = false;
  let settledUsage = before;
  while (Date.now() < deadline) {
    const after = await verifyMember(member, orgId, memberId);
    if (typeof after.usedMicroUsd === "number" && after.usedMicroUsd > 0
      && (typeof before.usedMicroUsd !== "number" || after.usedMicroUsd > before.usedMicroUsd)) { usageVerified = true; settledUsage = after; break; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!usageVerified) throw new Error("Pilot final text was not accompanied by positive settled Gateway spend; no bulk launch.");
  const transcript = await control(surface, "session.read_transcript", { count: 30 });
  const calls = parseSessionToolCalls(transcript);
  if (!record(transcript) || typeof transcript.sessionId !== "string" || !Array.isArray(transcript.messages)) throw new Error("Pilot transcript unavailable.");
  const finalReply = await waitForAssistantReply(surface, { timeoutMs: 5_000 });
  const messages = await engineSessionProbe({ surface, workspaceId, engine: "v2" }).messages(transcript.sessionId);
  if (!messages.ok) throw new Error("Pilot completed engine messages unavailable.");
  const parts = messages.data.flatMap((message) => message.parts);
  const audit = (await readWorkshopAudit(browser)).filter(({ service, entry }) => Number(entry.sequence) > (cursor.get(service) ?? 0));
  await privateFile(join(evidenceDir, "pilot-observation.json"), redactWorkshopDiagnostic(JSON.stringify({ parts, finalText: finalReply.text, audit, usageBefore: before, usageAfter: settledUsage }, null, 2), [member.token, member.password]));
  const completedRead = validateAuditedPilotRead(parts, finalReply.text, connectionIds, audit);
  await screenshot(surface, join(evidenceDir, "pilot-real-model.png"));
  return { realModelVerified: true, settledGatewaySpendVerified: true, usedMicroUsd: settledUsage.usedMicroUsd, completedRead, observedToolCalls: calls.length,
    observedMcpConnections: [...new Set(calls.flatMap((call) => call.connectionId ? [call.connectionId] : []))] };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseWorkshopOptions(argv);
  const target = targetFromEnv();
  if (target.provider !== "daytona" || target.os !== "linux") throw new Error("Workshop fleet supports only --place daytona --os linux.");
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Workshop controller requires Node 24 or newer.");
  for (const key of ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DAYTONA_DEN_SANDBOX", "OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX", "OPENWORK_EVAL_DAYTONA_SANDBOX", "OPENWORK_EVAL_DAYTONA_SECRETS"]) {
    if (process.env[key]?.trim()) throw new Error("Workshop refuses reused infrastructure and shared secret-volume overrides.");
  }
  const sources = sourcesFromEnv();
  if (Object.keys(sources).some((key) => key !== "*" && key !== "den" && key !== "desktop")) throw new Error("Workshop source components are den and desktop only.");
  const declared = [sourceFor(sources, "den"), sourceFor(sources, "desktop")].filter((value) => value !== undefined);
  const refs = new Set([options.ref, process.env.OPENWORK_EVAL_REF, ...declared.map((source) => {
    if (source.kind !== "sha") throw new Error("Remote workshop requires an exact pushed SHA, never a release/local source.");
    return source.sha;
  })].filter((value) => value !== undefined));
  if (refs.size > 1) throw new Error("Workshop Den and desktop source refs must agree.");
  const explicit = [...refs][0];
  if (explicit) process.env.OPENWORK_EVAL_REF = explicit;
  const place = resolvePlace();
  const base = place.denBase();
  if (base.kind !== "daytona" || !/^[a-f0-9]{40}$/.test(base.ref)) throw new Error("Pin OPENWORK_EVAL_REF (or --ref) to the reviewed full pushed commit SHA.");
  await assertTrustedWorkshopRef(base.ref, REPO_ROOT);
  const upstreamKey = process.env.OPENAI_API_KEY;
  if (!upstreamKey?.trim()) throw new Error("Fetch OPENAI_API_KEY once into the controller before starting.");
  const budget = workshopBudget(options.count, options.lifetimeMinutes);
  await mkdir(options.outputDir, { mode: 0o700, recursive: true });
  const directory = await lstat(options.outputDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 || directory.uid !== process.getuid?.()) {
    throw new Error("Output directory must be caller-owned, mode 0700, and not a symlink.");
  }
  const canonicalOutput = await realpath(options.outputDir);
  const canonicalRepo = await realpath(REPO_ROOT);
  const outputRelative = relative(canonicalRepo, canonicalOutput);
  if (outputRelative !== ".." && !outputRelative.startsWith(`..${sep}`)) throw new Error("Output directory resolves inside the checkout.");
  for (let directory = canonicalOutput; directory !== dirname(directory); directory = dirname(directory)) {
    if (await lstat(join(directory, ".git")).then(() => true, (error: unknown) => {
      if (record(error) && error.code === "ENOENT") return false;
      throw error;
    })) throw new Error("Workshop output directory must not be inside any Git worktree.");
  }
  const deadline = Date.now() + options.lifetimeMinutes * 60_000;
  // Refuse a weekly allowance reset during the event: $100 is an event estimate,
  // not $100 per calendar week. Den's settled-spend admission caveat still applies.
  const reset = new Date(deadline);
  const now = new Date();
  for (let day = new Date(now); day.getTime() <= deadline; day = new Date(day.getTime() + 86400_000)) {
    reset.setTime(day.getTime()); reset.setUTCHours(5, 0, 0, 0);
    if (reset.getUTCDay() === 1 && reset.getTime() > Date.now() && reset.getTime() <= deadline) throw new Error("Workshop lifetime crosses the Monday 05:00 UTC allowance reset.");
  }
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  const check = () => { if (stopping) throw new Error("Workshop shutdown requested."); remainingSeconds(deadline); };
  const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), Math.max(1, deadline - Date.now()));
  const runId = randomBytes(6).toString("hex");
  const hostEmail = `host-${runId}@workshop.test`;
  const hostPassword = workshopAccountPassword();
  const members: Record<string, PersonShape> = Object.fromEntries(Array.from({ length: 20 }, (_, index) => {
    const key = attendeeKey(index + 1);
    return [key, { email: `${key}-${runId}@workshop.test`, name: `Attendee ${String(index + 1).padStart(2, "0")}`, password: workshopAccountPassword() }];
  }));
  // Primitive progress details can contain signed CDP/backend identities. Keep
  // them out of the world CLI's public event stream; this recipe emits seat-only
  // progress and publishes viewer capabilities exclusively as secret outputs.
  const eventPath = process.env.OPENWORK_WORLD_EVENTS;
  delete process.env.OPENWORK_WORLD_EVENTS;
  const primitives = await (async () => {
    try {
      return await Promise.all([import("../evals/packages/env/src/den.ts"), import("../evals/packages/env/src/desktop-app.ts")]);
    } catch {
      clearTimeout(timer); process.off("SIGTERM", stop); process.off("SIGINT", stop);
      throw new Error("Could not load workshop controller primitives.");
    } finally {
      if (eventPath !== undefined) process.env.OPENWORK_WORLD_EVENTS = eventPath;
    }
  })();
  const [{ server }, { app }] = primitives;
  const privateValues = [upstreamKey, hostPassword, ...Object.values(members).flatMap((person) => person.password ? [person.password] : [])];
  const redact = (text: string) => redactWorkshopDiagnostic(text, privateValues);
  const originals = { log: console.log, error: console.error, warn: console.warn };
  const safeArgs = (args: unknown[]) => args.map((value) => redact(value instanceof Error ? value.message : String(value)));
  console.log = (...args: unknown[]) => originals.log(...safeArgs(args));
  console.error = (...args: unknown[]) => originals.error(...safeArgs(args));
  console.warn = (...args: unknown[]) => originals.warn(...safeArgs(args));
  let phase = "shared Den boot";
  let fullyReady = false;
  try {
    await using stack = new AsyncDisposableStack();
    let den: Den;
    const oldEmail = process.env.OPENWORK_EVAL_DEMO_EMAIL;
    const oldPassword = process.env.OPENWORK_EVAL_DEMO_PASSWORD;
    process.env.OPENWORK_EVAL_DEMO_EMAIL = hostEmail; process.env.OPENWORK_EVAL_DEMO_PASSWORD = hostPassword;
    try {
      den = stack.use(await server({ place, org: { name: `Workshop ${runId}`, admin: { email: hostEmail, password: hostPassword, name: "Workshop host" }, members },
        daytonaPrivate: true, daytonaSeedDemo: false, daytonaTtlMinutes: Math.floor(remainingSeconds(deadline) / 60),
        daytonaAutoStopMinutes: 0, daytonaPreviewExpirySeconds: remainingSeconds(deadline),
        env: { OPENWORK_DEV_MODE: "0", OPENWORK_WORKSHOP_PRIVATE_COHOST: "1", DEN_REQUIRE_EMAIL_VERIFICATION: "false", GATEWAY_ENABLED: "true", GATEWAY_PORT: "8791", GATEWAY_EGRESS_ALLOWED_ORIGINS: "https://api.openai.com",
          DEN_DB_ENCRYPTION_KEY: randomSecret(), BETTER_AUTH_SECRET: randomSecret(), GATEWAY_WEBHOOK_SECRET: randomSecret(),
          DEN_DEMO_OWNER_EMAIL: hostEmail, DEN_DEMO_OWNER_PASSWORD: hostPassword, RESEND_API_KEY: "", SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", EMAIL_FROM: "" },
      }));
    } finally {
      if (oldEmail === undefined) delete process.env.OPENWORK_EVAL_DEMO_EMAIL; else process.env.OPENWORK_EVAL_DEMO_EMAIL = oldEmail;
      if (oldPassword === undefined) delete process.env.OPENWORK_EVAL_DEMO_PASSWORD; else process.env.OPENWORK_EVAL_DEMO_PASSWORD = oldPassword;
    }
    privateValues.push(den.admin.token, ...Object.values(den.members).map((member) => member.token));
    stack.defer(async () => {
      if (fullyReady) return;
      const log = await den.apiLog().catch(() => "Den diagnostic log unavailable.");
      await privateFile(join(options.outputDir, "failure-log.txt"), redact(`Workshop failed during: ${phase}\n${log.slice(-250_000)}\n`)).catch(() => {});
    });
    check();
    if (den.placement?.kind !== "daytona") throw new Error("Workshop backend has no owned Daytona placement.");
    phase = "shared backend verification";
    const backend = await verifySandbox(den.placement.sandboxId);
    await trackResource({ kind: "daytona", id: backend.id, label: "workshop-shared-backend" });
    phase = "configureWorkshop provider, budgets and connections";
    // Shared attendee access must never expose the eval OTP/reset-email outbox.
    for (const path of ["/v1/dev/emails", "/v1/dev/emails/last"]) {
      const response = await fetch(`${den.ref.apiUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
      if (response.status !== 404) throw new Error("Workshop backend exposed development email routes; no inference credential installed.");
    }
    const setup = await configureWorkshop(den, { upstreamKey, allowanceUsd: 5 });
    stack.defer(async () => {
      if (fullyReady) return;
      const usage = await Promise.all(Object.entries(den.members).map(async ([attendee, member]) => {
        try {
          const status = await memberGet(member, setup.orgId, "/v1/gateway/usage-limits/me");
          const bucket = record(status) && Array.isArray(status.buckets) ? status.buckets.find(record) : undefined;
          return { attendee, usedMicroUsd: record(bucket) ? bucket.usedMicroUsd : null, allowanceMicroUsd: record(bucket) ? bucket.allowanceMicroUsd : null };
        } catch { return { attendee, usedMicroUsd: null, allowanceMicroUsd: null }; }
      }));
      await privateFile(join(options.outputDir, "usage-at-failure.json"), `${JSON.stringify({ at: new Date().toISOString(), usage }, null, 2)}\n`).catch(() => {});
    });
    // The raw upstream key never enters any VM environment or output manifest.
    const guests = new Set<string>();
    const outputs: Record<string, WorldOutput> = {
      ref: output(base.ref), expires: output(new Date(deadline).toISOString()), count: output(String(options.count)),
      modelAllowance: output("$5 estimated / member; $100 total"), budgetCaveat: output(WORKSHOP_BUDGET_CAVEAT),
      handovers: output(options.outputDir, { note: "Private files; each attendee receives only their own HTML card" }),
    };
    const seats = await bootAttendees(options.count, async (index) => {
      check();
      const key = attendeeKey(index);
      const seatStartedAt = new Date().toISOString();
      console.log(`Workshop: preparing ${key}${index === 1 ? " (pilot gate)" : ""}.`);
      let diagnosticSurface: Surface | undefined;
      let seatPhase = `${key} sandbox provisioning`;
      try {
      phase = seatPhase;
      const provisioned = await provisionDesktopSandbox({ ref: base.ref, name: `workshop-${runId}-${key}`, private: true, secrets: false,
        ttlMinutes: Math.floor(remainingSeconds(deadline) / 60), autoStopMinutes: 0,
        log: () => {}, onCreated: async (sandbox) => {
          stack.defer(() => deleteSandboxes([sandbox], { log: () => {} }));
          await trackResource({ kind: "daytona", id: sandbox, label: `workshop-${key}` });
        },
      });
      check();
      if (!provisioned.created) throw new Error("Workshop only owns newly created desktop resources.");
      const id = await privateSandboxId(provisioned.sandbox);
      const resources = await verifySandbox(id);
      const host = stack.use(createDaytonaHost({ sandboxId: id, repoRoot: REPO_ROOT, previewExpirySeconds: remainingSeconds(deadline), log: () => {} }));
      await installWorkshopBrowser(id);
      await unlockWorkshopDesktop(id);
      const browser = stack.use(await chrome({ name: `workshop-${key}`, host, profileDir: WORKSHOP_BROWSER_PROFILE, headless: false, startUrl: "about:blank" }));
      diagnosticSurface = browser;
      seatPhase = `${key} five per-member OAuth approvals`; phase = seatPhase;
      const member = den.members[key];
      const model = setup.members.find((member) => member.key === key);
      if (!member || !model) throw new Error("Missing approved workshop member.");
      const oauth = await connectWorkshopBrowser(browser, member, setup.orgId, setup.connections);
      console.log(`Workshop: ${key} five OAuth grants and guest identity verified.`);
      if (guests.has(oauth.guest)) throw new Error("Attendee browser Guest identity was reused across VMs.");
      guests.add(oauth.guest);
      await verifyWorkshopBrowserHandoff(id, browser, oauth.guest);
      check();
      seatPhase = `${key} desktop boot and member sign-in`; phase = seatPhase;
      const desktop = stack.use(await app({ den, place, host, as: key, enterpriseActivated: true,
        workspacePath: "/home/daytona/workshop/workspace", env: { VITE_DISABLE_OPENWORK_MODELS: "0", OPENWORK_ENGINE_V2_PREVIEW: "1", OPENWORK_AUTOMATION_RUNNER: "on", BROWSER: WORKSHOP_BROWSER_LAUNCHER } }));
      diagnosticSurface = desktop;
      await linkWorkshopRuntime(desktop, member, setup.orgId, desktop.workspaceId);
      // Sign-in booted this renderer before the owned server's member broker
      // was linked. A normal renderer reload re-reads the now-ready catalog;
      // the persisted member sign-in, workspace and browser OAuth remain intact.
      await desktop.client.send("Page.reload", { ignoreCache: true });
      await waitUntilInteractive(desktop, { timeoutMs: 90_000 });
      console.log(`Workshop: ${key} desktop booted and broker linked as its ordinary member.`);
      seatPhase = `${key} real model picker and pilot proof`; phase = seatPhase;
      await foregroundWorkshopDesktop(browser, desktop);
      await freshComposer(desktop);
      await selectWorkshopModel(desktop, model.modelId);
      console.log(`Workshop: ${key} managed model selected${index === 1 ? "; real pilot running" : ""}.`);
      const pilot = index === 1 ? await provePilot(desktop, browser, desktop.workspaceId, member, setup.orgId, model.memberId, setup.connections.map((connection) => connection.id), options.outputDir) : undefined;
      await verifyMember(member, setup.orgId, model.memberId);
      await foregroundWorkshopDesktop(browser, desktop);
      await freshComposer(desktop, model.modelId);
      await screenshot(desktop, join(options.outputDir, `${key}-ready.png`));
      // Mint last, bounded by the shared wall-clock deadline, not 24h after boot.
      seatPhase = `${key} signed viewer HTTP/WebSocket protection`; phase = seatPhase;
      const previewSeconds = remainingSeconds(deadline);
      const mintedAt = Date.now();
      const signed = await defaultDaytonaExec(["preview-url", id, "-p", "6080", "--expires", String(previewSeconds)], { timeoutMs: 30_000 });
      if (signed.code !== 0) throw new Error("Could not mint private attendee viewer.");
      const origin = parsePrivatePreview(signed.stdout, id, 6080).browserOrigin;
      const viewer = `${origin}/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1&reconnect_delay=2000`;
      await verifyViewer(viewer, id);
      check();
      outputs[key] = secret(viewer, { group: "Attendee desktops", note: "Secret viewer capability; share only with this attendee" });
      const seat = { attendee: key, viewer, startedAt: seatStartedAt, readyAt: new Date().toISOString(), expiresAt: new Date(Math.min(deadline, mintedAt + previewSeconds * 1000)).toISOString(),
        sandbox: resources, ordinaryMember: true, allowanceUsd: 5, connectedApps: oauth.connected, guest: oauth.guest,
        freshFocusedComposer: true, ...(pilot ? { pilot } : {}) };
      await privateFile(join(options.outputDir, `${key}.control.json`), `${JSON.stringify(seat, null, 2)}\n`);
      await privateFile(join(options.outputDir, `${key}.html`), attendeeCard(seat));
      console.log(`Workshop: ${key} verified (viewer withheld).`);
      return seat;
      } catch (error) {
        phase = seatPhase;
        if (diagnosticSurface) {
          await screenshot(diagnosticSurface, join(options.outputDir, `${key}-failure.png`)).catch(() => {});
          const surface = diagnosticSurface;
          await (async () => {
            const workspaceId = await evalIn(surface, () => window.__openwork?.slice("route").selectedWorkspaceId ?? "", { timeoutMs: 5000 });
            const catalog = typeof workspaceId === "string" && workspaceId ? await control(surface, "models.list", { workspaceId }, { timeoutMs: 5000 }) : null;
            const models = record(catalog) && Array.isArray(catalog.models) ? catalog.models.filter(record).map((model) => ({ providerId: model.providerId, modelId: model.modelId, displayName: model.displayName, available: model.available })) : [];
            const ui = await evalIn(surface, () => [...document.querySelectorAll<HTMLElement>("[data-model-key]")].map((row) => ({ key: row.dataset.modelKey, label: row.innerText, disabled: row.getAttribute("aria-disabled") })), { timeoutMs: 5000 });
            await privateFile(join(options.outputDir, `${key}-catalog-failure.json`), redact(JSON.stringify({ models, ui }, null, 2)));
          })().catch(() => {});
        }
        await privateFile(join(options.outputDir, `${key}-failure.txt`), redact(`${seatPhase}\n${error instanceof Error ? error.message : String(error)}\n`)).catch(() => {});
        throw error;
      }
    }, 5);
    check();
    phase = "private host sheet and handover";
    await privateFile(join(options.outputDir, "host-sheet.json"), `${JSON.stringify({ ref: base.ref, backend, expiresAt: new Date(deadline).toISOString(), budget, budgetCaveat: WORKSHOP_BUDGET_CAVEAT, seats }, null, 2)}\n`);
    await privateFile(join(options.outputDir, "host-sheet.html"), `<!doctype html><meta charset="utf-8"><title>Private workshop host sheet</title><h1>Private workshop host sheet</h1><p>Give each person only their own card. Never share this sheet.</p><ul>${seats.map((seat) => `<li><a href="${seat.attendee}.html">${seat.attendee}</a> · expires ${seat.expiresAt}</li>`).join("")}</ul>`);
    fullyReady = true;
    const stopWatcher = setInterval(() => { if (stopping) process.kill(process.pid, "SIGTERM"); }, 250);
    try {
      // The standard private receipt location keeps world outputs/down/adoption working.
    await hold({ name: "workshop-fleet", outputs });
    } finally { clearInterval(stopWatcher); }
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : String(error)));
  } finally {
    console.log = originals.log; console.error = originals.error; console.warn = originals.warn;
    clearTimeout(timer); process.off("SIGTERM", stop); process.off("SIGINT", stop);
  }
}

function attendeeCard(seat: { attendee: string; viewer: string; expiresAt: string }): string {
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${seat.attendee} workshop</title><h1>${seat.attendee}</h1><p><a href="${escape(seat.viewer)}" rel="noreferrer">Open your private desktop</a></p><p>Secret link: do not forward. Expires ${escape(seat.expiresAt)}.</p><p>Your desktop is signed in. Outlook, Calendar, Drive, Jira and Confluence use your own guest workspace. Start in the empty composer.</p><h2>Try a read-only task</h2><ul><li>Find the latest Northwind update and summarize the next steps.</li><li>Compare Northwind's Jira issues with its project notes.</li><li>Prepare a short agenda from the connected calendar and Outlook messages.</li></ul><p>Estimated model allowance: $5. This is not a prepaid balance or guaranteed upstream billing cap. Admission checks settled spend; in-flight requests can overshoot. Do not enter personal credentials.</p></html>`;
}

if (import.meta.main) await main();
