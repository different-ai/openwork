import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("docs-openwork-connect");

const MCP_SERVER_URL = "https://api.openworklabs.com/mcp/agent";
const CLIENTS = ["Cursor", "Codex", "ChatGPT Desktop", "Claude Code", "OpenCode", "VS Code", "Any client"];

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
              return {
                exists: Boolean(installer),
                hasDeveloperPrompt: text.includes("Developers: point your own agent at your org"),
                hasCursorInstall: text.includes("Add to Cursor"),
                hasServerUrl: text.includes(${JSON.stringify(MCP_SERVER_URL)}),
                tabs: Array.from(installer?.querySelectorAll("[role='tab']") || []).map((tab) => (tab.textContent || "").trim()),
              };
            })()`);
            recordAssertion(
              ctx,
              "The docs installer shows the developer prompt, current server URL, and all supported clients",
              actual.exists === true
                && actual.hasDeveloperPrompt === true
                && actual.hasCursorInstall === true
                && actual.hasServerUrl === true
                && CLIENTS.every((client) => actual.tabs.includes(client)),
              actual,
            );
          },
          screenshot: { name: "frame-1", requireText: ["Add to Cursor"] },
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
              };
            })()`);
            recordAssertion(
              ctx,
              "OpenCode is selected and its complete remote MCP configuration is visible",
              actual.selected === "OpenCode"
                && actual.hasType === true
                && actual.hasEnabled === true
                && actual.hasOauth === true
                && actual.hasServerUrl === true,
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
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const installer = document.querySelector("#connect-mcp-install");
              const text = installer ? installer.innerText : "";
              return {
                hasServerUrl: text.includes(${JSON.stringify(MCP_SERVER_URL)}),
                tabs: Array.from(installer?.querySelectorAll("[role='tab']") || []).map((tab) => (tab.textContent || "").trim()),
              };
            })()`);
            recordAssertion(
              ctx,
              "The landing installer uses the current server and exposes the same supported clients",
              actual.hasServerUrl === true && CLIENTS.every((client) => actual.tabs.includes(client)),
              actual,
            );
          },
          screenshot: { name: "frame-5", requireText: ["Cursor", "Codex", "ChatGPT Desktop", "Claude Code", "OpenCode", "VS Code", "Any client"] },
        });
      },
    },
  ],
};
