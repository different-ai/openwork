import { describe, expect, test } from "bun:test";

import {
  createAgentDiagnosticsEngineFetch,
  effectiveToolDecision,
  validateEffectiveEngineSnapshot,
} from "./agent-context-engine-inspection.js";

function fetchStub(run: (request: Request) => Response | Promise<Response>): typeof fetch {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (
      run(input instanceof Request ? input : new Request(input, init))
    ),
    { preconnect: fetch.preconnect },
  );
}

describe("agent diagnostics effective engine inspection", () => {
  test("reduces valid engine config and agent responses to the bounded allowlist", () => {
    const snapshot = validateEffectiveEngineSnapshot({
      config: {
        default_agent: "openwork",
        plugin: [["file:///plugins/openwork-extensions-preview.ts", { secret: "not-copied" }]],
        mcp: {
          "openwork-cloud": {
            type: "remote",
            url: "https://api.openworklabs.com/mcp/agent",
            headers: { Authorization: "Bearer NOT_REPORTED" },
          },
        },
      },
      agents: [{
        name: "openwork",
        mode: "primary",
        prompt: "search_capabilities execute_capability Memory Bank",
        hidden: false,
        permission: [{ permission: "openwork-cloud_*", pattern: "*", action: "allow" }],
        options: { secret: "not-copied" },
      }],
    });

    expect(snapshot).toMatchObject({
      defaultAgent: "openwork",
      pluginSpecs: ["file:///plugins/openwork-extensions-preview.ts"],
      agents: [{ name: "openwork", mode: "primary", hidden: false }],
      mcps: [{ name: "openwork-cloud" }],
    });
    expect(snapshot).not.toHaveProperty("agents.0.options");
  });

  test("mirrors OpenCode's last-match whole-resource tool visibility rule", () => {
    const rules = [
      { permission: "openwork-cloud_*", pattern: "*", action: "allow" as const },
      { permission: "openwork-cloud_search_*", pattern: "tenant-a", action: "deny" as const },
      { permission: "openwork-cloud_execute_capability", pattern: "*", action: "deny" as const },
    ];

    expect(effectiveToolDecision(rules, "openwork-cloud_search_capabilities")).toBe("allow");
    expect(effectiveToolDecision(rules, "openwork-cloud_execute_capability")).toBe("deny");
  });

  test("bounds engine bodies and rejects redirects without following them", async () => {
    let observedRedirect: RequestRedirect | undefined;
    const oversized = createAgentDiagnosticsEngineFetch(fetchStub((request) => {
      observedRedirect = request.redirect;
      return new Response("123456789", {
        headers: { "Content-Length": "9", "Content-Type": "application/json" },
      });
    }), 8);
    await expect(oversized("http://127.0.0.1/config")).rejects.toThrow(
      "agent_diagnostics_engine_response_too_large",
    );
    expect(observedRedirect).toBe("manual");

    const redirected = createAgentDiagnosticsEngineFetch(fetchStub(() => (
      new Response(null, { status: 302, headers: { Location: "https://unexpected.invalid/config" } })
    )));
    await expect(redirected("http://127.0.0.1/config")).rejects.toThrow(
      "agent_diagnostics_engine_redirect_rejected",
    );
  });
});
