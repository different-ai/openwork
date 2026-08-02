import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
  denApiFetch,
  mcpAgentCall,
  mintMcpToken,
  signInApi,
  signInViaBrowser,
} from "./lib/den-web.mjs";

const FLOW_ID = "cli-connector-gh-version";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";

const state = {
  sessionToken: "",
  organizationId: "",
  connectionId: "",
  capability: "",
  schemaDigest: "",
};

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : JSON.stringify(actual).slice(0, 1_200),
  });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : `. Actual: ${JSON.stringify(actual).slice(0, 600)}`}`);
}

async function navigateToConnections(ctx) {
  const base = process.env.OPENWORK_EVAL_DEN_WEB_URL.trim().replace(/\/+$/, "");
  const url = `${base}/dashboard/mcp-connections`;
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "Connectors page load" });
  await ctx.waitForText("GitHub CLI Demo", { timeoutMs: 30_000 });
}

function bearerHeaders() {
  return {
    authorization: `Bearer ${state.sessionToken}`,
    "x-openwork-org-id": state.organizationId,
  };
}

export default {
  id: FLOW_ID,
  title: "GitHub CLI connector reaches the agent capability facade",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Setup",
      run: async (ctx) => {
        await ctx.client.send("Emulation.setDeviceMetricsOverride", {
          width: 1440,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        state.sessionToken = await signInApi(EMAIL, PASSWORD) ?? "";
        witness(ctx, state.sessionToken.length > 0, "The seeded workspace owner can sign in", { email: EMAIL });
        const org = await denApiFetch("/v1/org", { headers: { authorization: `Bearer ${state.sessionToken}` } });
        state.organizationId = org.body?.organization?.id ?? "";
        witness(ctx, org.response.ok && state.organizationId.length > 0, "The signed-in owner has an active organization", {
          status: org.response.status,
          organizationId: state.organizationId,
        });
        await signInViaBrowser(ctx, EMAIL, PASSWORD, "Acme Robotics");
        await navigateToConnections(ctx);
      },
    },
    {
      name: "Reviewed quick add is visible",
      run: async (ctx) => {
        await ctx.prove("Connectors offers one credential-free GitHub CLI version probe", {
          voiceover: vo[0],
          assert: async () => {
            const card = await ctx.eval(`(() => {
              const button = document.querySelector('[data-testid="quick-add-github-cli-demo"]');
              return button ? { text: button.textContent, disabled: button.disabled } : null;
            })()`);
            witness(ctx, Boolean(card), "The GitHub CLI Demo quick-add card is rendered", card);
            witness(ctx, card?.text?.includes("No credentials required") === true, "The card states that no credentials are required", card);
          },
          screenshot: {
            name: "github-cli-demo-quick-add",
            claim: "Connectors visibly offers the reviewed, credential-free GitHub CLI Demo.",
            requireText: ["Connectors", "GitHub CLI Demo", "No credentials required", "Enable"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Enable is idempotent and becomes Ready",
      run: async (ctx) => {
        await ctx.prove("One click enables exactly one Ready connector pinned to manifest 1.0.0", {
          voiceover: vo[1],
          action: async () => {
            const enabled = await ctx.eval(`(() => {
              const button = document.querySelector('[data-testid="quick-add-github-cli-demo"]');
              if (!(button instanceof HTMLButtonElement)) return false;
              if (!button.disabled) button.click();
              return true;
            })()`);
            ctx.assert(enabled, "GitHub CLI Demo quick-add button was not available.");
            await ctx.waitFor(`(() => {
              const row = document.querySelector('[data-testid="cli-connector-row"]');
              return Boolean(row && (row.textContent ?? '').includes('Ready'));
            })()`, { timeoutMs: 30_000, label: "GitHub CLI connector row Ready" });
            await ctx.eval(`document.querySelector('[data-testid="quick-add-github-cli-demo"]')?.scrollIntoView({ block: 'center' })`);
          },
          assert: async () => {
            for (let attempt = 0; attempt < 2; attempt += 1) {
              const repeated = await denApiFetch("/v1/cli-connections", {
                method: "POST",
                headers: bearerHeaders(),
                body: JSON.stringify({ catalogKey: "github-cli-demo" }),
              });
              witness(ctx, repeated.response.ok, "Repeated enable request succeeds idempotently", {
                attempt,
                status: repeated.response.status,
              });
            }
            const listed = await denApiFetch("/v1/cli-connections", { headers: bearerHeaders() });
            const demoConnections = (listed.body?.connections ?? []).filter((entry) => entry.catalogKey === "github-cli-demo");
            witness(ctx, listed.response.ok && demoConnections.length === 1, "The organization has exactly one GitHub CLI Demo row", demoConnections);
            const connection = demoConnections[0];
            state.connectionId = connection?.id ?? "";
            witness(
              ctx,
              connection?.readiness === "ready"
                && connection?.manifestVersion === "1.0.0"
                && connection?.commandSummary?.read === 1,
              "The connector is Ready with one read command pinned to manifest 1.0.0",
              connection,
            );
          },
          screenshot: {
            name: "github-cli-demo-ready",
            claim: "GitHub CLI Demo is enabled and visibly Ready with one read-only command.",
            requireText: ["GitHub CLI Demo", "Ready", "Hosted CLI", "Read (1)", "Manifest 1.0.0"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Agent discovers and routes the exact CLI capability",
      run: async (ctx) => {
        await ctx.prove("The two-tool agent MCP discovers and safely routes the exact CLI version capability", {
          voiceover: vo[2],
          action: async () => {
            const mcpToken = await mintMcpToken(state.sessionToken, ctx, ["mcp:read", "mcp:write"]);
            const tools = await mcpAgentCall(mcpToken, "tools/list", {}, ctx);
            const toolNames = (tools.tools ?? []).map((tool) => tool.name).sort();
            witness(
              ctx,
              JSON.stringify(toolNames) === JSON.stringify(["execute_capability", "search_capabilities"]),
              "The agent MCP still exposes exactly two top-level tools",
              toolNames,
            );

            const search = await mcpAgentCall(mcpToken, "tools/call", {
              name: "search_capabilities",
              arguments: { query: "github cli version", type: "cli", limit: 5 },
            }, ctx);
            const searchText = String(search.content?.[0]?.text ?? "");
            const searchPayload = JSON.parse(searchText);
            const match = (searchPayload.matches ?? []).find((entry) => entry.name === `cli:${state.connectionId}:version`);
            state.capability = match?.name ?? "";
            state.schemaDigest = match?.schemaDigest ?? "";
            witness(
              ctx,
              state.capability === `cli:${state.connectionId}:version`
                && /^sha256:[0-9a-f]{64}$/.test(state.schemaDigest),
              "search_capabilities returns the exact org-scoped CLI capability and manifest digest",
              match,
            );

            const executed = await mcpAgentCall(mcpToken, "tools/call", {
              name: "execute_capability",
              arguments: { name: state.capability, schemaDigest: state.schemaDigest },
            }, ctx);
            const executeText = String(executed.content?.[0]?.text ?? "");
            if (process.env.DAYTONA_API_KEY?.trim()) {
              const result = JSON.parse(executeText);
              witness(
                ctx,
                executed.isError !== true
                  && result.exitCode === 0
                  && String(result.stdout).includes("gh version 2.93.0"),
                "Daytona executes the pinned GitHub CLI and returns structured output",
                result,
              );
            } else {
              const result = JSON.parse(executeText);
              witness(
                ctx,
                executed.isError === true && result.error === "runner_unavailable",
                "Without Daytona configuration execution fails closed instead of using a local CLI",
                result,
              );
            }
            await ctx.eval(`document.querySelector('[data-testid="cli-connector-row"]')?.scrollIntoView({ block: 'center' })`);
          },
          screenshot: {
            name: "github-cli-agent-capability",
            claim: "The Ready connector shown in Den is the same org-scoped capability discovered by the two-tool agent MCP.",
            requireText: ["Your connectors", "GitHub CLI Demo", "Ready", "Hosted CLI", "Manifest 1.0.0"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
