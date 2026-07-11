import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, openAdminConnections, signInApi } from "./lib/den-web.mjs";

const vo = await loadVoiceoverParagraphs("mcp-connection-diagnostics");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const CONNECTION_NAME = `diagnostic-unreachable-${Date.now()}`;
const MCP_URL = "http://127.0.0.1:65534/mcp";
const state = { adminSession: null };

async function signInStagedBrowser(ctx) {
  const baseUrl = process.env.OPENWORK_EVAL_DEN_WEB_URL;
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(baseUrl)}; return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000 });
  await ctx.eval("fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true).catch(() => true)", { awaitPromise: true });
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(baseUrl)}; return true; })()`);
  await ctx.waitFor('Boolean(document.querySelector(\'input[type="email"]\'))', { timeoutMs: 30_000, label: "email field" });
  await ctx.fill('input[type="email"]', ADMIN_EMAIL);
  const advanced = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => ['Next', 'Sign in'].includes((entry.textContent ?? '').trim()));
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(advanced, "Could not advance the email sign-in step.");
  await ctx.waitFor('Boolean(document.querySelector(\'input[type="password"]\'))', { timeoutMs: 20_000, label: "password field" });
  await ctx.fill('input[type="password"]', ADMIN_PASSWORD);
  const submitted = await ctx.eval(`(() => {
    const button = document.querySelector('button[type="submit"]') ?? [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Sign in');
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(submitted, "Could not submit the password sign-in step.");
  await ctx.waitForText("Dashboard", { timeoutMs: 30_000 });
}

export default {
  id: "mcp-connection-diagnostics",
  title: "A failed MCP connection identifies its exact layer",
  kind: "user-facing",
  spec: "evals/voiceovers/mcp-connection-diagnostics.md",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Setup: sign in as the Den admin",
      run: async (ctx) => {
        state.adminSession = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
        ctx.assert(Boolean(state.adminSession), `Den API sign-in failed for ${ADMIN_EMAIL}.`);
        await signInStagedBrowser(ctx);
      },
    },
    {
      name: "Frame 1: Connections is the normal diagnostic entry point",
      run: async (ctx) => {
        await ctx.prove("The admin starts from the ordinary Connections screen", {
          voiceover: vo[0],
          action: async () => openAdminConnections(ctx),
          assert: async () => ctx.expectText("Add a connection"),
          screenshot: {
            name: "mcp-diagnostic-entry",
            claim: "The normal Connections screen is the entry point for MCP diagnosis.",
            requireText: ["Add a connection", "MCP server"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2: configure a real unreachable MCP probe",
      run: async (ctx) => {
        await ctx.prove("The custom MCP form will exercise server-side initialize", {
          voiceover: vo[1],
          action: async () => {
            await ctx.clickText("MCP server", { selector: "button", timeoutMs: 20_000 });
            await ctx.fill('input[placeholder="notion"]', CONNECTION_NAME);
            await ctx.fill('input[placeholder="https://mcp.example.com/mcp"]', MCP_URL);
            await ctx.clickText("None", { selector: "button" });
          },
          assert: async () => {
            const configured = await ctx.eval(`document.querySelector('input[placeholder="https://mcp.example.com/mcp"]')?.value`);
            ctx.assert(configured === MCP_URL, `Expected ${MCP_URL}, got ${configured}.`);
          },
          screenshot: {
            name: "mcp-diagnostic-unreachable-configured",
            claim: "An unreachable Streamable HTTP endpoint is configured through the real form.",
            requireText: ["Add a custom MCP server", "Authentication", "None"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3: the failure names TCP and gives a safe reference",
      run: async (ctx) => {
        await ctx.prove("The failed initialize identifies the network layer without exposing internals", {
          voiceover: vo[2],
          action: async () => ctx.clickText("Add connection", { selector: "button", timeoutMs: 20_000 }),
          assert: async () => {
            await ctx.waitForText("Den resolved the MCP host but could not establish a network connection", { timeoutMs: 30_000 });
            await ctx.expectText("Reference:");
            await ctx.expectNoText("fetch failed");
          },
          screenshot: {
            name: "mcp-diagnostic-tcp-failure",
            claim: "The UI names the TCP failure and exposes only a safe correlation reference.",
            requireText: ["Den resolved the MCP host", "Reference:"],
            rejectText: ["fetch failed", "access_token", "client_secret", "Bearer"],
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        const list = await denApiFetch("/v1/mcp-connections?scope=manageable", {
          headers: { authorization: `Bearer ${state.adminSession}` },
        });
        const connection = (list.body.connections ?? []).find((entry) => entry.name === CONNECTION_NAME);
        if (connection?.id) {
          const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${state.adminSession}` },
          });
          ctx.assert(removed.response.ok, `Cleanup failed for ${connection.id}.`);
        }
      },
    },
  ],
};
