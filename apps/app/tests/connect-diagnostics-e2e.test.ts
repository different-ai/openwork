import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  connectDiagnosticClientBatchSchema,
} from "@openwork/types/den/connect-diagnostics";

import {
  desktopConnectDiagnosticIncidents,
  denMcpDiagnosticIncident,
} from "../../../ee/apps/den-api/src/connect-diagnostic-contract";
import { POST as diagnosticsIntake } from "../../../ee/apps/diagnostics/app/api/connections/incidents/route";
import {
  connectionIncidentFilters,
  filterConnectionIncidents,
} from "../../../ee/apps/diagnostics/src/connection-incident-query";
import {
  clearConnectDiagnosticIncidents,
  listConnectDiagnosticIncidents,
} from "../../../ee/apps/diagnostics/src/connection-incident-store";
import {
  connectDiagnosticsTesting,
  flushConnectDiagnosticQueue,
  recordConnectDiagnosticAttempt,
} from "../src/react-app/domains/connections/connect-diagnostics-reporter";
import { CONNECT_DIAGNOSTIC_CLIENT_ID_KEY } from "../src/react-app/domains/connections/connect-diagnostics-preferences";

const originalEnvironment = { ...process.env };
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;
const bearerToken = "synthetic-e2e-connect-diagnostics-bearer";
const organizationId = "org_e2e_customer";
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
  baseUrl: "https://private-den.example",
  authToken: "private-user-session",
  activeOrgId: organizationId,
  activeOrgSlug: "e2e-customer",
  activeOrgName: "E2E Customer",
};

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the desktop delivery attempt.");
}

describe("Connect incident telemetry end-to-end", () => {
  beforeEach(async () => {
    storage.clear();
    process.env = { ...originalEnvironment };
    process.env.DIAGNOSTICS_MCP_BEARER_TOKEN = bearerToken;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: localStorageStub },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { platform: "Linux x86_64" },
    });
    await clearConnectDiagnosticIncidents();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
    await clearConnectDiagnosticIncidents();
    process.env = { ...originalEnvironment };
  });

  test("correlates an offline desktop failure with the Den lifecycle view using only pseudonyms", async () => {
    let deliveryEnabled = false;
    let desktopRequests = 0;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      desktopRequests += 1;
      if (!deliveryEnabled) return new Response(null, { status: 503 });

      const batch = connectDiagnosticClientBatchSchema.parse(await request.json());
      const authenticatedOrg = request.headers.get("x-openwork-legacy-org-id");
      expect(authenticatedOrg).toBe(organizationId);
      const incidents = desktopConnectDiagnosticIncidents({
        organizationId: authenticatedOrg as string,
        events: batch.events,
        bearerToken,
      });
      return diagnosticsIntake(new Request(
        "https://diagnostics.example/api/connections/incidents",
        {
          body: JSON.stringify({ incidents }),
          headers: {
            authorization: `Bearer ${bearerToken}`,
            "content-type": "application/json",
          },
          method: "POST",
        },
      ));
    };

    recordConnectDiagnosticAttempt({
      outcome: "failed",
      health: null,
      issue: {
        code: "cloud_connection_failed",
        stage: "transport_auth",
        retryable: true,
        requestId: "req_shared_correlation",
        details: {
          transport: {
            code: "ETIMEDOUT",
            status: 504,
            message: "private customer network path",
          },
        },
      },
      maintenanceAttempt: 1,
    }, settings);
    await waitFor(() => desktopRequests > 0);
    await flushConnectDiagnosticQueue(settings).catch(() => 0);

    expect(connectDiagnosticsTesting.readQueue()).toHaveLength(1);
    deliveryEnabled = true;
    expect(await flushConnectDiagnosticQueue(settings)).toBe(1);
    expect(connectDiagnosticsTesting.readQueue()).toEqual([]);

    const desktopIncident = (await listConnectDiagnosticIncidents())[0];
    expect(desktopIncident).toMatchObject({
      source: "desktop",
      phase: "transport_auth",
      outcome: "failure",
      errorCode: "cloud_connection_failed",
      networkCode: "ETIMEDOUT",
      httpStatus: 504,
      serverRequestId: "req_shared_correlation",
    });

    const clientId = storage.get(CONNECT_DIAGNOSTIC_CLIENT_ID_KEY);
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/u);
    const denIncident = denMcpDiagnosticIncident({
      organizationId,
      clientId: clientId as string,
      requestId: "req_den_initialize",
      method: "initialize",
      observedAt: new Date().toISOString(),
      durationMs: 80,
      outcome: "ok",
      httpStatus: 200,
      errorCode: null,
      bearerToken,
      serverVersion: "0.17.40",
    });
    expect((await diagnosticsIntake(new Request(
      "https://diagnostics.example/api/connections/incidents",
      {
        body: JSON.stringify({ incidents: [denIncident] }),
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
        },
        method: "POST",
      },
    ))).status).toBe(204);

    const incidents = await listConnectDiagnosticIncidents();
    expect(incidents).toHaveLength(2);
    expect(new Set(incidents.map((incident) => incident.source))).toEqual(new Set(["desktop", "den"]));
    expect(new Set(incidents.map((incident) => incident.organizationHash)).size).toBe(1);
    expect(new Set(incidents.map((incident) => incident.clientHash)).size).toBe(1);
    expect(JSON.stringify(incidents)).not.toContain(organizationId);
    expect(JSON.stringify(incidents)).not.toContain(settings.authToken);
    expect(JSON.stringify(incidents)).not.toContain("private customer network path");

    const customerTimeline = filterConnectionIncidents(
      incidents,
      connectionIncidentFilters({
        organization: desktopIncident?.organizationHash,
        client: desktopIncident?.clientHash ?? undefined,
        hours: "168",
      }),
    );
    expect(customerTimeline).toHaveLength(2);
  });
});
