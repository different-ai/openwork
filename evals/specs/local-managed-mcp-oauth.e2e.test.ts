import { expect } from "vitest";
import { evalIn } from "@openwork/behaviors";
import { app, mcpMock, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_LOCAL_MANAGED_MCP"],
  placement: "local",
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Local managed MCP OAuth skipped — needs: ${missingRequirements.join(", ")}`
  : "OpenWork owns local MCP OAuth while OpenCode consumes the gateway tools";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: {
      name: `Local managed MCP OAuth ${Date.now()}`,
      admin: { name: "Sarah" },
    },
    mocks: {
      connector: mcpMock(),
    },
  });
  await using desktop = await app({ den, as: "admin", place });
  const name = `local-managed-${Date.now()}`;

  const started = await evalIn(desktop, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    const baseUrl = String(info?.baseUrl ?? info?.connectUrl ?? "").replace(/\\/+$/, "");
    const token = String(info?.ownerToken ?? info?.clientToken ?? "");
    if (!baseUrl || !token) return { ok: false, error: "Local server credentials unavailable" };
    const response = await fetch(
      baseUrl + "/workspace/${encodeURIComponent(desktop.workspaceId)}/mcp/managed",
      {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({
          name: ${JSON.stringify(name)},
          url: ${JSON.stringify(den.mocks.connector.mcpUrl)},
          oauth: { applicationType: "native", requestedScopes: ["mcp:read", "mcp:write"] },
        }),
      },
    );
    return { ok: response.ok, status: response.status, baseUrl, body: await response.json() };
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  expect(isRecord(started)).toBe(true);
  if (!isRecord(started) || !isRecord(started.body)) throw new Error("Managed MCP start response was invalid");
  expect(started.status).toBe(201);
  expect(started.body.status).toBe("needs_auth");
  expect(typeof started.body.authorizeUrl).toBe("string");

  const authorization = await fetch(String(started.body.authorizeUrl), { redirect: "manual" });
  expect(authorization.status).toBe(302);
  const callbackUrl = authorization.headers.get("location");
  expect(callbackUrl).toBeTruthy();
  const callback = await fetch(callbackUrl!);
  expect(callback.ok).toBe(true);

  const connected = await evalIn(desktop, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    const baseUrl = String(info?.baseUrl ?? info?.connectUrl ?? "").replace(/\\/+$/, "");
    const token = String(info?.ownerToken ?? info?.clientToken ?? "");
    const response = await fetch(
      baseUrl + "/workspace/${encodeURIComponent(desktop.workspaceId)}/mcp/${encodeURIComponent(name)}/managed",
      { headers: { authorization: "Bearer " + token } },
    );
    return { ok: response.ok, body: await response.json() };
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(isRecord(connected)).toBe(true);
  if (!isRecord(connected) || !isRecord(connected.body)) throw new Error("Managed MCP status response was invalid");
  expect(connected.body).toMatchObject({ status: "connected", hasCredential: true, enabled: true });

  evidence.recordAssertionEvidence(
    "The desktop's embedded OpenWork server owns the provider OAuth callback and credential",
    `Created ${name}; the provider redirected to the local callback; public state reported connected with a credential present.`,
    connected.body.status === "connected" && connected.body.hasCredential === true,
  );
});
