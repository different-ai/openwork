import assert from "node:assert/strict";
import test from "node:test";

import { EvalError } from "./context.ts";
import { isFlowDefinition } from "./runner.ts";
import {
  extractInviteFromHtml,
  extractInviteFromPayload,
  inviteUrlFromToken,
  resolveDenApiUrl,
  resolveDenWebUrl,
  validateActor,
} from "./journeys/den.ts";
import { hostileGatewayBunPrecondition, hostileGatewayCaseById, hostileGatewayFaultCases, hostileGatewayFaultIds } from "./journeys/gateway.ts";
import { capabilityMatchesFromSearchResult, mcpTextContent } from "./journeys/mcp.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("Den URL helpers trim bases and build invite URLs", () => {
  const env: NodeJS.ProcessEnv = {
    OPENWORK_EVAL_DEN_API_URL: " http://127.0.0.1:3004/api/den/// ",
    OPENWORK_EVAL_DEN_WEB_URL: " http://127.0.0.1:3005/// ",
  };

  assert.equal(resolveDenApiUrl(env), "http://127.0.0.1:3004/api/den");
  assert.equal(resolveDenWebUrl(env), "http://127.0.0.1:3005");
  assert.equal(inviteUrlFromToken(resolveDenWebUrl(env), "tok/one"), "http://127.0.0.1:3005/join-org?invite=tok%2Fone");
});

test("invite extraction rewrites email HTML links onto the driven Den Web origin", () => {
  const html = `<p>Join</p><a href="https://email-origin.example/join-org?invite=abc123&amp;utm=mail">Accept invite</a>`;
  const invite = extractInviteFromHtml(html, "http://localhost:3005/");

  assert.equal(invite.token, "abc123");
  assert.equal(invite.inviteUrl, "http://localhost:3005/join-org?invite=abc123&utm=mail");
});

test("invite extraction accepts JSON payload links and tokens", () => {
  const fromLink = extractInviteFromPayload({ invitation: { inviteLink: "/join-org?invite=json-token" } }, "http://den.test");
  const fromToken = extractInviteFromPayload({ invitationId: "inv_1", inviteToken: "payload-token" }, "http://den.test/");

  assert.equal(fromLink.token, "json-token");
  assert.equal(fromLink.inviteUrl, "http://den.test/join-org?invite=json-token");
  assert.equal(fromToken.token, "payload-token");
  assert.equal(fromToken.inviteUrl, "http://den.test/join-org?invite=payload-token");
});

test("Den env resolution reports missing URLs clearly", () => {
  assert.throws(
    () => resolveDenApiUrl({}),
    (error) => error instanceof EvalError && error.message.includes("OPENWORK_EVAL_DEN_API_URL"),
  );
  assert.throws(
    () => resolveDenWebUrl({ OPENWORK_EVAL_DEN_API_URL: "http://api.test" }),
    (error) => error instanceof EvalError && error.message.includes("OPENWORK_EVAL_DEN_WEB_URL"),
  );
});

test("actor validation accepts complete actors and rejects incomplete shapes", () => {
  const actor = {
    name: "Maya",
    email: "maya@example.test",
    password: "OpenWorkEval123!",
    role: "fresh",
  };

  assert.deepEqual(validateActor(actor), actor);
  assert.throws(
    () => validateActor({ email: "missing@example.test", role: "fresh" }),
    (error) => error instanceof EvalError && error.message.includes("name, email, password, and role"),
  );
});

test("hostile gateway journey exposes the required app-less fault cases", () => {
  assert.deepEqual(hostileGatewayFaultIds, [
    "redirect-uri-whitelist",
    "per-connector-redirect",
    "dcr-required",
    "method-405",
    "duplicate-amplification",
    "refresh-expired",
    "trailing-dot-url",
    "per-user-403",
  ]);
  assert.equal(hostileGatewayFaultCases.length, hostileGatewayFaultIds.length);
  assert.equal(hostileGatewayCaseById("method-405").expectedProductSnippets.includes("GET /mcp count 0"), true);
});

test("hostile gateway precondition reports an actionable bun skip reason", async () => {
  const reason = await hostileGatewayBunPrecondition("__openwork_missing_bun__");

  assert.equal(typeof reason, "string");
  assert.match(reason || "", /bun is required/);
});

test("hostile-gateway-mcp flow is app-less and has one step per hostile case", async () => {
  const flowModule: unknown = await import(new URL("../flows/hostile-gateway-mcp.flow.ts", import.meta.url).href);
  const flow = isRecord(flowModule) ? flowModule.default : undefined;

  assert(isFlowDefinition(flow));
  assert.equal(flow.id, "hostile-gateway-mcp");
  assert.equal(flow.requiresApp, false);
  assert.equal(typeof flow.precondition, "function");
  assert.deepEqual(flow.steps.map((step) => step.name), hostileGatewayFaultIds);
});

test("MCP journey helpers read text content and search_capabilities matches", () => {
  const searchResult = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          matches: [
            {
              name: "mcp:connection:mock_echo",
              summary: "Mock echo from reliability connection",
              schemaDigest: "digest-1",
              argumentsSchema: { type: "object" },
            },
          ],
        }),
      },
    ],
  };

  assert.equal(mcpTextContent({ content: [{ type: "text", text: "hello" }] }), "hello");
  assert.deepEqual(capabilityMatchesFromSearchResult(searchResult), [
    {
      name: "mcp:connection:mock_echo",
      summary: "Mock echo from reliability connection",
      schemaDigest: "digest-1",
      argumentsSchema: { type: "object" },
    },
  ]);
});
