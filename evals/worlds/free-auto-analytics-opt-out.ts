import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { go } from "@openwork/behaviors";
import { allocateFreePort, browserScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

const root = fileURLToPath(new URL("../../", import.meta.url));

type GatewayRequest = { path: string; journey: string | null; at: number };
function isGatewayRequest(value: unknown): value is GatewayRequest {
  return Boolean(value) && typeof value === "object" && value !== null && "path" in value && typeof value.path === "string"
    && "journey" in value && (value.journey === null || typeof value.journey === "string") && "at" in value && typeof value.at === "number";
}

/**
 * A signed-out desktop whose free Auto relay points at a loopback Gateway witness. The witness records only the
 * request path and the analytics journey header, so the proof can show when the identifier is sent.
 */
export async function freeAutoAnalyticsOptOutWorld(seed: Seed) {
  const port = await allocateFreePort();
  const gatewayOrigin = `http://127.0.0.1:${port}`;
  const witness = spawn(process.execPath, ["evals/packages/labs/src/free-auto-gateway-witness.mjs", String(port)], { cwd: root, stdio: "ignore" });
  try {
    const deadline = Date.now() + 30_000;
    while (!(await fetch(`${gatewayOrigin}/health`).then((response) => response.ok).catch(() => false))) {
      if (Date.now() > deadline) throw new Error("The free Auto Gateway witness did not start");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const workspacePath = seed.tmpPath("free-auto-analytics");
    const app = await seed.desktop({ name: "free-auto-analytics", workspacePath, env: {
      OPENWORK_DEV_MODE: "1", OPENWORK_FREE_INFERENCE_ORIGIN: gatewayOrigin,
      // Eval desktops switch free Auto off by default; this world needs the relay running.
      VITE_DISABLE_OPENWORK_MODELS: "0",
    } });
    return {
      app,
      /** Every free Auto status request the Gateway received, oldest first. */
      async gatewayRequests(): Promise<GatewayRequest[]> {
        const body: unknown = await (await fetch(`${gatewayOrigin}/requests`)).json();
        return Array.isArray(body) ? body.filter(isGatewayRequest) : [];
      },
      /** The same forced status check the app runs on "Retry" or before a send. */
      async checkFreeAuto(): Promise<{ status: number; state: string | null }> {
        // TODO(primitive): no channel asks the local relay for a fresh status; this is the app's own preflight call.
        return seed.evalIn(app, browserScript(async () => {
          const port = localStorage.getItem("openwork.server.port");
          const token = localStorage.getItem("openwork.server.token");
          if (!port || !token) throw new Error("The desktop's local server is not ready");
          const response = await fetch(`http://127.0.0.1:${port}/anonymous-inference/preflight`, {
            method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
          });
          const body: unknown = await response.json().catch(() => null);
          const state = body && typeof body === "object" && "state" in body && typeof body.state === "string" ? body.state : null;
          return { status: response.status, state };
        }, []), { awaitPromise: true, timeoutMs: 30_000 });
      },
      async openPreferences() { await go(app, "/settings/preferences"); },
      async [Symbol.asyncDispose]() { witness.kill("SIGTERM"); },
    };
  } catch (error) {
    witness.kill("SIGTERM");
    throw error;
  }
}
