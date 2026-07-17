import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("docs-openwork-connect");

const MCP_SERVER_URL = "https://api.openworklabs.com/mcp/agent";
const CLIENTS = ["Cursor", "Codex", "ChatGPT Desktop", "Claude Code", "OpenCode", "VS Code", "Any client"];
const SUPPORT_STATUS = [
  ["OpenCode", "Verified"],
  ["Codex", "Setup only"],
  ["Cursor", "Setup only"],
  ["ChatGPT Desktop", "Setup only"],
  ["Claude Code", "Setup only"],
  ["VS Code", "Setup only"],
  ["Any client", "Setup only"],
];
const OPENCODE_AUTH_COMMAND = "opencode mcp auth openwork";
const OPENCODE_RECONNECT_LOGOUT = "opencode mcp logout openwork";
const CODEX_ADD_COMMAND = `codex mcp add openwork --url ${MCP_SERVER_URL}`;
const CODEX_LOGIN_COMMAND = "codex mcp login openwork";
const CODEX_RECONNECT_LOGOUT = "codex mcp logout openwork";

function baseUrl(name) {
  return process.env[name].replace(/\/$/, "");
}

function recordAssertion(ctx, description, passed, actual) {
  ctx.assert(passed, `${description}. Actual: ${JSON.stringify(actual)}`);
}

async function navigate(ctx, url) {
  await ctx.eval(`location.href = ${JSON.stringify(url)}; true`);
}

async function waitForInstaller(ctx) {
  await ctx.waitFor(
    `(() => {
      const installer = document.querySelector("#connect-mcp-install");
      const text = installer ? installer.innerText : "";
      return Boolean(installer)
        && text.includes("Developers: point your own agent at your org")
        && text.includes(${JSON.stringify(MCP_SERVER_URL)});
    })()`,
    { timeoutMs: 30_000, label: "OpenWork Connect installer" },
  );
  await ctx.eval(`document.querySelector("#connect-mcp-install")?.scrollIntoView({ block: "start", behavior: "instant" }); true`);
}

async function clickTab(ctx, label) {
  await ctx.clickText(label, { selector: "#connect-mcp-install [role='tab']" });
  await ctx.waitFor(
    `(() => {
      const selected = document.querySelector("#connect-mcp-install [role='tab'][aria-selected='true']");
      return (selected?.textContent || "").trim() === ${JSON.stringify(label)};
    })()`,
    { timeoutMs: 10_000, label: `${label} client tab selected` },
  );
}

