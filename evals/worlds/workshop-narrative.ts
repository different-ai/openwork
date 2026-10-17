import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { seedSemanticHash } from "./workshop-narrative-contract.ts";
import type { NativeWorkflowObservation } from "./workshop-narrative-witnesses.ts";
import { addInitScript, allocateFreePort, browserScript, evaluateOnSurface, navigate, type Surface } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import type { Place, Seed } from "@openwork/env";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { denForAppWeb } from "./signed-in-app-web.ts";
import { connectDemoServer, startDemoScript } from "../../worlds/lib/demo-workspace.ts";
import { assertAcmeConnections, assertAcmeMcpOrigins, connectAcmeRuntime } from "../../worlds/lib/acme-runtime.ts";
import { startNarrativeInference } from "./workshop-narrative-inference.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const FIXED_NOW = "2026-10-16T15:55:00Z";
const run = promisify(execFile);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export interface NarrativeRow { id: string; title: string; status: "PASS" | "FAIL" | "BLOCKED"; reason: string; latencyMs: number; sessionId?: string; evidence?: Record<string, unknown> }

/** Paid inference is opt-in; all workplace services and identities are owned synthetic fixtures. */
export async function workshopNarrative(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new Error("Workshop comparison must run on this Mac with --local.");
  for (const key of ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DAYTONA_DEN_SANDBOX", "OPENWORK_EVAL_DAYTONA_SANDBOX"]) if (process.env[key]) throw new Error("Workshop proof refuses shared/reused Den infrastructure.");
  const profile = process.env.OPENWORK_WORKSHOP_PROFILE ?? "gpt-sol-fast";
  if (!["gpt-sol-fast", "qwen-27b"].includes(profile)) throw new Error("Unknown workshop model profile.");
  if (profile === "qwen-27b" && process.env.OPENWORK_WORKSHOP_GPT_PHASE_DONE !== "1") throw new Error("Run the GPT Sol Fast phase before Qwen.");
  const resources = new AsyncDisposableStack();
  const rows: NarrativeRow[] = [];
  const reportDir = process.env.OPENWORK_WORKSHOP_REPORT_DIR ?? join(REPO, "evals/results/workshop-narrative", profile);
  await mkdir(reportDir, { recursive: true });
  const startedAt = Date.now();
  let setupStage = "exact inference preflight";
  let subjectMetadata: Record<string, unknown> = { profile };
  const redactions: string[] = [];
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwork-narrative-")));
  resources.defer(() => rm(root, { recursive: true, force: true }));
  const blocked = async (reason: string, model: Record<string, unknown> = {}) => ({
    profile, ready: false as const, blockedReason: reason, model, app: null, recipientApp: null,
    reportDir, rows, fixedNow: FIXED_NOW,
    recordRow: (row: NarrativeRow) => rows.push(row),
    async finish() { await writeFile(join(reportDir, "matrix.json"), JSON.stringify({ verdict: "INCOMPLETE", profile, model, fixedNow: FIXED_NOW, durationMs: Date.now() - startedAt, rows }, null, 2) + "\n"); },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  });
  try {
    const inference = await startNarrativeInference(profile, resources);
    subjectMetadata = inference.metadata;
    if (!inference.ready) return blocked(inference.reason, inference.metadata);
    redactions.push(inference.provider.options.apiKey);
    setupStage = "owned native Den";
    const clearEnv = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
    const ownedEnv = { ...clearEnv, PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), NODE_OPTIONS: "", RESEND_API_KEY: "", SMTP_HOST: "", DEN_AUTOMATIONS_ENABLED: "true", DEN_AUTOMATIONS_RUNTIME_ENABLED: "true", DEN_BOOTSTRAP_ADMIN_EMAILS: "" };
    const recipientPort = await allocateFreePort();
    const { den, webPort } = await denForAppWeb(seed, { web: true, trustedOrigins: [`http://127.0.0.1:${recipientPort}`], env: ownedEnv, org: { name: "Acme Robotics", admin: { name: "Alex Chen", email: "alex@acme.test" }, members: { teammate: { name: "Nora Patel", email: "nora@acme.test" }, outsider: { name: "Zoe Kim", email: "zoe@acme.test" } } } });
    redactions.push(den.admin.token, den.admin.password, den.members.teammate!.token, den.members.teammate!.password);
    setupStage = "owned synthetic services";
    const uiPort = await allocateFreePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    const atlassian = await startDemoScript(resources, den, { url: new URL("../packages/labs/src/demo-atlassian.mjs", import.meta.url), label: "narrative-atlassian", daytonaPort: 3989 }, { DEMO_NOW: FIXED_NOW, DEMO_JIRA_URL: `${uiOrigin}/jira`, DEMO_CONFLUENCE_URL: `${uiOrigin}/confluence` });
    const microsoft = await startDemoScript(resources, den, { url: new URL("../packages/labs/src/demo-microsoft365.mjs", import.meta.url), label: "narrative-microsoft365", daytonaPort: 3988 }, { DEMO_NOW: FIXED_NOW });
    const operatorKey = randomUUID(); redactions.push(operatorKey);
    const news = await startDemoScript(resources, den, { url: new URL("../packages/labs/src/demo-workshop-news.mjs", import.meta.url), label: "narrative-news", daytonaPort: 3986 }, { DEMO_NOW: FIXED_NOW, WORKSHOP_OPERATOR_TOKEN: operatorKey });
    const ui = await startDemoScript(resources, den, { url: new URL("../packages/labs/src/demo-workplace-ui.mjs", import.meta.url), label: "narrative-workplace-ui", daytonaPort: 3987, localPort: uiPort }, { ATLASSIAN_BASE_URL: atlassian.baseUrl });
    await connectDemoServer(den, "atlassian", "Atlassian (Jira & Confluence)", `${atlassian.baseUrl}/mcp`);
    await connectDemoServer(den, "microsoft365", "Microsoft 365 (Outlook & OneDrive demo)", `${microsoft.baseUrl}/mcp`);
    await connectDemoServer(den, "news", "Fictional morning news", `${news.baseUrl}/mcp`);
    const ownedOrigins = [atlassian.baseUrl, microsoft.baseUrl, news.baseUrl];
    await assertAcmeConnections(den, ownedOrigins);
    const org = await seed.api(den.admin, "/v1/org");
    const orgId = record(org.body) && record(org.body.organization) ? org.body.organization.id : undefined;
    if (typeof orgId !== "string") throw new Error("Owned workshop organization missing.");
    const brief = `# Acme Robotics workshop\n\nThis is a fictional workplace. Today is 2026-10-16, 08:55 America/Los_Angeles. Use only connected owned tools and files in this workspace. No external business connectors or mail sends. News links are fictional fixtures, not the public web.\n\nProducts: Atlas 2 and Atlas Lift; full datasheets in Confluence PROD. Customer account plans in SALES document revenue, orders, relationship, growth and churn. Jira DOC belongs to documentation; Nora Patel is the documentation owner. ITSD is the IT service desk and password-reset requests require an application field. Use Windows as the requested application.\n\nDiscover exact service capabilities and schemas. Capability search finds tools, not documents. Confluence search is excerpt-only: read complete pages. Never return literal data from a script as if it came from a provider. Outlook uses mail_search/mail_read/mail_create_reply_draft; OneDrive uses file_find/file_read/file_write/file_create_folder. Calendar supports actual event reads/create/update; do not claim full Outlook parity. Native Workflows require real retained successful executions, saving and sharing, not a local text description.\n\nAsk before external searches when an internal policy is absent. Do not invent policy. Office artifacts must contain actual valid OOXML and be grounded in the report, not copied unrelated seed slides.\n`;
    const appFor = async (identity: "admin" | "teammate", port?: number) => {
      const workspacePath = join(root, identity, "workspace");
      await mkdir(workspacePath, { recursive: true });
      await writeFile(join(workspacePath, "WORKSHOP.md"), brief);
      await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({ provider: { [inference.providerId]: inference.provider }, model: `${inference.providerId}/${inference.modelId}`, small_model: `${inference.providerId}/${inference.modelId}`, enabled_providers: [inference.providerId], permission: { skill: "allow", webfetch: "ask", websearch: "ask" } }));
      const app = await seed.appWeb({ name: `workshop-${profile}-${identity}`, engine: "v1", workspacePath, mouse: true, den: den.ref, ...(port ? { webPort: port } : {}), env: { VITE_OPENWORK_FEEDBACK_URL: `${news.baseUrl}/feedback-unavailable`, VITE_DISABLE_OPENWORK_MODELS: "1" } });
      resources.adopt(app, (owned) => owned.stop());
      // Seed-only profile bootstrap; task actions below use the real composer and product controls.
      await using init = await addInitScript(app.client, browserScript((model, variant) => {
        localStorage.setItem("openwork.defaultModel", `${model.providerID}/${model.modelID}`);
        localStorage.setItem("openwork.preferences", JSON.stringify({ defaultModel: model, modelVariant: variant, providerStepCompleted: true }));
      }, [{ providerID: inference.providerId, modelID: inference.modelId }, inference.variant]));
      await navigate(app.client, app.webUrl);
      await seed.signIn(app, identity === "admin" ? den.admin : den.members.teammate!, identity);
      const workspace = await seed.workspace(app, workspacePath);
      const paths = resolveHeadlessWorldRuntimePaths(REPO, app.handle.name);
      const manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
      if (!manifest) throw new Error("Owned native app runtime manifest missing.");
      redactions.push(manifest.token, manifest.hostToken);
      await connectAcmeRuntime(den, { manifest }, orgId, identity === "admin" ? den.admin : den.members.teammate!);
      return { app, workspace, manifest, workspacePath };
    }
    setupStage = "native owner app-web sign-in";
    const owner = await appFor("admin", webPort);
    setupStage = "native recipient app-web sign-in";
    const recipient = await appFor("teammate", recipientPort);
    setupStage = "native browser surfaces and isolation assertions";
    const serviceBrowser = resources.use(await chrome({ host: place.host(), name: `workshop-${profile}-service`, startUrl: `${ui.baseUrl}/jira`, headless: true }));
    const ownerWeb = await seed.web({ den, signedInAs: "admin", startPath: "/dashboard/library", headless: true, viewport: { width: 1440, height: 1000 } });
    const recipientWeb = await seed.web({ den, signedInAs: "teammate", startPath: "/dashboard/library", headless: true, viewport: { width: 1440, height: 1000 } });
    const stateJson = async (url: string) => { const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error(`Owned service read failed: ${response.status}`); return response.json(); };
    const engineRead = async (identity: "owner" | "recipient", path: string) => {
      const target = identity === "owner" ? owner : recipient;
      const response = await fetch(`${target.app.openworkUrl}/workspace/${target.workspace.workspaceId}/opencode${path}`, { headers: { authorization: `Bearer ${target.manifest.token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Owned engine read failed: ${response.status}`);
      return response.json();
    };
    const assertIsolation = async () => {
      await assertAcmeConnections(den, ownedOrigins);
      for (const identity of ["owner", "recipient"] as const) assertAcmeMcpOrigins(await engineRead(identity, "/config"), den.ref.apiUrl);
    };
    await assertIsolation();
    const initial = { atlassian: await stateJson(`${atlassian.baseUrl}/state`), microsoft: await stateJson(`${microsoft.baseUrl}/state`), news: await stateJson(`${news.baseUrl}/state`) };
    // Full initial service state: only exact owned origins and documented transport/auth fields normalize.
    const seedDigest = seedSemanticHash(initial, [...ownedOrigins, ui.baseUrl]);
    const readDen = (actor: DenSession, path: string) => denFetch(actor, path, { headers: { authorization: `Bearer ${actor.token}` } });
    const recipientOrg = await readDen(den.members.teammate!, "/v1/org");
    const ownerMemberId = record(org.body) && record(org.body.currentMember) ? String(org.body.currentMember.id) : "";
    const recipientMemberId = record(recipientOrg.body) && record(recipientOrg.body.currentMember) ? String(recipientOrg.body.currentMember.id) : "";
    async function nativeWorkflows(): Promise<NativeWorkflowObservation> {
      const list = await readDen(den.admin, "/v1/workflows");
      const items = record(list.body) && Array.isArray(list.body.items) ? list.body.items.filter(record) : [];
      const workflow = items.find((item) => item.title === "Acme product comparison");
      let details: unknown = null, grants: unknown = null, snapshots: unknown = null;
      if (typeof workflow?.configObjectId === "string") {
        const id = encodeURIComponent(workflow.configObjectId);
        details = (await readDen(den.admin, `/v1/workflows/${id}`)).body;
        grants = (await readDen(den.admin, `/v1/config-objects/${id}/access`)).body;
        snapshots = { owner: (await readDen(den.admin, `/v1/workflows/${id}/snapshots`)).body, recipient: (await readDen(den.members.teammate!, `/v1/workflows/${id}/snapshots`)).body };
      }
      let runs: Record<string, unknown>[] = [];
      if (den.database) {
        // Fixed read-only query against ONLY the disposable world's database; encrypted source/results are excluded.
        const observed = await run(process.execPath, ["--input-type=module", "-e", "import mysql from 'mysql2/promise';const c=await mysql.createConnection(process.env.WORKSHOP_OWNED_DB);try{const [r]=await c.query('SELECT id,org_membership_id,config_object_id,config_object_version_id,code_digest,status,source,script_input_digest,started_at,finished_at FROM workflow_run ORDER BY started_at');console.log(JSON.stringify(r))}finally{await c.end()}"], { cwd: join(REPO, "ee/packages/den-db"), env: { PATH: process.env.PATH, HOME: root, WORKSHOP_OWNED_DB: den.database.url }, timeout: 15000 });
        const parsed: unknown = JSON.parse(observed.stdout); if (Array.isArray(parsed)) runs = parsed.filter(record);
      }
      return { list: list.body, details, grants, snapshots, runs, ownerMemberId, recipientMemberId };
    }
    const latestSession = async (identity: "owner" | "recipient") => {
      const target = identity === "owner" ? owner : recipient;
      const route = await evaluateOnSurface(target.app, () => location.pathname);
      return /\/session\/([^/]+)/.exec(route)?.[1] ?? null;
    };
    return {
      profile, ready: true as const, blockedReason: null, model: inference.metadata, expectedModel: { providerID: inference.providerId, modelID: inference.modelId, variant: inference.variant }, app: owner.app, recipientApp: recipient.app, ownerWeb, recipientWeb, serviceBrowser,
      nativeWorkflows,
      urls: { denWeb: den.ref.webUrl, jira: `${ui.baseUrl}/jira`, confluence: `${ui.baseUrl}/confluence`, outlook: `${microsoft.baseUrl}/outlook`, oneDrive: `${microsoft.baseUrl}/onedrive`, news: `${news.baseUrl}/state` },
      reportDir, rows, fixedNow: FIXED_NOW, seedDigest,
      async current(identity: "owner" | "recipient" = "owner") { const sessionId = await latestSession(identity); const messages = sessionId ? await engineRead(identity, `/session/${sessionId}/message`) : []; return { sessionId, messages }; },
      async observe(identity: "owner" | "recipient" = "owner") {
        const current = await this.current(identity);
        const actor = identity === "owner" ? den.admin : den.members.teammate!;
        const workflows = await readDen(actor, "/v1/workflows");
        return { ...current, atlassian: await stateJson(`${atlassian.baseUrl}/state`), microsoft: await stateJson(`${microsoft.baseUrl}/state`), news: await stateJson(`${news.baseUrl}/state`), workflows: workflows.body, inference: inference.observations(), identity, actorEmail: actor.email };
      },
      assertIsolation,
      async outsiderWorkflows() { return (await readDen(den.members.outsider!, "/v1/workflows")).body; },
      async workflowDetail(id: string, identity: "owner" | "recipient" = "owner") { return (await readDen(identity === "owner" ? den.admin : den.members.teammate!, `/v1/workflows/${encodeURIComponent(id)}`)).body; },
      async assertScreenshotSafe(surface: Surface) {
        const secrets = [operatorKey, owner.manifest.token, owner.manifest.hostToken, recipient.manifest.token, recipient.manifest.hostToken, den.admin.token, den.admin.password, den.members.teammate!.token, den.members.teammate!.password, inference.provider.options.apiKey];
        const safe = await evaluateOnSurface(surface, browserScript((values) => { const visible = [document.body?.innerText ?? "", location.href, ...Array.from(document.querySelectorAll("input,textarea")).map((element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : "")].join("\n"); return !values.some((value) => value && visible.includes(value)); }, [secrets]));
        if (!safe) throw new Error("Screenshot blocked: an owned credential is visibly present.");
      },
      async inspectPptx(name: string, sessionId: string) {
        const state = await stateJson(`${microsoft.baseUrl}/state`);
        const file = state.files.find((entry: Record<string, unknown>) => entry.name === name);
        if (!file) return { valid: false, reason: "Model did not save the requested PPTX" };
        const url = new URL(`/download/${encodeURIComponent(file.id)}`, microsoft.baseUrl);
        const response = await fetch(url, { redirect: "error" });
        if (!response.ok) return { valid: false, reason: `PPTX download HTTP ${response.status}` };
        const path = join(root, "observed-report.pptx");
        const bytes = Buffer.from(await response.arrayBuffer());
        await writeFile(path, bytes);
        const digest = createHash("sha256").update(bytes).digest("hex");
        try {
          const uvx = process.env.OPENWORK_WORKSHOP_UVX ?? "uvx";
          const parsed = await run(uvx, ["--from", "python-pptx", "python", "-c", "import json,sys,zipfile;from pptx import Presentation;p=Presentation(sys.argv[1]);texts=[s.text for slide in p.slides for s in slide.shapes if s.has_text_frame];texts += [c.text for slide in p.slides for s in slide.shapes if s.has_table for row in s.table.rows for c in row.cells];texts += [r.target_ref for slide in p.slides for r in slide.part.rels.values() if r.is_external];print(json.dumps({'slides':len(p.slides),'validZip':zipfile.is_zipfile(sys.argv[1]),'text':'\\n'.join(texts)}))", path], { timeout: 60_000 });
          const result: unknown = JSON.parse(parsed.stdout);
          return { valid: record(result) && typeof result.slides === "number" && result.slides >= 3 && typeof result.text === "string" && /Northwind/i.test(result.text) && /Blue Harbor/i.test(result.text), parser: "python-pptx", result, artifact: { fileId: String(file.id), sha256: digest, downloadedSha256: digest, validZip: record(result) && result.validZip === true, validPresentation: record(result), slideCount: record(result) && typeof result.slides === "number" ? result.slides : 0, extractedText: record(result) && typeof result.text === "string" ? result.text : "", generatedBySessionId: sessionId }, reason: "OOXML opened by python-pptx; no Office application rendering claim" };
        } catch { return { valid: false, reason: "PPTX parser/openability failed or python-pptx unavailable" }; }
      },
      async acknowledgeScheduledExecution(input: { eventId: string; sessionId: string; digestFileId: string; draftId: string; inferenceWitnessSequence: number }) {
        const current = await latestSession("owner");
        const paid = inference.observations().find((entry) => entry.sequence === input.inferenceWitnessSequence && entry.status === "completed");
        const state = await stateJson(`${microsoft.baseUrl}/state`);
        if (current !== input.sessionId || !paid || !state.files.some((file: Record<string, unknown>) => file.id === input.digestFileId) || !state.messages.some((mail: Record<string, unknown>) => mail.id === input.draftId && mail.isDraft === true)) throw new Error("Cannot attest a scheduled run without actual paid inference and persisted backend delivery.");
        const response = await fetch(`${news.baseUrl}/execution-receipt`, { method: "POST", headers: { "content-type": "application/json", "x-workshop-operator-token": operatorKey }, body: JSON.stringify(input) });
        if (!response.ok) throw new Error(`Owned scheduled receipt rejected: ${response.status}`);
      },
      async advanceNewsClock() {
        const response = await fetch(`${news.baseUrl}/clock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ now: "2026-10-16T16:00:00Z" }) });
        if (!response.ok) throw new Error("Owned simulated clock advance failed.");
        return stateJson(`${news.baseUrl}/state`);
      },
      recordRow: (row: NarrativeRow) => rows.push(row),
      async finish() {
        const observations = inference.observations();
        const report = { verdict: rows.every((row) => row.status === "PASS") ? "PASS" : "INCOMPLETE", profile, model: inference.metadata, fixedNow: FIXED_NOW, seedDigest, durationMs: Date.now() - startedAt, rows, inference: observations };
        await writeFile(join(reportDir, "matrix.json"), JSON.stringify(report, null, 2) + "\n");
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) {
    await resources.disposeAsync();
    const name = error instanceof Error ? error.name : "Error";
    // Keep a full row matrix even when world construction is blocked; never manufacture successful scenes.
    let diagnostic = error instanceof Error ? error.message : "Unknown setup failure";
    for (const secret of redactions) if (secret) diagnostic = diagnostic.replaceAll(secret, "[credential-redacted]");
    diagnostic = diagnostic.replaceAll(root, "[owned-scratch]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 900);
    console.error(`[workshop] setup blocked at ${setupStage}: ${name}: ${diagnostic}`);
    return blocked(`Owned setup blocked at ${setupStage} (${name}): ${diagnostic}`, subjectMetadata);
  }
}
