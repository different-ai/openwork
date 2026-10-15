import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { denFetch } from "@openwork/behaviors";
import { evaluateOnSurface, listTargets, type AttachedSurface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { createGatewayApp } from "../../ee/apps/den-gateway/src/app.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const origin = "https://web.example.test";
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

/** Real production app, gateway, Den API and Den web. CDP routes one exact HTTPS
 * fixture origin to the gateway, without changing browser navigation or auth. */
export async function webSigninRedirect(seed: Seed) {
  execFileSync("pnpm", ["--filter", "@openwork/app", "build:web"], { cwd: root, stdio: "pipe" });
  const den = await seed.den({
    org: { name: "Web sign-in workspace", members: {} },
    env: { DEN_OPENWORK_WEB_ENABLED: "true", DEN_GATEWAY_ORIGIN: origin },
  });
  const gateway = createGatewayApp({ webRoot: `${root}/apps/app/dist`, denApiBase: den.ref.apiUrl, denWebUrl: den.ref.webUrl, logRequests: false });
  const sockets: WebSocket[] = [];
  const errors: string[] = [];
  const browserErrors: string[] = [];
  const failedRequests: string[] = [];
  const requests: { method: string; path: string; status: number }[] = [];

  async function browser(signedIn: boolean) {
    const app = await seed.web({ den, ...(signedIn ? { signedInAs: den.admin } : {}), headless: true, viewport: { width: 1280, height: 900 } });
    if (!app.client.webSocketDebuggerUrl) throw new Error("Missing browser debugger address");
    const socket = new WebSocket(app.client.webSocketDebuggerUrl);
    sockets.push(socket);
    let sequence = 0;
    const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    function send(method: string, params: Record<string, unknown>) {
      return new Promise<void>((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    async function intercept(params: Record<string, unknown>) {
      if (typeof params.requestId !== "string" || !record(params.request) || typeof params.request.url !== "string" || typeof params.request.method !== "string") throw new Error("Malformed intercepted request");
      const request = params.request;
      const headers = new Headers();
      if (record(request.headers)) for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
      // Preserve navigation headers so /workspace/... reloads are served as SPA documents.
      const response = await gateway.request(new Request(String(request.url), {
        method: String(request.method), headers,
        ...(typeof request.postData === "string" ? { body: request.postData } : {}),
      }));
      requests.push({ method: String(request.method), path: new URL(String(request.url)).pathname, status: response.status });
      await send("Fetch.fulfillRequest", {
        requestId: params.requestId, responseCode: response.status,
        responseHeaders: [...response.headers].map(([name, value]) => ({ name, value })),
        body: Buffer.from(await response.arrayBuffer()).toString("base64"),
      });
    }
    socket.addEventListener("message", event => {
      const message: unknown = JSON.parse(String(event.data));
      if (!record(message)) return;
      if (message.method === "Runtime.exceptionThrown") browserErrors.push(JSON.stringify(message.params));
      if (message.method === "Network.loadingFailed" && record(message.params) && message.params.canceled !== true) failedRequests.push(String(message.params.errorText));
      if (typeof message.id === "number") {
        const call = pending.get(message.id);
        if (call) { clearTimeout(call.timer); pending.delete(message.id); message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(); }
      }
      if (message.method === "Fetch.requestPaused" && record(message.params)) void intercept(message.params).catch(error => {
        if (!/Invalid (InterceptionId|interceptionId)|Invalid Fetch request id/i.test(String(error))) errors.push(String(error));
      });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP interception connection timed out")), 15_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP interception connection failed")); }, { once: true });
    });
    await send("Runtime.enable", {});
    await send("Network.enable", {});
    await send("Fetch.enable", { patterns: [{ urlPattern: `${origin}/*`, requestStage: "Request" }] });
    return app;
  }

  return {
    den, origin, errors, browserErrors, failedRequests, requests,
    app: await browser(true),
    freshBrowser: () => browser(false),
    async rollout(enabled: boolean, killed = false) {
      const result = await denFetch(den.admin, "/v1/admin/features/webSigninRedirect", {
        method: "PUT", headers: { authorization: `Bearer ${den.admin.token}` }, body: JSON.stringify({ enabled, killed }),
      });
      if (!result.response.ok) throw new Error(`Feature rollout failed: HTTP ${result.response.status} ${result.text.slice(0, 200)}`);
    },
    async state(app: AttachedSurface) {
      return evaluateOnSurface(app, () => ({
        href: location.href,
        signedIn: Boolean(localStorage.getItem("openwork.den.authToken")),
        activeOrg: localStorage.getItem("openwork.den.activeOrgId"),
        attempt: sessionStorage.getItem("openwork.webSignin.attempt"),
      }));
    },
    async pages(app: AttachedSurface) { return (await listTargets(app.handle.cdpUrl)).filter(page => page.type === "page").length; },
    async [Symbol.asyncDispose]() { for (const socket of sockets) socket.close(); },
  };
}