async function grantDocsClipboardPermissions(ctx) {
  if (!ctx.client?.send) return;

  await ctx.client.send("Browser.grantPermissions", {
    origin: new URL(baseUrl("OPENWORK_EVAL_DOCS_URL")).origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
}

export default {
  id: "docs-openwork-connect",
  title: "Use the OpenWork Connect installer from the docs or landing page",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DOCS_URL", "OPENWORK_EVAL_LANDING_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The OpenWork Connect docs put the complete client installer at the top of the page.", {
          voiceover: vo[0],
          action: async () => {
            await navigate(ctx, `${baseUrl("OPENWORK_EVAL_DOCS_URL")}/cloud/run-in-the-cloud/cloud-mcp`);
            await waitForInstaller(ctx);
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const installer = document.querySelector("#connect-mcp-install");
              const text = installer ? installer.innerText : "";
              const bodyText = document.body.innerText;
              const rows = Array.from(document.querySelectorAll("tr"))
                .map((row) => (row.innerText || "").replace(/\\s+/g, " ").trim());
              const supportRows = Object.fromEntries(
                ${JSON.stringify(CLIENTS)}.map((client) => [client, rows.find((row) => row.includes(client)) || ""]),
              );
              return {
                exists: Boolean(installer),
                hasDeveloperPrompt: text.includes("Developers: point your own agent at your org"),
                hasNoCursorInstall: !text.includes("Add to Cursor") && !bodyText.includes("~/.cursor/mcp.json"),
                hasServerUrl: text.includes(${JSON.stringify(MCP_SERVER_URL)}),
                hasVerifiedCopy: text.includes("Verified for OpenCode only"),
                hasSetupOnlyCopy: text.includes("setup guides for Codex, Cursor, ChatGPT"),
                tabs: Array.from(installer?.querySelectorAll("[role='tab']") || []).map((tab) => (tab.textContent || "").trim()),
                supportRows,
                hasInternalProxy: bodyText.includes("app.openworklabs.com/api/den") && bodyText.includes("internal same-origin desktop proxy"),
                hasAuthServer: bodyText.includes("https://app.openworklabs.com/api/auth"),
                hasRfc9728: bodyText.includes("RFC9728"),
                hasExactResource: bodyText.includes("OAuth authorize and token requests must include exactly one") && bodyText.includes(${JSON.stringify(MCP_SERVER_URL)}),
                hasDcrFallback: bodyText.includes("dynamic client registration as a fallback"),
                hasPkceS256: bodyText.includes("PKCE") && bodyText.includes("S256"),
                hasRedirectRules: bodyText.includes("HTTPS callbacks or HTTP loopback callbacks"),
                hasTokenLifetime: bodyText.includes("JWTs signed and validated with EdDSA") && bodyText.includes("issuer is exactly") && bodyText.includes("audience is exactly") && bodyText.includes("15 minutes") && bodyText.includes("30-day inactivity window"),
                hasRefreshTokenContract: bodyText.includes("Refresh tokens are opaque rotating grants"),
                hasRefreshReplayGuidance: bodyText.includes("invalid_grant") && bodyText.includes("replayed") && bodyText.includes("used concurrently"),
                hasRateLimitGuidance: bodyText.includes("429 rate limit") && bodyText.includes("Retry-After"),
                hasSupportReference: bodyText.includes("X-Request-Id") && bodyText.includes("referenceId") && bodyText.includes("reference_id"),
                hasAgentTools: bodyText.includes("search_capabilities") && bodyText.includes("execute_capability"),
                hasScopedAccessCopy: bodyText.includes("organization membership, role, policy, and exposure allowlists"),
                hasNoOpaqueAccessTokenClaim: !bodyText.includes("opaque bearer tokens") && !bodyText.includes("Access tokens are opaque"),
                hasNoJwksClaim: !/\\bJWKS\\b/.test(bodyText),
                hasCursorDesktopUnsupported: bodyText.includes("cursor://anysphere.cursor-mcp/oauth/callback") && bodyText.includes("Cursor Desktop OAuth is not currently supported"),
                hasChatGptSettings: bodyText.includes("Settings > MCP servers"),
                hasNoCimdClaim: !bodyText.includes("CIMD"),
              };
            })()`);
            recordAssertion(
              ctx,
              "The docs installer shows the developer prompt, current server URL, verified/setup-only copy, and all covered clients",
              actual.exists === true
                && actual.hasDeveloperPrompt === true
                && actual.hasNoCursorInstall === true
                && actual.hasServerUrl === true
                && actual.hasVerifiedCopy === true
                && actual.hasSetupOnlyCopy === true
                && CLIENTS.every((client) => actual.tabs.includes(client)),
              actual,
            );
            recordAssertion(
              ctx,
              "The docs support table and protocol sections match the shipped OAuth and /mcp/agent behavior",
              SUPPORT_STATUS.every(([client, status]) => typeof actual.supportRows[client] === "string" && actual.supportRows[client].includes(status))
                && actual.hasInternalProxy === true
                && actual.hasAuthServer === true
                && actual.hasRfc9728 === true
                && actual.hasExactResource === true
                && actual.hasDcrFallback === true
                && actual.hasPkceS256 === true
                && actual.hasRedirectRules === true
                && actual.hasTokenLifetime === true
                && actual.hasRefreshTokenContract === true
                && actual.hasRefreshReplayGuidance === true
                && actual.hasRateLimitGuidance === true
                && actual.hasSupportReference === true
                && actual.hasAgentTools === true
                && actual.hasScopedAccessCopy === true
                && actual.hasNoOpaqueAccessTokenClaim === true
                && actual.hasNoJwksClaim === true
                && actual.hasCursorDesktopUnsupported === true
                && actual.hasChatGptSettings === true
                && actual.hasNoCimdClaim === true,
              actual,
            );
          },
          screenshot: { name: "frame-1", requireText: ["Verified for OpenCode only"] },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Selecting OpenCode shows the exact remote MCP configuration for the current server.", {
          voiceover: vo[1],
          action: async () => {
            await clickTab(ctx, "OpenCode");
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const selected = document.querySelector("#connect-mcp-install [role='tab'][aria-selected='true']");
              const panel = document.querySelector("#connect-mcp-install [role='tabpanel']");
              const text = panel ? panel.innerText : "";
              return {
                selected: (selected?.textContent || "").trim(),
                hasType: text.includes('"type": "remote"'),
                hasEnabled: text.includes('"enabled": true'),
                hasOauth: text.includes('"oauth": {}'),
                hasServerUrl: text.includes(${JSON.stringify(MCP_SERVER_URL)}),
                hasAuthCommand: text.includes(${JSON.stringify(OPENCODE_AUTH_COMMAND)}),
                hasReconnectLogout: text.includes(${JSON.stringify(OPENCODE_RECONNECT_LOGOUT)}),
                hasReconnectHeading: text.includes("Reconnect or switch org"),
                hasVerifiedStatus: text.includes("Verified"),
              };
            })()`);
            recordAssertion(
              ctx,
              "OpenCode is selected and its complete remote MCP configuration, auth command, and reconnect command are visible",
              actual.selected === "OpenCode"
                && actual.hasType === true
                && actual.hasEnabled === true
                && actual.hasOauth === true
                && actual.hasServerUrl === true
                && actual.hasAuthCommand === true
                && actual.hasReconnectLogout === true
                && actual.hasReconnectHeading === true
                && actual.hasVerifiedStatus === true,
              actual,
            );
          },
          screenshot: { name: "frame-2", requireText: ["OpenCode", MCP_SERVER_URL] },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Copying the OpenCode configuration gives immediate confirmation.", {
          voiceover: vo[2],
          action: async () => {
            await grantDocsClipboardPermissions(ctx);
            await ctx.clickText("Copy", { selector: "#connect-mcp-install button" });
            await ctx.waitForText("Copied", { timeoutMs: 10_000 });
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const button = Array.from(document.querySelectorAll("#connect-mcp-install button"))
                .find((candidate) => (candidate.textContent || "").trim() === "Copied");
              return { copiedFeedbackVisible: Boolean(button) };
            })()`);
            recordAssertion(ctx, "The install button confirms the configuration was copied", actual.copiedFeedbackVisible === true, actual);
          },
          screenshot: { name: "frame-3", requireText: ["Copied", "OpenCode"] },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The direct OpenCode docs link opens the installer with OpenCode selected.", {
          voiceover: vo[3],
          action: async () => {
            await navigate(ctx, `${baseUrl("OPENWORK_EVAL_DOCS_URL")}/cloud/run-in-the-cloud/cloud-mcp#connect-mcp-install-opencode`);
            await waitForInstaller(ctx);
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const selected = document.querySelector("#connect-mcp-install [role='tab'][aria-selected='true']");
              const panel = document.querySelector("#connect-mcp-install [role='tabpanel']");
              return {
                hash: location.hash,
                selected: (selected?.textContent || "").trim(),
                panelHasServerUrl: (panel?.innerText || "").includes(${JSON.stringify(MCP_SERVER_URL)}),
              };
            })()`);
            recordAssertion(
              ctx,
              "The shareable OpenCode hash selects the OpenCode panel and current server URL",
              actual.hash === "#connect-mcp-install-opencode"
                && actual.selected === "OpenCode"
                && actual.panelHasServerUrl === true,
              actual,
            );
          },
          screenshot: { name: "frame-4", requireText: ["OpenCode", MCP_SERVER_URL], hashIncludes: "connect-mcp-install-opencode" },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("The landing page keeps the same OpenWork Connect installer, including Codex and ChatGPT Desktop.", {
          voiceover: vo[4],
          action: async () => {
            await navigate(ctx, `${baseUrl("OPENWORK_EVAL_LANDING_URL")}/#connect-mcp`);
            await waitForInstaller(ctx);
            await clickTab(ctx, "Codex");
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const installer = document.querySelector("#connect-mcp-install");
              const selected = document.querySelector("#connect-mcp-install [role='tab'][aria-selected='true']");
              const panel = document.querySelector("#connect-mcp-install [role='tabpanel']");
              const text = installer ? installer.innerText : "";
              const panelText = panel ? panel.innerText : "";
              return {
                hasServerUrl: text.includes(${JSON.stringify(MCP_SERVER_URL)}),
                tabs: Array.from(installer?.querySelectorAll("[role='tab']") || []).map((tab) => (tab.textContent || "").trim()),
                selected: (selected?.textContent || "").trim(),
                hasCodexAdd: panelText.includes(${JSON.stringify(CODEX_ADD_COMMAND)}),
                hasCodexLogin: panelText.includes(${JSON.stringify(CODEX_LOGIN_COMMAND)}),
                hasCodexReconnectLogout: panelText.includes(${JSON.stringify(CODEX_RECONNECT_LOGOUT)}),
                hasCodexReconnectHeading: panelText.includes("Reconnect or switch org"),
                hasCodexSetupOnly: panelText.includes("Setup only"),
                hasChatGptSetupCoverage: text.includes("ChatGPT Desktop") && text.includes("setup guides"),
              };
            })()`);
            recordAssertion(
              ctx,
              "The landing installer uses the current server, exposes the same client coverage, and shows exact Codex add/login/reconnect commands",
              actual.hasServerUrl === true
                && CLIENTS.every((client) => actual.tabs.includes(client))
                && actual.selected === "Codex"
                && actual.hasCodexAdd === true
                && actual.hasCodexLogin === true
                && actual.hasCodexReconnectLogout === true
                && actual.hasCodexReconnectHeading === true
                && actual.hasCodexSetupOnly === true
                && actual.hasChatGptSetupCoverage === true,
              actual,
            );
          },
          screenshot: { name: "frame-5", requireText: ["Cursor", "Codex", "ChatGPT Desktop", "Claude Code", "OpenCode", "VS Code", "Any client", "Setup only"] },
        });
      },
    },
  ],
};
