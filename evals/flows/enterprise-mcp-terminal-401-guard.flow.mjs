/**
 * Internal demo: the terminal-401 credential guard.
 *
 * Production forensics showed the enterprise MCP client destroyed stored
 * connection credentials on any unresolved 401 — including transient provider
 * blips and background search probes — forcing users to reconnect (Notion,
 * Stripe, Salesforce, Granola cases confirmed in the Den DB). This flow proves
 * the new policy on the real client (requiresApp: false): evidence is claims +
 * assertions + real command output from driving createEnterpriseMcpClient
 * through scripted provider scenarios.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "enterprise-mcp-terminal-401-guard";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLIENT_SOURCE = join(ROOT, "packages", "enterprise-mcp-client", "src", "enterprise-mcp-client.ts");
const ADAPTER_SOURCE = join(ROOT, "ee", "apps", "den-api", "src", "capability-sources", "enterprise-mcp-client-adapter.ts");

const vo = await loadVoiceoverParagraphs(FLOW_ID);

/** Assert + record, so every check shows up as evidence in the frame. */
function witness(ctx, condition, assertion, actual) {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, assertion + (actual ? ` (actual: ${actual})` : ""));
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

let acts = null;

function act(ctx, name) {
  witness(ctx, Array.isArray(acts), "The demo run produced parseable act results");
  const found = acts.find((entry) => entry.act === name);
  witness(ctx, Boolean(found), `The demo run includes act "${name}"`);
  return found;
}

export default {
  id: FLOW_ID,
  title: "A transient 401 no longer destroys stored connection credentials",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "The policy: invalidation requires user intent and provider proof",
      run: async (ctx) => {
        await ctx.prove("Credential invalidation is gated to tool execution with an invalid_token challenge", {
          voiceover: vo[0],
          assert: async () => {
            const source = await readFile(CLIENT_SOURCE, "utf8");
            witness(
              ctx,
              source.includes('input.operationPhase !== "tool-execution"'),
              "Only user-initiated tool execution may invalidate (background probes are excluded)",
            );
            witness(
              ctx,
              source.includes("failure.httpStatus === 401 && failure.invalidToken"),
              "A 401 is terminal only with an explicit invalid_token bearer challenge",
            );
            witness(
              ctx,
              source.includes('kind: "credential-invalidation"'),
              "Every invalidation emits a credential-invalidation diagnostic",
            );
            const start = source.indexOf("async function invalidateTerminallyRejectedCredential");
            const end = source.indexOf("function createSession", start);
            witness(ctx, start >= 0 && end > start, "The guard function is present in the client source");
            ctx.output("invalidateTerminallyRejectedCredential", source.slice(start, end).trimEnd());
          },
        });
      },
    },
    {
      name: "A transient 401 during tool execution leaves the credential intact",
      run: async (ctx) => {
        await ctx.prove("The stored credential survives a bare 401 on a user-initiated tool call", {
          voiceover: vo[1],
          assert: async () => {
            const demo = spawnSync(
              "pnpm",
              ["--filter", "@openwork/enterprise-mcp-client", "exec", "tsx", "test/terminal-401-guard.demo.ts"],
              { cwd: ROOT, encoding: "utf8" },
            );
            witness(ctx, demo.status === 0, "The demo drive of the real client exits cleanly", demo.status === 0 ? undefined : `${demo.stdout}\n${demo.stderr}`);
            const line = demo.stdout.split("\n").find((entry) => entry.startsWith("DEMO_RESULT_JSON="));
            witness(ctx, Boolean(line), "The demo prints machine-readable act evidence");
            acts = JSON.parse(line.slice("DEMO_RESULT_JSON=".length));
            const result = act(ctx, "transient-401-on-execute");
            witness(ctx, result.operation === "tools/call", "The act is a user-initiated tool call");
            witness(ctx, result.credentialIntact === true, "The stored credential survived the bare 401");
            witness(ctx, result.invalidationCount === 0, "No invalidation was written to persistence");
            ctx.output("act: transient-401-on-execute", demo.stdout.split("\n").filter((entry) => entry.startsWith("act=")).join("\n"));
          },
        });
      },
    },
    {
      name: "Background discovery probes never destroy credentials",
      run: async (ctx) => {
        await ctx.prove("A tool-discovery probe cannot invalidate, even on an invalid_token challenge", {
          voiceover: vo[2],
          assert: async () => {
            const result = act(ctx, "invalid-token-on-discovery-probe");
            witness(ctx, result.operation === "tools/list", "The act is a background discovery probe");
            witness(ctx, result.providerResponse.includes("invalid_token"), "The provider claimed invalid_token");
            witness(ctx, result.credentialIntact === true, "The stored credential survived the probe");
            witness(ctx, result.invalidationCount === 0, "No invalidation was written to persistence");
          },
        });
      },
    },
    {
      name: "A genuine invalid_token rejection invalidates once, with a diagnostic trail",
      run: async (ctx) => {
        await ctx.prove("Provider-proven token rejection still invalidates and is now observable", {
          voiceover: vo[3],
          assert: async () => {
            const result = act(ctx, "invalid-token-on-execute");
            witness(ctx, result.credentialIntact === false, "The credential was invalidated");
            witness(ctx, result.invalidationCount === 1, "Exactly one invalidation was written");
            witness(ctx, result.invalidationDiagnostics.length === 1, "Exactly one credential-invalidation diagnostic was emitted");
            const diagnostic = result.invalidationDiagnostics[0];
            witness(ctx, diagnostic.operationPhase === "tool-execution", "The diagnostic records the user-initiated phase");
            witness(ctx, diagnostic.httpStatus === 401 && diagnostic.invalidToken === true, "The diagnostic records the provider's proof");
            const adapter = await readFile(ADAPTER_SOURCE, "utf8");
            witness(
              ctx,
              adapter.includes('console.error("external_mcp_credential_invalidated"'),
              "Den logs external_mcp_credential_invalidated unconditionally (no more silent kills)",
            );
            ctx.output("credential-invalidation diagnostic", JSON.stringify(diagnostic, null, 2));
            const tests = spawnSync(
              "pnpm",
              ["--filter", "@openwork/enterprise-mcp-client", "test"],
              { cwd: ROOT, encoding: "utf8" },
            );
            witness(ctx, tests.status === 0, "The full enterprise MCP client test suite passes", tests.status === 0 ? undefined : `${tests.stdout}\n${tests.stderr}`);
            const tail = `${tests.stdout}\n${tests.stderr}`.split("\n").filter((entry) => entry.includes("pass") || entry.includes("fail")).slice(-6).join("\n");
            ctx.output("test suite", tail);
          },
        });
      },
    },
  ],
};
