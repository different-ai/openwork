import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { attachSurface, evaluateOnSurface } from "@openwork/cdp";
import type { AttachedSurface, SurfaceHandle } from "@openwork/cdp";
import { SkipError } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { localHost } from "@openwork/hosts";
import type { ElectronSurfaceOptions } from "@openwork/hosts";

/**
 * A packaged enterprise desktop on a machine that has never run OpenWork,
 * booted behind a logging forward proxy that refuses everything. Before the
 * person enters their workspace address the install knows no organization
 * server, so any request that leaves loopback goes to a host nobody chose:
 * the hosted runtime-config probe, PostHog analytics, Cloud inventory.
 *
 * The witness is Chromium's `--proxy-server` switch, which the desktop accepts
 * through ELECTRON_EXTRA_LAUNCH_ARGS. Every renderer `fetch`, every
 * main-process `net.fetch` (the `__fetch` bridge Den calls use) and
 * electron-updater all go through Chromium's network stack, so each request
 * for a non-loopback host arrives here as either a plain request with an
 * absolute URL or a `CONNECT host:443` tunnel for HTTPS. Loopback is bypassed
 * by Chromium's implicit proxy rules and never shows up. The proxy answers
 * 403 and closes, so nothing actually leaves the machine during the run.
 *
 * Not covered: Node's own `fetch` in the main process ignores Chromium proxy
 * switches. The desktop only uses it for its loopback local server.
 */

export interface EgressRequest {
  /** HTTP method; `CONNECT` for an HTTPS tunnel. */
  method: string;
  /** `host:port` for CONNECT, the absolute URL otherwise. */
  target: string;
  /** Hostname the request was for, lower-cased. */
  host: string;
  at: string;
}

function hostOf(method: string, target: string): string {
  if (method === "CONNECT") return target.replace(/:\d+$/, "").toLowerCase();
  try {
    return new URL(target).hostname.toLowerCase();
  } catch {
    return target.toLowerCase();
  }
}

export async function startEgressWitness(): Promise<{
  port: number;
  requests: EgressRequest[];
  close(): Promise<void>;
}> {
  const requests: EgressRequest[] = [];
  const record = (method: string, target: string) => {
    requests.push({ method, target, host: hostOf(method, target), at: new Date().toISOString() });
  };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    record(request.method ?? "GET", request.url ?? "");
    response.writeHead(403, { "Content-Type": "text/plain", Connection: "close" });
    response.end("egress refused by test witness");
  });
  server.on("connect", (request: IncomingMessage, socket: Duplex) => {
    record("CONNECT", request.url ?? "");
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Egress witness did not bind a TCP port");
  }
  return {
    port: address.port,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

async function launchPackagedEnterprise(name: string, bootstrap?: ElectronSurfaceOptions["bootstrap"]) {
  if (!process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim()) {
    throw new SkipError("OPENWORK_EVAL_ELECTRON_BINARY points at a packaged enterprise desktop binary");
  }
  const witness = await startEgressWitness();
  const host = localHost();
  let handle: SurfaceHandle;
  try {
    handle = await host.spawnElectron(name, {
      profile: "fresh",
      prepareSharedResources: false,
      env: {
        OPENWORK_DEV_MODE: "0",
        OPENWORK_ELECTRON_START_URL: "",
        ELECTRON_START_URL: "",
        ELECTRON_EXTRA_LAUNCH_ARGS: `--proxy-server=http://127.0.0.1:${witness.port}`,
      },
      ...(bootstrap ? { bootstrap } : {}),
    });
  } catch (error) {
    await witness.close().catch(() => undefined);
    throw error;
  }
  let app: AttachedSurface | null = null;
  const dispose = async () => {
    try {
      await app?.stop();
    } finally {
      try {
        await host.disposeSurface(handle);
      } finally {
        await witness.close();
      }
    }
  };
  try {
    app = await attachSurface(handle, { timeoutMs: 60_000 });
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  const attached = app;
  return {
    app: attached,
    /** Flavor baked into the packaged artifact, as the renderer sees it. */
    flavor: () => evaluateOnSurface(attached, (): string | null => {
      const electron: unknown = Reflect.get(window, "__OPENWORK_ELECTRON__");
      if (typeof electron !== "object" || electron === null) return null;
      const meta: unknown = Reflect.get(electron, "meta");
      if (typeof meta !== "object" || meta === null) return null;
      const distribution: unknown = Reflect.get(meta, "distribution");
      if (typeof distribution !== "object" || distribution === null) return null;
      const flavor: unknown = Reflect.get(distribution, "flavor");
      return typeof flavor === "string" ? flavor : null;
    }),
    /** Text React actually mounted, as opposed to the body chrome. */
    rootText: () => evaluateOnSurface(attached, () => document.getElementById("root")?.innerText ?? ""),
    /** Every non-loopback request the desktop has made so far, in order. */
    egress: () => [...witness.requests],
    [Symbol.asyncDispose]: dispose,
  };
}

/** First launch on a machine that has never run OpenWork: no bootstrap, so activation is required. */
export function packagedPreactivationEgressWorld(_seed: Seed) {
  return launchPackagedEnterprise("packaged-preactivation-egress");
}

/**
 * Organization server used as the submitted workspace address. It is never
 * resolved: with a proxy configured Chromium hands the hostname to the proxy,
 * which refuses it, so the address is deterministic on any network.
 */
export const SUBMITTED_WORKSPACE_ADDRESS = "https://den.example.test";

/**
 * Positive control: the same binary already activated against a Den on that
 * unreachable host. Activation completes at boot, so the requests the fresh
 * install must hold back are expected here and prove the witness sees them.
 */
export function packagedActivatedEgressWorld(_seed: Seed) {
  return launchPackagedEnterprise("packaged-activated-egress", {
    baseUrl: SUBMITTED_WORKSPACE_ADDRESS,
    requireSignin: true,
    enterpriseActivation: { activatedAt: "2026-01-01T00:00:00.000Z", denBaseUrl: SUBMITTED_WORKSPACE_ADDRESS },
  });
}
