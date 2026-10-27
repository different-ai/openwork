import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "@openwork/cdp";
import { denFetch, liveProviderId, provisionLiveOpenAi } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export const workshopApps = ["outlook", "calendar", "drive", "jira", "confluence"];
export const workshopModel = "gpt-6.1-sol";
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(record) : [];
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${name}`);
  return value;
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 500));

/** Owned real Den + app in headless Chrome. Only workplace data is fictional; inference and OAuth are real. */
export async function workshopAgent(seed: Seed) {
  const resources = new AsyncDisposableStack();
  try {
    const marker = `workshop-${randomBytes(5).toString("hex")}`;
    const configured = process.env.OPEN_WORKPLACE_TEST_URL;
    const rosterFile = process.env.OPEN_WORKPLACE_TEST_PARTICIPANTS_FILE;
    if (configured && !rosterFile) throw new Error("Hosted workshop needs OPEN_WORKPLACE_TEST_PARTICIPANTS_FILE");
    const roster: unknown = rosterFile ? JSON.parse(await readFile(rosterFile, "utf8")) : [
      { id: "proof-a", name: "Avery Workshop", token: randomBytes(32).toString("base64url") },
      { id: "proof-b", name: "Riley Workshop", token: randomBytes(32).toString("base64url") },
    ];
    if (!Array.isArray(roster) || roster.length !== 2 || rows(roster).length !== 2) throw new Error("Use exactly two reserved verification accounts, never the full attendee roster");
    const participants = rows(roster).map((entry) => ({
      id: requiredString(entry.id, "participant id"), name: requiredString(entry.name, "participant name"),
      token: requiredString(entry.token, "participant access code"),
    }));
    if (participants.length !== 2) throw new Error("The proof needs two private workshop participants");
    const first = participants[0]; const second = participants[1];
    if (!first || !second) throw new Error("Missing workshop participants");
    if (first.id === second.id || first.token === second.token) throw new Error("Verification accounts must have distinct identities and passwords");
    const origin = configured ? new URL(configured).origin : `http://127.0.0.1:${await allocateFreePort()}`;
    if (configured && new URL(origin).protocol !== "https:") throw new Error("Hosted workshop proof requires HTTPS");
    if (!configured) {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../packages/open-workplace/src/workshop.mjs", import.meta.url))], {
        env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: new URL(origin).port, PUBLIC_URL: origin, OPEN_WORKPLACE_JOIN_MODE: "assigned", OPEN_WORKPLACE_PARTICIPANTS: JSON.stringify(participants) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.resume(); child.stderr.resume();
      resources.defer(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
          child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
        });
      });
      const deadline = Date.now() + 30_000;
      while (!await fetch(`${origin}/health`).then((result) => result.ok).catch(() => false)) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error("Local standalone workshop did not become healthy");
        await pause();
      }
    }
    const { den, webPort } = await denForAppWeb(seed, {
      web: true, env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1", RESEND_API_KEY: "", SMTP_HOST: "" },
      org: { name: marker, members: { a: { name: first.name }, b: { name: second.name } } },
    });
    const members = { a: den.members.a, b: den.members.b };
    if (!members.a || !members.b) throw new Error("Two independent Den members were not seeded");
    const connections: { id: string; app: string; name: string }[] = [];
    for (const app of workshopApps) {
      const name = `Workshop ${app}`;
      const result = await seed.api(den.admin, "/v1/mcp-connections", {
        method: "POST", body: JSON.stringify({ name, url: `${origin}/${app}/mcp`, authType: "oauth", credentialMode: "per_member", exposeDirectly: true, access: { orgWide: true } }),
      });
      if (!result.response.ok || !record(result.body)) throw new Error(`Create ${app} connector: HTTP ${result.response.status}`);
      connections.push({ id: requiredString(result.body.id, "connection id"), app, name });
    }
    const webA = await seed.web({ den, signedInAs: members.a, startPath: "/dashboard/your-connections", headless: true });
    const webB = await seed.web({ den, signedInAs: members.b, startPath: "/dashboard/your-connections", headless: true });
    process.env.OPENWORK_EVAL_LIVE_OPENAI = "1";
    process.env.OPENWORK_EVAL_OPENAI_MODEL = workshopModel;
    const managed = resources.use(await provisionLiveOpenAi(den.admin, marker));
    const workspacePath = seed.tmpPath(marker);
    await mkdir(workspacePath, { recursive: true });
    // The paid credential is provisioned through Den's encrypted provider store
    // and private runtime broker, never written into workspace config/evidence.
    await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({
      permission: { "*": "allow" },
    }));
    const { app, workspace } = await signedInAppWeb(seed, {
      den, webPort, as: "a", engine: "v2", name: marker, workspacePath,
      env: { OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "1000" },
    });
    const paths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
    const manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
    if (!manifest) throw new Error("Missing owned app runtime manifest");
    const issued = await fetch(`${app.openworkUrl}/tokens`, {
      method: "POST", headers: { "x-openwork-host-token": manifest.hostToken, "content-type": "application/json" },
      body: JSON.stringify({ scope: "owner", label: "workshop-proof" }),
    });
    const issuedBody: unknown = await issued.json();
    if (!issued.ok || !record(issuedBody)) throw new Error("Cannot mint owned app observer token");
    const ownerToken = requiredString(issuedBody.token, "observer token");
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${app.openworkUrl}${path}`, {
        method, headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      let value: unknown = text; try { value = text ? JSON.parse(text) : null; } catch { /* diagnostic text */ }
      return { status: response.status, body: value };
    };
    const org = await seed.api(members.a, "/v1/org");
    const organizationId = record(org.body) && record(org.body.organization) ? requiredString(org.body.organization.id, "organization id") : "";
    // Same owned-runtime handoff used by bootAcmeWeb: renderer sign-in alone
    // does not necessarily establish the server-side credential broker session.
    const linked = await fetch(`${app.openworkUrl}/den-session`, {
      method: "PUT", headers: { "x-openwork-host-token": manifest.hostToken, "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: den.ref.apiUrl, token: members.a.token, orgId: organizationId }),
    });
    if (!linked.ok) throw new Error(`Owned app Den-session handoff: HTTP ${linked.status}`);
    const providerId = await liveProviderId(async (path, method = "GET", body) => {
      const result = await request(path, method, body);
      return { status: result.status, json: result.body };
    }, managed.id);
    const minted = await seed.api(members.a, "/v1/mcp/token", { method: "POST", headers: { "x-openwork-org-id": organizationId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
    const cloudToken = record(minted.body) ? requiredString(minted.body.token, "member MCP token") : "";
    const reconciled = await request(`/workspace/${workspace.workspaceId}/mcp/openwork-cloud/reconcile`, "POST", {
      config: { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${cloudToken}` } }, trigger: "workshop-proof",
    });
    if (reconciled.status !== 200) throw new Error(`Member MCP reconcile: HTTP ${reconciled.status}`);
    const session = await seed.session(app, { title: "Workshop customer readiness" });
    const v2 = `/workspace/${workspace.workspaceId}/opencode2`;
    const memberRequest = async (person: "a" | "b", path: string, method = "GET") => {
      const member = members[person]; if (!member) throw new Error("Missing member");
      return denFetch(member, path, { method, headers: { authorization: `Bearer ${member.token}` } });
    };
    return {
      app, webA, webB, den, workspace, session, marker, origin, providerId, hosted: Boolean(configured), connections, v2, request,
      accessCode(person: "a" | "b") { return person === "a" ? first.token : second.token; },
      async waitForInferenceRelease() {
        const gate = process.env.OPEN_WORKPLACE_TEST_INFERENCE_GATE_FILE;
        if (!gate) return;
        const deadline = Date.now() + 12 * 60_000;
        while (!await readFile(gate).then(() => true).catch(() => false)) {
          if (Date.now() > deadline) throw new Error("Hosted OAuth setup completed, but the operator did not release paid inference after restart");
          await pause();
        }
      },
      async oauthStart(person: "a" | "b", connection: string) {
        const result = await memberRequest(person, `/v1/mcp-connections/${connection}/connect/start`);
        if (!result.response.ok || !record(result.body)) throw new Error(`Den OAuth start: HTTP ${result.response.status}`);
        return requiredString(result.body.authorizeUrl, "Den authorization URL");
      },
      async connection(person: "a" | "b", id: string) {
        const result = await memberRequest(person, "/v1/mcp-connections?scope=usable");
        return record(result.body) ? rows(result.body.connections).find((entry) => entry.id === id) : undefined;
      },
      async state(person: "a" | "b", service: "microsoft" | "atlassian") {
        const response = await fetch(`${origin}/_workshop/state/${service}`, { headers: { authorization: `Bearer ${person === "a" ? first.token : second.token}` }, signal: AbortSignal.timeout(30_000) });
        const body: unknown = await response.json();
        if (!response.ok || !record(body)) throw new Error(`Independent ${service} readback: HTTP ${response.status}`);
        return body;
      },
      async presentation(fileId: string) {
        const response = await fetch(`${origin}/download/${encodeURIComponent(fileId)}`, {
          headers: { authorization: `Bearer ${first.token}` }, signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Independent PowerPoint download: HTTP ${response.status}`);
        const path = join(workspacePath, `${marker}-downloaded-proof.pptx`);
        await writeFile(path, Buffer.from(await response.arrayBuffer()));
        const { stdout } = await promisify(execFile)("python3", ["-c", `
import json,sys,zipfile,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
 names=z.namelist()
 slides=[n for n in names if n.startswith('ppt/slides/slide') and n.endswith('.xml') and '/_rels/' not in n]
 assert '[Content_Types].xml' in names and 'ppt/presentation.xml' in names, 'not a PowerPoint OPC package'
 assert len(slides)==1, 'expected one actual slide'
 text=' '.join(node.text or '' for n in slides for node in E.fromstring(z.read(n)).iter() if node.tag.endswith('}t'))
 print(json.dumps({'slides':len(slides),'text':text,'zipEntries':len(names)}))
`, path], { timeout: 30_000 });
        const value: unknown = JSON.parse(stdout);
        if (!record(value)) throw new Error("Invalid independent PowerPoint inspection");
        // Optional real LibreOffice renderer, never an Office editor/integration claim.
        const officeAvailable = await promisify(execFile)("/usr/bin/which", ["soffice"], { timeout: 5000 }).then(() => true).catch(() => false);
        if (officeAvailable) {
          const profile = new URL(`file://${join(workspacePath, "libreoffice-profile")}`).href;
          await promisify(execFile)("soffice", [`-env:UserInstallation=${profile}`, "--headless", "--convert-to", "pdf", "--outdir", workspacePath, path], { timeout: 60_000 });
          const pdf = path.replace(/\.pptx$/, ".pdf");
          const pdfBytes = await readFile(pdf);
          if (pdfBytes.subarray(0, 4).toString() !== "%PDF") throw new Error("LibreOffice did not render a real PDF");
          await promisify(execFile)("soffice", [`-env:UserInstallation=${profile}`, "--headless", "--convert-to", "png:impress_png_Export", "--outdir", workspacePath, path], { timeout: 60_000 });
          const png = path.replace(/\.pptx$/, ".png");
          const pngBytes = await readFile(png);
          if (pngBytes.subarray(1, 4).toString() !== "PNG") throw new Error("LibreOffice did not render a real slide image");
          return { ...value, renderedPdf: pdf, renderedPng: png };
        }
        return value;
      },
      async waitTurn(oldIds: Set<string>) {
        const deadline = Date.now() + 240_000;
        while (Date.now() < deadline) {
          const result = await request(`${v2}/api/session/${session.sessionId}/message`);
          const messages = record(result.body) ? rows(result.body.data) : rows(result.body);
          const fresh = messages.filter((message) => typeof message.id === "string" && !oldIds.has(message.id) && message.type === "assistant");
          if (fresh.length > 24) {
            await request(`${v2}/api/session/${session.sessionId}/interrupt`, "POST", {});
            throw new Error("Paid workshop turn exceeded 24 assistant messages");
          }
          const failed = fresh.find((message) => message.error || message.finish === "error");
          if (failed) {
            let description = JSON.stringify(failed.error ?? { finish: failed.finish });
            for (const secret of [process.env.OPENAI_API_KEY, first.token, second.token, ownerToken, cloudToken]) if (secret) description = description.split(secret).join("<redacted>");
            throw new Error(`Paid workshop model returned an error: ${description.slice(0, 1000)}`);
          }
          const estimatedCost = messages.reduce((sum, message) => {
            const tokens = record(message.tokens) ? message.tokens : {};
            const cache = record(tokens.cache) ? tokens.cache : {};
            return sum + (typeof tokens.input === "number" ? tokens.input * 2 / 1_000_000 : 0)
              + (typeof tokens.output === "number" ? tokens.output * 10 / 1_000_000 : 0)
              + (typeof cache.read === "number" ? cache.read * 0.1 / 1_000_000 : 0)
              + (typeof cache.write === "number" ? cache.write * 2.5 / 1_000_000 : 0);
          }, 0);
          if (estimatedCost >= 8) {
            await request(`${v2}/api/session/${session.sessionId}/interrupt`, "POST", {});
            throw new Error("Paid workshop session reached its conservative eight-dollar token budget");
          }
          const done = fresh.find((message) => record(message.time) && typeof message.time.completed === "number" && message.finish === "stop");
          if (done) {
            if (!record(done.model) || done.model.id !== workshopModel || !record(done.tokens) || typeof done.tokens.output !== "number" || done.tokens.output <= 0) throw new Error("Completed turn lacks exact Sol identity or generated tokens");
            const text = rows(done.content).filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("\n");
            await writeFile(join(workspacePath, "model-usage.json"), JSON.stringify({ estimatedCost, messages: messages.filter((message) => message.type === "assistant").map((message) => ({ id: message.id, model: message.model, tokens: message.tokens, cost: message.cost, finish: message.finish })) }, null, 2), { mode: 0o600 });
            return { text, messages: fresh, outputTokens: done.tokens.output, model: done.model.id, estimatedCost };
          }
          const permissions = await request(`${v2}/api/session/${session.sessionId}/permission`);
          for (const pending of record(permissions.body) ? rows(permissions.body.data) : []) if (typeof pending.id === "string") {
            await request(`${v2}/api/session/${session.sessionId}/permission/${pending.id}/reply`, "POST", { reply: "once" });
          }
          await pause();
        }
        await request(`${v2}/api/session/${session.sessionId}/interrupt`, "POST", {});
        throw new Error("Paid workshop model exceeded the four-minute task budget");
      },
      async messageIds() {
        const result = await request(`${v2}/api/session/${session.sessionId}/message`);
        return new Set((record(result.body) ? rows(result.body.data) : rows(result.body)).map((message) => String(message.id)));
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
