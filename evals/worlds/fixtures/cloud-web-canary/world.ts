import { setTimeout as delay } from "node:timers/promises";
import { callFunctionOnSurface, connect, debuggerUrlFor, listTargets } from "@openwork/cdp";
import { chrome, localHost } from "@openwork/hosts";
import type { Place, Seed, TestNeeds } from "@openwork/env";

export const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_LIVE"],
  env: ["CANARY_CONSENT", "CANARY_DEN_API_URL", "CANARY_DEN_WEB_URL", "CANARY_GATEWAY_URL",
    "CANARY_EMAIL", "CANARY_PASSWORD", "CANARY_ORG_ID", "CANARY_USER_ID",
    "CANARY_MODEL_URL", "CANARY_MODEL_KEY", "CANARY_MARKER"],
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing ${name}`);
  return value;
}

function origin(name: string): string {
  let url: URL;
  try { url = new URL(required(name)); } catch { throw new Error(`Invalid ${name}`); }
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.daytonaproxy\d+\.net$/.test(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`${name} must be a bare HTTPS Daytona preview origin, without credentials`);
  }
  return url.origin;
}

export async function attachedCanary(seed: Seed, { place }: { place: Place }) {
  if (required("CANARY_CONSENT") !== "isolated-synthetic-daytona") throw new Error("Explicit isolated canary consent is required");
  if (place.kind !== "local") throw new Error("This attached canary requires local Chrome; never provision a browser sandbox");
  const apiUrl = origin("CANARY_DEN_API_URL");
  const webUrl = origin("CANARY_DEN_WEB_URL");
  const gatewayUrl = origin("CANARY_GATEWAY_URL");
  const modelUrl = origin("CANARY_MODEL_URL");
  const email = required("CANARY_EMAIL");
  if (!/^[^@\s]+@[^@\s]+\.(test|invalid)$/.test(email)) throw new Error("CANARY_EMAIL must be a synthetic .test or .invalid account");
  const password = required("CANARY_PASSWORD");
  const orgId = required("CANARY_ORG_ID");
  const userId = required("CANARY_USER_ID");
  const modelKey = required("CANARY_MODEL_KEY");
  const marker = required("CANARY_MARKER");
  const filename = process.env.CANARY_FILE_NAME ?? "web-canary-note.txt";
  const workspace = process.env.CANARY_WORKSPACE_PATH ?? "/tmp/openwork-workspace";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(marker) || !/^[A-Za-z0-9_-]+\.txt$/.test(filename)) throw new Error("Use a synthetic marker and plain .txt filename");

  // Explicit reuse + provision:false neither signs in nor creates/deletes server resources.
  const den = await seed.den({ reuse: { apiUrl, webUrl }, provision: false, web: true });
  const web = await chrome({ host: localHost(), name: "cloud-web-canary", startUrl: "about:blank", headless: false });
  return {
    web, den, gatewayUrl, email, password, orgId, userId, marker, filename, workspace,
    expectedWorkerId: process.env.CANARY_WORKER_ID,
    async followLoginPopup() {
      // The product's window.open creates this tab. Only attach; never synthesize
      // a login URL, inject cookies, or replace the browser's open handler.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const targets = (await listTargets(web.handle.cdpUrl)).filter((target) =>
          target.type === "page" && target.id !== web.client.targetId && target.url.startsWith(`${webUrl}/`));
        if (targets.length === 1) {
          const client = await connect(debuggerUrlFor(web.handle.cdpUrl, targets[0]));
          await client.send("Page.enable");
          await client.send("Page.bringToFront");
          web.client.close();
          web.client = client;
          return;
        }
        await delay(100);
      }
      throw new Error("The gateway did not open the isolated Den login tab");
    },
    async page() {
      // Read only DOM/location facts; never install fake controls or serialize grants/URLs.
      const value = await callFunctionOnSurface(web, `(gateway, den) => ({
        atGateway: location.origin === gateway,
        atDen: location.origin === den,
        route: location.origin === gateway ? location.pathname + location.hash : "",
        takeover: document.querySelector('[data-testid="cloud-workspace-takeover"]')?.getAttribute('data-cloud-workspace-state') ?? null,
        ready: document.querySelector('[data-testid="cloud-workspace-pill"]')?.getAttribute('data-cloud-workspace-state') === 'ready',
        assistant: [...document.querySelectorAll('[data-message-role="assistant"]')].map(node => node.textContent ?? '').join('\\n')
      })`, [gatewayUrl, webUrl]);
      if (!record(value) || typeof value.atGateway !== "boolean" || typeof value.atDen !== "boolean"
        || typeof value.route !== "string" || typeof value.ready !== "boolean" || typeof value.assistant !== "string"
        || !(value.takeover === null || typeof value.takeover === "string")) throw new Error("Invalid canary page observation");
      return { atGateway: value.atGateway, atDen: value.atDen, route: value.route, ready: value.ready, takeover: value.takeover, assistant: value.assistant };
    },
    async stats() {
      // No redirect forwarding, no raw provider body in errors/evidence.
      const response = await fetch(`${modelUrl}/stats`, { headers: { authorization: `Bearer ${modelKey}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Canary /stats returned HTTP ${response.status}`);
      const value: unknown = await response.json();
      if (!record(value) || !Array.isArray(value.readReceipts)) throw new Error("Invalid canary counters");
      const number = (key: string) => {
        const field = value[key];
        if (typeof field !== "number" || !Number.isInteger(field)) throw new Error("Invalid canary counter");
        return field;
      };
      const receipts = value.readReceipts.map((receipt: unknown) => {
        if (!record(receipt) || typeof receipt.sequence !== "number" || typeof receipt.turn !== "number"
          || typeof receipt.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw new Error("Invalid read receipt");
        return { sequence: receipt.sequence, turn: receipt.turn, sha256: receipt.sha256 };
      });
      return { writeToolCalls: number("writeToolCalls"), readToolCalls: number("readToolCalls"), verifiedReads: number("verifiedReads"),
        rejectedReadResults: number("rejectedReadResults"), protocolErrors: number("protocolErrors"), streamedReplies: number("streamedReplies"),
        upstreamCalls: number("upstreamCalls"), receipts };
    },
    async [Symbol.asyncDispose]() { await web[Symbol.asyncDispose](); },
  };
}

export function workerRows(value: unknown) {
  if (!record(value) || !Array.isArray(value.workers)) throw new Error("Invalid worker list");
  return value.workers.map((worker: unknown) => {
    if (!record(worker) || typeof worker.id !== "string" || typeof worker.orgId !== "string"
      || typeof worker.createdByUserId !== "string" || typeof worker.status !== "string"
      || typeof worker.workspacePath !== "string" || typeof worker.sandboxBackend !== "string") throw new Error("Invalid worker identity");
    return { id: worker.id, orgId: worker.orgId, userId: worker.createdByUserId, status: worker.status,
      workspacePath: worker.workspacePath, backend: worker.sandboxBackend };
  });
}
