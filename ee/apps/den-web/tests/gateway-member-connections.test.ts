import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as requests from "../app/(den)/_lib/den-flow";
import { getModelConnectionsRoute, getOrgAccessFlags } from "../app/(den)/_lib/den-org";
import { buildDashboardNavSections } from "../app/(den)/dashboard/_lib/dashboard-navigation";
import {
  disconnectGatewayMemberConnection, gatewayMemberConnectionKey, gatewayMemberAuthorizationCompleted,
  loadGatewayMemberConnections, startGatewayMemberConnection, type GatewayMemberConnection,
} from "../app/(den)/dashboard/_components/gateway-member-connections-data";

const row: GatewayMemberConnection = {
  providerId: "ipr_00000000000000000000000001", credentialSetId: "gcs_00000000000000000000000002",
  providerName: "Vertex", name: "Personal Google", ready: false, hasAccess: true, hasCredential: false,
  authorizationRevision: null, accountEmail: null, configurationRequired: false,
};
const reply = (payload: unknown, status = 200) => ({ payload, response: new Response(null, { status }), text: JSON.stringify(payload) });
afterEach(() => mock.restore());

describe("member model connections", () => {
  test("reads all explicit member sets including no-token and retained credentials after access loss", async () => {
    const retained: GatewayMemberConnection = {
      ...row, credentialSetId: "gcs_00000000000000000000000003", hasAccess: false, hasCredential: true,
      authorizationRevision: "revision-old", accountEmail: "member@example.test",
    };
    const request = spyOn(requests, "requestJson").mockResolvedValue(reply({ connections: [row, retained] }));
    const result = await loadGatewayMemberConnections("org_fixture");
    expect(result).toEqual([row, retained]);
    expect(result.map(gatewayMemberConnectionKey)).toEqual([
      `${row.providerId}:${row.credentialSetId}`, `${retained.providerId}:${retained.credentialSetId}`,
    ]);
    expect(request.mock.calls[0]?.[0]).toBe("/v1/inference-providers/member-connections");
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("x-openwork-org-id")).toBe("org_fixture");
    request.mockResolvedValue(reply({ connections: [] }));
    expect(await loadGatewayMemberConnections("org_fixture")).toEqual([]);
  });

  test("defaults the administrator-repair flag for older inventories and reads explicit configuration failures", async () => {
    const { configurationRequired, ...legacy } = row;
    expect(configurationRequired).toBe(false);
    const request = spyOn(requests, "requestJson").mockResolvedValue(reply({ connections: [legacy] }));
    expect(await loadGatewayMemberConnections("org_fixture")).toEqual([row]);
    const blocked = { ...row, hasCredential: true, configurationRequired: true };
    request.mockResolvedValue(reply({ connections: [blocked] }));
    expect(await loadGatewayMemberConnections("org_fixture")).toEqual([blocked]);
  });

  test("blocks OAuth starts for known client failures while retaining Disconnect", async () => {
    const request = spyOn(requests, "requestJson").mockResolvedValue(reply(null, 204));
    const blocked = { ...row, hasCredential: true, configurationRequired: true };
    const signal = new AbortController().signal;
    await expect(startGatewayMemberConnection("org_fixture", blocked, signal)).rejects.toThrow("Administrator action required");
    expect(request).not.toHaveBeenCalled();
    await disconnectGatewayMemberConnection("org_fixture", blocked, signal);
    expect(request.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  test("rejects failures and malformed metadata rather than deriving an aggregate connection state", async () => {
    const request = spyOn(requests, "requestJson").mockResolvedValue(reply({ error: "forbidden" }, 403));
    await expect(loadGatewayMemberConnections("org_fixture")).rejects.toThrow();
    for (const payload of [
      { inferenceProviders: [] }, { connections: [{}] },
      { connections: [{ ...row, hasAccess: "true" }] },
      { connections: [{ ...row, configurationRequired: "true" }] },
      { connections: [{ ...row, authorizationRevision: 42 }] },
      { connections: [{ ...row, accountEmail: undefined }] },
    ]) {
      request.mockResolvedValue(reply(payload));
      await expect(loadGatewayMemberConnections("org_fixture")).rejects.toThrow("invalid connection inventory");
    }
  });

  test("first connection and reconnect require a ready token with a new completed-authorization revision", () => {
    const connected = { ...row, ready: true, hasCredential: true, authorizationRevision: "revision-new" };
    expect(gatewayMemberAuthorizationCompleted(connected, null)).toBe(true);
    expect(gatewayMemberAuthorizationCompleted(connected, "revision-old")).toBe(true);
    expect(gatewayMemberAuthorizationCompleted(connected, "revision-new")).toBe(false);
    expect(gatewayMemberAuthorizationCompleted({ ...connected, ready: false }, "revision-old")).toBe(false);
    expect(gatewayMemberAuthorizationCompleted({ ...connected, configurationRequired: true }, "revision-old")).toBe(false);
    expect(gatewayMemberAuthorizationCompleted({ ...connected, authorizationRevision: null }, "revision-old")).toBe(false);
    expect(gatewayMemberAuthorizationCompleted({ ...connected, accountEmail: "changed@example.test" }, "revision-new")).toBe(false);
  });

  test("starts and disconnects only the selected set; preserves the server bridge URL", async () => {
    const authUrl = "https://den.example.test/gateway/connect?attempt=fixture%2Bvalue";
    const request = spyOn(requests, "requestJson").mockResolvedValue(reply({ authUrl }));
    const controller = new AbortController();
    expect(await startGatewayMemberConnection("org_fixture", row, controller.signal)).toBe(authUrl);
    expect(request.mock.calls[0]?.[0]).toBe(`/v1/inference-providers/${row.providerId}/oauth/start?credentialSetId=${row.credentialSetId}`);
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("accept")).toBe("application/json");
    request.mockResolvedValue(reply(null, 204));
    await disconnectGatewayMemberConnection("org_fixture", row, controller.signal);
    expect(request.mock.calls[1]?.[0]).toBe(`/v1/inference-providers/${row.providerId}/oauth?credentialSetId=${row.credentialSetId}`);
    expect(request.mock.calls[1]?.[1]?.method).toBe("DELETE");
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get("x-openwork-org-id")).toBe("org_fixture");
    expect(request.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("denies Connect without access but permits revoking the caller's retained credential", async () => {
    const request = spyOn(requests, "requestJson").mockResolvedValue(reply(null, 204));
    const retained = { ...row, hasAccess: false, hasCredential: true, authorizationRevision: "revision-old" };
    const signal = new AbortController().signal;
    await expect(startGatewayMemberConnection("org_fixture", retained, signal)).rejects.toThrow("Access to this credential set was removed");
    expect(request).not.toHaveBeenCalled();
    await disconnectGatewayMemberConnection("org_fixture", retained, signal);
    expect(request.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  test("is a member route independent of admin management and ready model inventory", () => {
    expect(getModelConnectionsRoute("example")).toBe("/dashboard/model-connections");
    const nav = buildDashboardNavSections({ orgSlug: "example", access: getOrgAccessFlags("member", false),
      capabilities: { cloud: false, installLinks: false, mcpConnections: false, openworkWeb: false, orgManagedDashboards: false, workflows: false },
      orgMode: "single_org", runtimeConfigLoaded: true,
    });
    expect(nav.flatMap((section) => section.items).some((item) => item.href === getModelConnectionsRoute())).toBe(true);
    expect(nav.flatMap((section) => section.items).some((item) => item.label === "AI Gateway")).toBe(false);
    const shell = readFileSync(new URL("../app/(den)/dashboard/_components/org-dashboard-shell.tsx", import.meta.url), "utf8");
    expect(shell).toContain("pathname.startsWith(getModelConnectionsRoute(orgSlug))");
    expect(shell).toContain('return "My Model Connections"');
    const page = readFileSync(new URL("../app/(den)/dashboard/model-connections/page.tsx", import.meta.url), "utf8");
    expect(page).toContain("GatewayMemberConnectionsScreen");
    expect(page).not.toContain("CapabilityGuard");
    const screen = readFileSync(new URL("../app/(den)/dashboard/_components/gateway-member-connections-screen.tsx", import.meta.url), "utf8");
    expect(screen).toContain('key={`${orgId}:${user?.id}`}');
    expect(screen).toContain("action.current?.abort()");
    expect(screen).toContain("gatewayMemberAuthorizationCompleted(current, pending.authorizationRevision)");
    expect(screen).toContain("Refresh status");
    expect(screen).toContain("Stop waiting");
    expect(screen).not.toContain("useSearchParams");
    expect(screen).not.toContain("credentialMode");
  });
});
