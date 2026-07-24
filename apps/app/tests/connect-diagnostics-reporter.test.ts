import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LOCAL_PREFERENCES_KEY } from "../src/react-app/kernel/local-preferences-storage";
import {
  CONNECT_DIAGNOSTIC_CLIENT_ID_KEY,
  CONNECT_DIAGNOSTIC_FAILURE_STATE_KEY,
  CONNECT_DIAGNOSTIC_QUEUE_KEY,
  clearConnectDiagnosticLocalData,
  getConnectDiagnosticsClientId,
  isConnectDiagnosticsEnabled,
} from "../src/react-app/domains/connections/connect-diagnostics-preferences";
import {
  connectDiagnosticsTesting,
  flushConnectDiagnosticQueue,
  recordConnectDiagnosticAttempt,
} from "../src/react-app/domains/connections/connect-diagnostics-reporter";
import { buildOpenworkCloudMcpReconcilePayload } from "../src/react-app/domains/connections/cloud-mcp-reconciler";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;
const storage = new Map<string, string>();

const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};

const settings = {
  baseUrl: "https://customer-den.example",
  authToken: "private-den-session-token",
  activeOrgId: "org_customer_identity",
  activeOrgSlug: "customer",
  activeOrgName: "Customer",
};

function installBrowserRuntime() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: localStorageStub },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "MacIntel" },
  });
}

function enableConnectDiagnostics() {
  storage.set(LOCAL_PREFERENCES_KEY, JSON.stringify({ connectionDiagnosticsEnabled: true }));
}

