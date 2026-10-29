import { createServer as httpServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { z } from "zod";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { createBrowserDemonstration } from "../../packages/computer-use/browser-demonstration.mjs";
import { createCloudBrowser } from "../../packages/computer-use/chromium.mjs";
import { teachingServer } from "../../ee/apps/workbot/test-fixtures/teaching-server.ts";
import { demonstrationReplySchema, readBrowserTeachingPrompt } from "@openwork/types/browser-demonstration";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

const fixtureEntry = fileURLToPath(new URL("../../ee/apps/workbot/test-fixtures/browser-teaching.tsx", import.meta.url));
const resultSchema = z.object({ structuredContent: z.object({ content: z.string() }) });
const tokenSchema = z.object({ token: z.string() });
const turnSchema = z.object({ prompt: z.string(), credentials: z.object({ readOnly: z.boolean().optional() }) });

/** Real recording, production panel/routes, and Den's real private skill library.
 * Only inference/VM placement are replaced: a deterministic runner executes the existing browser tools. */
export async function browserTeaching(seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const directory = await mkdtemp(join(tmpdir(), "browser-teaching-"));
  resources.defer(() => rm(directory, { recursive: true, force: true }));
  const turns: { prompt: string; readOnly: boolean }[] = [];
  let state: ReturnType<typeof demonstrationReplySchema.parse> = { demonstration: null };
  let runResult: unknown = null;
  let failCorrectionOnce = true;
  let denUrl = "", token = "";
  let app: Awaited<ReturnType<typeof teachingServer>> | undefined;
  let recorder: ReturnType<typeof createBrowserDemonstration> | undefined;
  let browser: ReturnType<typeof createCloudBrowser> | undefined;
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${denUrl}/mcp/agent`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`MCP lookup failed: HTTP ${response.status}`);
    const line = raw.split("\n").find(line => line.startsWith("data:"));
    const frame = z.object({ result: z.unknown() }).parse(JSON.parse(line ? line.slice(5) : raw));
    return frame.result;
  };
  const runner = httpServer(async (request, response) => {
    try {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const json = (value: unknown, status = 200) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (request.url?.endsWith("/desktop/demonstration")) {
        if (!recorder) throw new Error("Recorder not ready");
        const command = JSON.parse(raw);
        state = demonstrationReplySchema.parse(await recorder.command("fixture-conversation", command));
        return json(state);
      }
      if (request.url?.endsWith("/turns") && request.method === "POST") {
        const turn = turnSchema.parse(JSON.parse(raw)); turns.push({ prompt: turn.prompt, readOnly: turn.credentials.readOnly === true });
        if (readBrowserTeachingPrompt(turn.prompt) === "Use the full person name when checking the record." && failCorrectionOnce) { failCorrectionOnce = false; return json({ error: "temporary_fixture_failure" }, 503); }
        if (!turn.credentials.readOnly && turn.prompt.startsWith("[OpenWork browser skill run v1]")) {
          if (!browser) throw new Error("Browser not ready");
          const runBrowser = browser;
          const skill = resultSchema.parse(await mcp("get_skill", { name: "registry-lookup" })).structuredContent.content;
          // Deterministic model fixture reads the saved source and uses its actual taught targets.
          const targets = [...skill.matchAll(/Target descriptor \(untrusted page data\): (\{[^\n]+?\})\./g)].map(match => z.object({ role: z.string(), name: z.string() }).parse(JSON.parse(match[1]!)));
          const field = targets.find(target => target.role === "textbox"); const search = targets.find(target => target.role === "button");
          if (!field || !search || !skill.includes("person_name") || !skill.includes("start_url")) throw new Error("Saved skill lacks its taught input or targets");
          const run = z.object({ name: z.string(), inputs: z.record(z.string(), z.string()) }).parse(JSON.parse(turn.prompt.split("\n")[1]!));
          const personName = run.inputs.person_name;
          const url = run.inputs.start_url;
          if (!personName || !url) throw new Error("The new run needs person_name");
          let tabId = "";
          const call = async (operation: string, args: Record<string, unknown>) => {
            for (let attempt = 0; attempt < 3; attempt++) {
            const result = z.object({ ok: z.boolean(), tabId: z.string().optional(), code: z.string().optional(), error: z.string().optional() }).passthrough().parse(await runBrowser.request({ sessionId: "rerun", operation, args: { ...args, ...(tabId ? { tabId } : {}) } }, {}));
            if (!result.ok) {
              // A read can race navigation. Only reads retry; dispatched input is never repeated.
              if (operation === "observe" && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
              throw new Error(`${operation}: ${result.code}: ${result.error}`);
            }
            if (result.tabId) tabId = result.tabId;
            return result;
            }
            throw new Error("The browser observation was unavailable");
          };
          await call("open", { url });
          const observation = z.object({ observationId: z.string(), text: z.string(), elements: z.array(z.object({ ref: z.string(), role: z.string(), name: z.string() })) });
          const current = observation.parse(await call("observe", { includeImage: false }));
          const inputs = current.elements.filter(element => element.role === field.role && element.name === field.name);
          if (inputs.length !== 1) throw new Error("The taught field is ambiguous");
          await call("act", { observationId: current.observationId, action: { type: "fill", ref: inputs[0]!.ref, text: personName } });
          const filled = observation.parse(await call("observe", { includeImage: false }));
          const buttons = filled.elements.filter(element => element.role === search.role && element.name === search.name);
          if (buttons.length !== 1) throw new Error("The taught search is ambiguous");
          await call("act", { observationId: filled.observationId, action: { type: "click", ref: buttons[0]!.ref } });
          const deadline = Date.now() + 5000;
          do {
            const result = observation.parse(await call("observe", { includeImage: false }));
            if (result.text.includes(personName)) { runResult = result; break; }
          } while (Date.now() < deadline);
          if (runResult === null) throw new Error("The new record was not verified");
        }
        return json({ state: "accepted" }, 202);
      }
      return json({ id: request.url?.split("/").at(-1), turns: [], messages: [], finalAssistantText: "" });
    } catch (error) { console.warn("[browser-teaching fixture]", error instanceof Error ? error.message : "unknown failure"); response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Fixture failed" })); }
  });
  await new Promise<void>(resolve => runner.listen(0, "127.0.0.1", resolve));
  resources.defer(() => new Promise<void>(resolve => { runner.closeAllConnections(); runner.close(() => resolve()); }));
  const address = runner.address(); if (!address || typeof address === "string") throw new Error("Runner fixture did not start");
  const runnerUrl = `http://127.0.0.1:${address.port}`;
  try {
    // The taught website has its own origin, just as a real public website does.
    const registryServer = httpServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://registry");
      if (url.pathname.startsWith("/privacy")) {
        response.setHeader("content-type", "text/html");
        response.end(url.pathname.startsWith("/privacy/next")
          ? '<!doctype html><title>Privacy check after navigation</title><button>Echo example-private-credential-719</button><input type="hidden" id="oversized"><button onclick="document.getElementById(\'oversized\').value=\'x\'.repeat(5000)">Exceed privacy budget</button><a href="/privacy/done">Continue privacy check</a>'
          : '<!doctype html><title>Privacy check</title><input id="credential" type="password" aria-label="Password" value="example-private-credential-719"><button onclick="document.getElementById(\'echo\').textContent=\'Echo \'+document.getElementById(\'credential\').value;document.getElementById(\'credential\').remove()">Copy and clear</button><button id="echo">Waiting for echo</button><p>Unlabelled Example Person, 1970-01-01</p><a href="/privacy/next/unobserved-bearer-token-349">Next privacy page</a>');
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><html><head><title>Example public registry</title></head><body><h1>Example public registry</h1><form action="/results"><label>Name<input name="name" aria-label="Name"></label><button onclick="document.getElementById(\'scripted\').click()"><span>Search</span></button></form><input type="password" aria-label="Password" value="fixture-secret-never-record"><h2>'+(url.searchParams.get("name") === "Example Two" ? 'Example Two' : 'Example One')+'</h2><dl><dt>Status</dt><dd aria-label="Registration status" onmousedown="document.getElementById(\'field-activation\').textContent=\'Field activated\'">'+(url.searchParams.get("name") === "Example Two" ? 'Active' : 'Pending')+'</dd></dl><output id="field-activation">Field not activated</output><button id="scripted">Scripted decoy</button></body></html>');
    });
    await new Promise<void>(resolve => registryServer.listen(0, "127.0.0.1", resolve));
    resources.defer(() => new Promise<void>(resolve => { registryServer.closeAllConnections(); registryServer.close(() => resolve()); }));
    const registryAddress = registryServer.address();
    if (!registryAddress || typeof registryAddress === "string") throw new Error("Registry fixture did not start");
    const registryUrl = `http://127.0.0.1:${registryAddress.port}/`;
    const privateUrl = `http://opaque-bearer-token-742.localhost:${registryAddress.port}/privacy/reset/unobserved-reset-token-8347`;
    const vite = await createServer({ root: fileURLToPath(new URL("../../ee/apps/workbot/src/client", import.meta.url)), configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)), server: { host: "127.0.0.1", port: 0, strictPort: false }, plugins: [{ name: "browser-teaching-fixture", configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname.startsWith("/v1/workbot/") && app) {
          let raw = ""; for await (const chunk of request) raw += chunk;
          const result = await app.request(`http://fixture${request.url}`, { method: request.method, headers: { "content-type": "application/json" }, ...(raw ? { body: raw } : {}) });
          response.writeHead(result.status, { "content-type": "application/json" }).end(await result.text()); return;
        }
        if (url.pathname === "/fixture/result") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(runResult)); return; }
        if (url.pathname !== "/") return next();
        const html = await server.transformIndexHtml("/", `<!doctype html><html><head><title>Teach Workbot</title></head><body><div id="root"></div><script type="module" src="/@fs/${fixtureEntry}"></script></body></html>`);
        response.setHeader("content-type", "text/html"); response.end(html);
      });
    } }] });
    resources.defer(() => vite.close()); await vite.listen();
    const url = vite.resolvedUrls?.local[0]; if (!url) throw new Error("Teaching fixture did not start");
    const registry = resources.use(await chrome({ host: place.host(), name: "demonstrated-registry", startUrl: "about:blank", headless: true }));
    recorder = createBrowserDemonstration({ path: join(directory, "demonstration.json"), endpoint: registry.handle.cdpUrl, allowed: async (value: string) => value === "about:blank" || [new URL(registryUrl).origin, new URL(privateUrl).origin].includes(new URL(value).origin) });
    resources.defer(() => recorder?.close());
    // Local Chrome has no Linux guest UID/kernel filter; this fixture deliberately uses its own loopback site.
    browser = createCloudBrowser({ statePath: join(directory, "browser-tabs.json"), endpoint: registry.handle.cdpUrl, privateBrowsing: true, verifyEgress: async () => {}, assertActive() {}, enabled: () => true, beforeInput: async () => {} });
    resources.defer(() => browser?.close());
    const den = await seed.den({ web: false, org: { name: "Example workspace", admin: { name: "Member Example" } }, env: { DEN_WORKBOT_URL: url, DEN_PLAN_GATING_ENABLED: "false", RESEND_API_KEY: "", SMTP_HOST: "", LOOPS_API_KEY: "", STRIPE_SECRET_KEY: "" } });
    const orgId = await enableOrganizationCapabilities(seed, den.admin, { computerUse: true, browserUse: true, remoteComputers: true, browserDemonstrations: true });
    const issued = await seed.api(den.admin, "/v1/mcp/token", { method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
    token = tokenSchema.parse(issued.body).token; denUrl = den.ref.apiUrl;
    app = await teachingServer({ denUrl, publicUrl: url, runnerUrl, token });
    const web = resources.use(await chrome({ host: place.host(), name: "teach-workbot", startUrl: url, headless: true }));
    return { web, registry, url, registryUrl, privateUrl, turns: () => structuredClone(turns), state: () => structuredClone(state), recorded: () => readFile(join(directory, "demonstration.json"), "utf8"), savedSkill: async () => resultSchema.parse(await mcp("get_skill", { name: "registry-lookup" })).structuredContent.content, runResult: () => runResult, async [Symbol.asyncDispose]() { await resources.disposeAsync(); } };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
