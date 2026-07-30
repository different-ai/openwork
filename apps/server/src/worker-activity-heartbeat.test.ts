import { describe, expect, test } from "bun:test";
import {
  buildWorkerActivityHeartbeatPayload,
  parseSessionActivityAt,
  postWorkerActivityHeartbeat,
  resolveWorkerActivityHeartbeatConfig,
  startWorkerActivityHeartbeat,
  type WorkerActivityHeartbeatLogger,
} from "./worker-activity-heartbeat.js";
import type { ServerConfig } from "./types.js";

const enabledEnv = {
  DEN_ACTIVITY_HEARTBEAT_ENABLED: "true",
  DEN_RUNTIME_PROVIDER: "daytona",
  DEN_WORKER_ID: "worker-1",
  DEN_ACTIVITY_HEARTBEAT_URL: "https://den.test/heartbeat",
  DEN_ACTIVITY_HEARTBEAT_TOKEN: "secret-token",
};

function heartbeatConfig(overrides: Record<string, string | undefined> = {}) {
  return resolveWorkerActivityHeartbeatConfig({ ...enabledEnv, ...overrides });
}

function serverConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 30000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

async function waitFor(promise: Promise<void>) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("timed out waiting for heartbeat warning")), 1000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe("worker activity heartbeat", () => {
  const disabledCases: Array<{ name: string; override: Record<string, string | undefined> }> = [
    { name: "enabled flag", override: { DEN_ACTIVITY_HEARTBEAT_ENABLED: "0" } },
    { name: "runtime provider", override: { DEN_RUNTIME_PROVIDER: "docker" } },
    { name: "worker id", override: { DEN_WORKER_ID: "" } },
    { name: "heartbeat URL", override: { DEN_ACTIVITY_HEARTBEAT_URL: "" } },
    { name: "heartbeat token", override: { DEN_ACTIVITY_HEARTBEAT_TOKEN: "" } },
  ];

  for (const item of disabledCases) {
    test(`disables when ${item.name} gate fails`, () => {
      expect(heartbeatConfig(item.override).enabled).toBe(false);
    });
  }

  test("uses five-minute defaults when the gate passes", () => {
    const config = heartbeatConfig();
    expect(config.enabled).toBe(true);
    expect(config.intervalMs).toBe(5 * 60_000);
    expect(config.activeWindowMs).toBe(5 * 60_000);
  });

  test("prefers updated session activity and falls back to created", () => {
    expect(parseSessionActivityAt({ time: { updated: 2000, created: 1000 } })).toBe(2000);
    expect(parseSessionActivityAt({ time: { created: 1000 } })).toBe(1000);
  });

  test("sets isActiveRecently on both sides of the active window boundary", () => {
    const now = 10_000;
    const windowMs = 1000;
    expect(buildWorkerActivityHeartbeatPayload([{ time: { updated: now - windowMs } }], now, windowMs).isActiveRecently).toBe(true);
    expect(buildWorkerActivityHeartbeatPayload([{ time: { updated: now - windowMs - 1 } }], now, windowMs).isActiveRecently).toBe(false);
  });

  test("uses null lastActivityAt when there are no sessions", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(buildWorkerActivityHeartbeatPayload([], now, 1000)).toEqual({
      sentAt: "2026-01-01T00:00:00.000Z",
      isActiveRecently: false,
      lastActivityAt: null,
      openSessionCount: 0,
    });
  });

  test("posts the expected payload and headers", async () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const requests: Request[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(new Request(input, init));
      return new Response("ok");
    };

    await postWorkerActivityHeartbeat({
      config: heartbeatConfig({ DEN_ACTIVITY_WINDOW_SECONDS: "60" }),
      sessions: [{ time: { updated: now - 30_000 } }, { time: { created: now - 120_000 } }],
      fetchImpl,
      now: () => now,
    });

    const request = requests[0];
    if (!request) throw new Error("expected heartbeat request");
    expect(request.method).toBe("POST");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("Authorization")).toBe("Bearer secret-token");
    expect(await request.json()).toEqual({
      sentAt: "2026-01-01T00:00:00.000Z",
      isActiveRecently: true,
      lastActivityAt: "2025-12-31T23:59:30.000Z",
      openSessionCount: 2,
    });
  });

  test("logs and swallows non-OK responses from the scheduler", async () => {
    const warnings: Array<{ message: string; attributes?: Record<string, unknown> }> = [];
    let resolveWarning: () => void = () => undefined;
    const warned = new Promise<void>((resolve) => {
      resolveWarning = resolve;
    });
    const logger: WorkerActivityHeartbeatLogger = {
      log: (level, message, attributes) => {
        if (level !== "warn") return;
        warnings.push(attributes ? { message, attributes } : { message });
        resolveWarning();
      },
    };

    const handle = startWorkerActivityHeartbeat(serverConfig(), logger, {
      env: { ...enabledEnv, DEN_ACTIVITY_HEARTBEAT_INTERVAL_SECONDS: "60" },
      fetchImpl: async () => new Response("nope", { status: 503 }),
      listSessions: async () => [],
      now: () => Date.UTC(2026, 0, 1, 0, 0, 0),
    });

    try {
      expect(handle).not.toBeNull();
      await waitFor(warned);
    } finally {
      handle?.stop();
    }

    const warning = warnings[0];
    if (!warning) throw new Error("expected warning log");
    expect(warning.message).toBe("Worker activity heartbeat failed");
    expect(warning.attributes?.error).toBe("heartbeat_failed:503");
  });
});