describe("desktop Connect diagnostics reporter", () => {
  beforeEach(() => {
    storage.clear();
    installBrowserRuntime();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
  });

  test("is disabled by default and creates no identifier, queue, header, or request", async () => {
    const requests: Request[] = [];
    globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 204 });
    };

    expect(isConnectDiagnosticsEnabled()).toBe(false);
    expect(getConnectDiagnosticsClientId()).toBeNull();

    recordConnectDiagnosticAttempt({
      outcome: "failed",
      health: null,
      issue: {
        code: "cloud_connection_failed",
        stage: "transport_auth",
        retryable: true,
      },
      maintenanceAttempt: 1,
    }, settings);
    await expect(flushConnectDiagnosticQueue(settings)).resolves.toBe(0);

    const payload = buildOpenworkCloudMcpReconcilePayload({
      context: {
        denBaseUrl: settings.baseUrl,
        serverBaseUrl: "http://127.0.0.1:8787",
        orgId: settings.activeOrgId,
        workspaceId: "workspace_1",
        denAuthToken: settings.authToken,
      },
      token: {
        token: "private-mcp-token",
        expiresAt: "2026-07-31T10:00:00.000Z",
        organizationId: settings.activeOrgId,
        resource: "https://customer-den.example/mcp",
        scopes: ["mcp:read", "mcp:write"],
      },
    });

    expect(requests).toEqual([]);
    expect(storage.has(CONNECT_DIAGNOSTIC_CLIENT_ID_KEY)).toBe(false);
    expect(storage.has(CONNECT_DIAGNOSTIC_QUEUE_KEY)).toBe(false);
    expect(storage.has(CONNECT_DIAGNOSTIC_FAILURE_STATE_KEY)).toBe(false);
    expect(payload?.config.headers).toEqual({
      Authorization: "Bearer private-mcp-token",
    });

    storage.set(LOCAL_PREFERENCES_KEY, "{invalid");
    expect(isConnectDiagnosticsEnabled()).toBe(false);
    expect(getConnectDiagnosticsClientId()).toBeNull();
  });

  test("queues only allowlisted metadata, retains an offline report, then sends no raw customer identity", async () => {
    enableConnectDiagnostics();
    globalThis.fetch = async () => new Response(null, { status: 503 });

    recordConnectDiagnosticAttempt({
      outcome: "failed",
      health: null,
      issue: {
        code: "cloud_connection_failed",
        stage: "transport_auth",
        retryable: true,
        requestId: "req_safe_correlation",
        details: {
          cause: { code: "ECONNRESET", message: "socket reset for secret@example.com" },
          response: { status: 404, body: "customer payload must not escape" },
        },
      },
      maintenanceAttempt: 2,
    }, settings);
    await flushConnectDiagnosticQueue(settings).catch(() => 0);

    const queued = connectDiagnosticsTesting.readQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.event).toMatchObject({
      phase: "transport_auth",
      outcome: "failure",
      errorCode: "cloud_connection_failed",
      networkCode: "ECONNRESET",
      httpStatus: 404,
      retryable: true,
      consecutiveFailures: 1,
      maintenanceAttempt: 2,
      serverRequestId: "req_safe_correlation",
    });
    const eventText = JSON.stringify(queued[0]?.event);
    expect(eventText).not.toContain("secret@example.com");
    expect(eventText).not.toContain("customer payload");
    expect(eventText).not.toContain(settings.activeOrgId);
    expect(eventText).not.toContain(settings.authToken);

    const requests: Request[] = [];
    globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 204 });
    };
    await expect(flushConnectDiagnosticQueue(settings)).resolves.toBe(1);

    expect(connectDiagnosticsTesting.readQueue()).toEqual([]);
    expect(requests).toHaveLength(1);
    const request = requests[0] as Request;
    const body = await request.text();
    expect(request.headers.get("authorization")).toBe(`Bearer ${settings.authToken}`);
    expect(request.headers.get("x-openwork-legacy-org-id")).toBe(settings.activeOrgId);
    expect(body).not.toContain(settings.activeOrgId);
    expect(body).not.toContain(settings.authToken);
    expect(body).not.toContain("secret@example.com");
  });

  test("reports recovery only after a failure and disabling erases local state", async () => {
    enableConnectDiagnostics();
    globalThis.fetch = async () => new Response(null, { status: 503 });

    recordConnectDiagnosticAttempt({
      outcome: "ready",
      health: null,
      maintenanceAttempt: 1,
    }, settings);
    expect(connectDiagnosticsTesting.readQueue()).toEqual([]);

    recordConnectDiagnosticAttempt({
      outcome: "failed",
      health: null,
      issue: {
        code: "opencode_engine_unreachable",
        stage: "engine_delivery",
        retryable: true,
      },
      maintenanceAttempt: 1,
    }, settings);
    recordConnectDiagnosticAttempt({
      outcome: "ready",
      health: null,
      maintenanceAttempt: 1,
    }, settings);
    await flushConnectDiagnosticQueue(settings).catch(() => 0);

    expect(connectDiagnosticsTesting.readQueue().map((item) => item.event.outcome))
      .toEqual(["failure", "recovered"]);

    const stableId = getConnectDiagnosticsClientId();
    expect(stableId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(getConnectDiagnosticsClientId()).toBe(stableId);

    storage.set(LOCAL_PREFERENCES_KEY, JSON.stringify({ connectionDiagnosticsEnabled: false }));
    clearConnectDiagnosticLocalData();
    expect(storage.has(CONNECT_DIAGNOSTIC_CLIENT_ID_KEY)).toBe(false);
    expect(storage.has(CONNECT_DIAGNOSTIC_QUEUE_KEY)).toBe(false);
    expect(storage.has(CONNECT_DIAGNOSTIC_FAILURE_STATE_KEY)).toBe(false);
    expect(getConnectDiagnosticsClientId()).toBeNull();
  });

  test("extracts only allowlisted network and HTTP classifications", () => {
    expect(connectDiagnosticsTesting.networkCodeFrom({
      cause: { code: "CERT_HAS_EXPIRED", message: "private hostname" },
    })).toBe("CERT_HAS_EXPIRED");
    expect(connectDiagnosticsTesting.networkCodeFrom({ message: "fetch failed" })).toBe("FETCH_FAILED");
    expect(connectDiagnosticsTesting.networkCodeFrom({ code: "CUSTOM_SECRET_CODE" })).toBeNull();
    expect(connectDiagnosticsTesting.httpStatusFrom({ response: { status: 502 } })).toBe(502);
  });

  test("replaces an arbitrary content-like failure code instead of retaining it", async () => {
    enableConnectDiagnostics();
    globalThis.fetch = async () => new Response(null, { status: 503 });
    recordConnectDiagnosticAttempt({
      outcome: "failed",
      health: null,
      issue: {
        code: "member@example.com",
        stage: "transport_auth",
        retryable: false,
      },
      maintenanceAttempt: 1,
    }, settings);
    await flushConnectDiagnosticQueue(settings).catch(() => 0);

    expect(connectDiagnosticsTesting.readQueue()[0]?.event.errorCode).toBe("connect_failure");
    expect(JSON.stringify(connectDiagnosticsTesting.readQueue())).not.toContain("member@example.com");
  });

  test("adds the stable client correlation ID to the managed Cloud MCP config", () => {
    enableConnectDiagnostics();
    const clientId = getConnectDiagnosticsClientId();
    const payload = buildOpenworkCloudMcpReconcilePayload({
      context: {
        denBaseUrl: settings.baseUrl,
        serverBaseUrl: "http://127.0.0.1:8787",
        orgId: settings.activeOrgId,
        workspaceId: "workspace_1",
        denAuthToken: settings.authToken,
      },
      token: {
        token: "private-mcp-token",
        expiresAt: "2026-07-31T10:00:00.000Z",
        organizationId: settings.activeOrgId,
        resource: "https://customer-den.example/mcp",
        scopes: ["mcp:read", "mcp:write"],
      },
    });

    expect(payload?.config).toMatchObject({
      headers: {
        Authorization: "Bearer private-mcp-token",
        "x-openwork-connect-client": clientId,
      },
    });
  });

  test("does not lose an event queued while an earlier batch is in flight", async () => {
    enableConnectDiagnostics();
    let finishFirstRequest: ((response: Response) => void) | null = null;
    globalThis.fetch = async () => new Promise<Response>((resolve) => {
      finishFirstRequest = resolve;
    });

    recordConnectDiagnosticAttempt({
      outcome: "failed",
      health: null,
      issue: {
        code: "first_failure",
        stage: "engine_delivery",
        retryable: true,
      },
      maintenanceAttempt: 1,
    }, settings);
    const firstFlush = flushConnectDiagnosticQueue(settings);
    await Promise.resolve();
    expect(finishFirstRequest).not.toBeNull();

    recordConnectDiagnosticAttempt({
      outcome: "failed",
      health: null,
      issue: {
        code: "second_failure",
        stage: "transport_auth",
        retryable: true,
      },
      maintenanceAttempt: 2,
    }, settings);
    finishFirstRequest?.(new Response(null, { status: 204 }));
    await firstFlush;

    expect(connectDiagnosticsTesting.readQueue().map((item) => item.event.errorCode))
      .toEqual(["second_failure"]);

    globalThis.fetch = async () => new Response(null, { status: 204 });
    expect(await flushConnectDiagnosticQueue(settings)).toBe(1);
    expect(connectDiagnosticsTesting.readQueue()).toEqual([]);
  });
});
