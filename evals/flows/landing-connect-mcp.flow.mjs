import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "landing-connect-mcp";
const MCP_SERVER_URL = "https://api.openworklabs.com/mcp/agent";
const DOCS_URL = "https://openworklabs.com/docs/cloud/run-in-the-cloud/cloud-mcp#connect-mcp-install-opencode";
const SECTION_SELECTOR = "#connect-mcp";
const BRING_SELECTOR = '[data-testid="connect-mcp-bring"]';
const EXAMPLE_SELECTOR = '[data-testid="connect-mcp-example"]';
const INSTALL_SELECTOR = '[data-testid="connect-mcp-install"]';
const CODEX_COMMAND = `codex mcp add openwork --url ${MCP_SERVER_URL}`;
const CODEX_LOGIN_COMMAND = "codex mcp login openwork";
const CODEX_RECONNECT_COMMAND = `codex mcp logout openwork
codex mcp login openwork`;
const CODEX_CONNECTIONS_DEEPLINK = "codex://settings/connections";
const CHATGPT_SETTINGS_URL = "https://chatgpt.com/#settings/Connectors";
const OPENCODE_AUTH_COMMAND = "opencode mcp auth openwork";
const OPENCODE_RECONNECT_COMMAND = `opencode mcp logout openwork
opencode mcp auth openwork`;
const INSTALL_COPY_BUTTON_SELECTOR = `${SECTION_SELECTOR} [role="tabpanel"]:not([hidden]) button[aria-label="Copy the OpenWork MCP install command"]`;
const CLIENT_STATUS_EXPECTATIONS = [
  { label: "Cursor", status: "Setup only", explanationNeedles: ["Cursor Web/Agents", "cursor://anysphere.cursor-mcp/oauth/callback"] },
  { label: "Codex", status: "Setup only", explanationNeedles: ["Native proof must be rerun on this exact branch"] },
  { label: "ChatGPT Desktop", status: "Setup only", explanationNeedles: ["Settings > MCP servers", "Native proof is not complete"] },
  { label: "Claude Code", status: "Setup only", explanationNeedles: ["use /mcp in Claude Code"] },
  { label: "OpenCode", status: "Verified", explanationNeedles: ["OpenCode native remote MCP OAuth"] },
  { label: "VS Code", status: "Setup only", explanationNeedles: ["VS Code's MCP server prompt"] },
  { label: "Any client", status: "Setup only", explanationNeedles: ["remote Streamable HTTP MCP servers and OAuth"] },
];

// Narration is loaded from the approved script (evals/voiceovers/landing-connect-mcp.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function routeUrl(ctx, path) {
  return new URL(path, ctx.env.OPENWORK_EVAL_LANDING_URL).toString();
}

function recordAssertion(ctx, assertion, passed, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

async function grantClipboardPermissions(ctx) {
  if (!ctx.client?.send) {
    ctx.log("Clipboard permission grant skipped: no raw CDP send method on context.");
    return;
  }

  const origin = new URL(ctx.env.OPENWORK_EVAL_LANDING_URL).origin;
  await ctx.client.send("Browser.grantPermissions", {
    origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  }).catch((error) => {
    ctx.log(`Clipboard permission grant skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function applyDesktopViewport(ctx) {
  if (!ctx.client?.send) {
    ctx.log("Desktop viewport skipped: no raw CDP send method on context.");
    return;
  }

  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  }).catch((error) => {
    ctx.log(`Desktop viewport skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function scrollSectionIntoView(ctx) {
  await ctx.eval(`(() => {
    document.querySelector(${JSON.stringify(SECTION_SELECTOR)})?.scrollIntoView({ block: "start", behavior: "instant" });
    return true;
  })()`);
}

async function scrollSelectorIntoView(ctx, selector, block = "center") {
  await ctx.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element?.scrollIntoView({ block: ${JSON.stringify(block)}, behavior: "instant" });
    return Boolean(element);
  })()`);
}

async function ensureConnectSection(ctx, { forceReload = false } = {}) {
  await applyDesktopViewport(ctx);
  const hasSection = await ctx.eval(`Boolean(document.querySelector(${JSON.stringify(SECTION_SELECTOR)}))`).catch(() => false);

  if (!hasSection || forceReload) {
    await fetch(routeUrl(ctx, "/")).catch(() => {});
    await ctx.eval(`location.href = ${JSON.stringify(routeUrl(ctx, "/"))}; true`);
  }

  await ctx.waitFor(
    `(() => {
      const section = document.querySelector(${JSON.stringify(SECTION_SELECTOR)});
      const text = section ? section.innerText : "";
      return Boolean(section)
        && text.includes("Already doing it in your agent?")
        && text.includes("Add it to OpenWork")
        && text.includes(${JSON.stringify(MCP_SERVER_URL)});
    })()`,
    { timeoutMs: 30_000, label: "Connect section with new sharing headline" },
  );
  await scrollSectionIntoView(ctx);
}

async function realMouseClick(ctx, elementExpression, label) {
  const point = await ctx.eval(`(() => {
    const element = ${elementExpression};
    if (!element) return null;
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    return {
      visible: rect.width > 0 && rect.height > 0,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  })()`);

  ctx.assert(point !== null && point.visible === true, `${label} was not found or visible.`);

  if (!ctx.client?.send) {
    await ctx.eval(`(() => {
      const element = ${elementExpression};
      element?.click();
      return true;
    })()`);
    return;
  }

  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

function tabByLabelExpression(label) {
  return `Array.from(document.querySelectorAll(${JSON.stringify(`${SECTION_SELECTOR} [role="tab"]`)}))
    .find((tab) => (tab.textContent || "").trim() === ${JSON.stringify(label)})`;
}

async function scrollExampleTextIntoView(ctx, text) {
  await ctx.eval(`(() => {
    const example = document.querySelector(${JSON.stringify(EXAMPLE_SELECTOR)});
    if (!example) return false;
    const target = Array.from(example.querySelectorAll("*"))
      .find((element) => (element.textContent || "").includes(${JSON.stringify(text)}));
    (target || example).scrollIntoView({ block: "center", behavior: "instant" });
    return true;
  })()`);
}

export default {
  id: FLOW_ID,
  title: "Add existing agent work to OpenWork and share it with your team",
  kind: "user-facing",
  spec: "evals/README.md",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_LANDING_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The landing page leads with adding existing agent work to OpenWork and sharing it with the team.", {
          voiceover: vo[0],
          action: async () => {
            await ensureConnectSection(ctx, { forceReload: true });
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const section = document.querySelector(${JSON.stringify(SECTION_SELECTOR)});
              const text = section ? section.innerText : "";
              return {
                sectionExists: Boolean(section),
                hasAlreadyDoingHeading: text.includes("Already doing it in your agent?"),
                hasAddItHeading: text.includes("Add it to OpenWork"),
                hasServerUrl: text.includes(${JSON.stringify(MCP_SERVER_URL)}),
                hasProtocolJargon: text.includes("search_capabilities"),
              };
            })()`);
            recordAssertion(
              ctx,
              "The Connect section includes the new heading and OpenWork MCP server URL without tool-name jargon",
              actual.sectionExists === true
                && actual.hasAlreadyDoingHeading === true
                && actual.hasAddItHeading === true
                && actual.hasServerUrl === true
                && actual.hasProtocolJargon === false,
              actual,
            );
          },
          screenshot: { name: "frame-1", requireText: ["Add it to OpenWork"] },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The agent terminal shows existing skills, MCPs, and commands shared to OpenWork in one link.", {
          voiceover: vo[1],
          action: async () => {
            await ensureConnectSection(ctx);
            await scrollSelectorIntoView(ctx, BRING_SELECTOR);
            await ctx.waitFor(
              `(() => {
                const card = document.querySelector(${JSON.stringify(BRING_SELECTOR)});
                const text = card ? card.innerText : "";
                return text.includes("agent — terminal")
                  && text.includes("share my skills and MCPs with my OpenWork org")
                  && text.includes("granola")
                  && text.includes("meeting-brief")
                  && text.includes("review-pr")
                  && text.includes("SKILL.md")
                  && text.includes("one link");
              })()`,
              { timeoutMs: 10_000, label: "agent terminal sharing existing setup" },
            );
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const card = document.querySelector(${JSON.stringify(BRING_SELECTOR)});
              const text = card ? card.innerText : "";
              return {
                exists: Boolean(card),
                hasTerminalTitle: text.includes("agent — terminal"),
                hasSharePrompt: text.includes("share my skills and MCPs with my OpenWork org"),
                hasGranola: text.includes("granola"),
                hasMeetingBrief: text.includes("meeting-brief"),
                hasReviewPr: text.includes("review-pr"),
                hasSkillMd: text.includes("SKILL.md"),
                hasOneLink: text.includes("one link"),
              };
            })()`);
            recordAssertion(
              ctx,
              "The agent terminal shows the share prompt, granola, meeting-brief, review-pr, SKILL.md, and one link",
              actual.exists === true
                && actual.hasTerminalTitle === true
                && actual.hasSharePrompt === true
                && actual.hasGranola === true
                && actual.hasMeetingBrief === true
                && actual.hasReviewPr === true
                && actual.hasSkillMd === true
                && actual.hasOneLink === true,
              actual,
            );
          },
          screenshot: { name: "frame-2", requireText: ["agent — terminal"] },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The mini OpenWork app shows a teammate using the shared Granola connection and meeting-brief skill.", {
          voiceover: vo[2],
          action: async () => {
            await ensureConnectSection(ctx);
            // Align the example window's top with the viewport top: frame 2
            // centers the sibling bring-it-in card in the same grid row, so a
            // "center" scroll here would land on the same offset and the
            // runner would reject the capture as a duplicate frame.
            await scrollSelectorIntoView(ctx, EXAMPLE_SELECTOR, "start");
            await ctx.waitFor(
              `(() => {
                const example = document.querySelector(${JSON.stringify(EXAMPLE_SELECTOR)});
                const text = example ? example.innerText : "";
                return text.includes("Prep a brief for tomorrow's Acme call")
                  && text.includes("Queried the shared Granola MCP")
                  && text.includes("Your teammate's view");
              })()`,
              { timeoutMs: 10_000, label: "mini OpenWork teammate view" },
            );
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const example = document.querySelector(${JSON.stringify(EXAMPLE_SELECTOR)});
              const text = example ? example.innerText : "";
              return {
                exists: Boolean(example),
                hasPrompt: text.includes("Prep a brief for tomorrow's Acme call"),
                hasGranolaExecution: text.includes("Queried the shared Granola MCP"),
                hasTeammateView: text.includes("Your teammate's view"),
              };
            })()`);
            recordAssertion(
              ctx,
              "The mini OpenWork UI shows a teammate prompt and shared Granola execution",
              actual.exists === true
                && actual.hasPrompt === true
                && actual.hasGranolaExecution === true
                && actual.hasTeammateView === true,
              actual,
            );
          },
          screenshot: { name: "frame-3", requireText: ["Granola"] },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The teammate run shows the shared meeting-brief skill completing with three talking points.", {
          voiceover: vo[3],
          action: async () => {
            await ensureConnectSection(ctx);
            await scrollExampleTextIntoView(ctx, "3 talking points");
            await ctx.waitFor(
              `(() => {
                const example = document.querySelector(${JSON.stringify(EXAMPLE_SELECTOR)});
                const text = example ? example.innerText : "";
                return text.includes("Ran Meeting Brief Generator")
                  && text.includes("3 talking points")
                  && text.includes("Run Task");
              })()`,
              { timeoutMs: 10_000, label: "mini OpenWork run result" },
            );
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const example = document.querySelector(${JSON.stringify(EXAMPLE_SELECTOR)});
              const text = example ? example.innerText : "";
              return {
                exists: Boolean(example),
                hasMeetingBriefRun: text.includes("Ran Meeting Brief Generator"),
                hasTalkingPoints: text.includes("3 talking points"),
                hasRunTask: text.includes("Run Task"),
              };
            })()`);
            recordAssertion(
              ctx,
              "The mini OpenWork UI shows the shared meeting-brief run, talking points, and Run Task input",
              actual.exists === true
                && actual.hasMeetingBriefRun === true
                && actual.hasTalkingPoints === true
                && actual.hasRunTask === true,
              actual,
            );
          },
          screenshot: { name: "frame-4", requireText: ["talking points"] },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        let codexClipboardRead = { text: "", error: "not read" };
        const visibleStatusEvidence = {};
        let opencodePanelText = "";
        let codexPanelText = "";

        await ctx.prove("The client matrix shows evidence labels and exact verified auth commands without running native client auth.", {
          voiceover: vo[4],
          action: async () => {
            await ensureConnectSection(ctx);
            await scrollSelectorIntoView(ctx, INSTALL_SELECTOR);

            for (const expected of CLIENT_STATUS_EXPECTATIONS) {
              await realMouseClick(ctx, tabByLabelExpression(expected.label), `${expected.label} tab`);
              await ctx.waitFor(
                `(() => {
                  const panel = document.querySelector(${JSON.stringify(`${SECTION_SELECTOR} [role="tabpanel"]:not([hidden])`)});
                  const text = panel ? panel.innerText : "";
                  return Boolean(panel)
                    && text.includes(${JSON.stringify(expected.label)})
                    && text.includes(${JSON.stringify(expected.status)})
                    && ${JSON.stringify(expected.explanationNeedles)}.every((needle) => text.includes(needle));
                })()`,
                { timeoutMs: 10_000, label: `${expected.label} status and support explanation` },
              );
              const panelText = await ctx.eval(`(() => {
                const panel = document.querySelector(${JSON.stringify(`${SECTION_SELECTOR} [role="tabpanel"]:not([hidden])`)});
                return panel ? panel.innerText : "";
              })()`);
              visibleStatusEvidence[expected.label] = {
                status: expected.status,
                statusVisible: panelText.toLowerCase().includes(expected.status.toLowerCase()),
                explanationVisible: expected.explanationNeedles.every((needle) => panelText.includes(needle)),
              };
            }

            await realMouseClick(ctx, tabByLabelExpression("OpenCode"), "OpenCode tab");
            await ctx.waitFor(
              `(() => {
                const panel = document.querySelector(${JSON.stringify(`${SECTION_SELECTOR} [role="tabpanel"]:not([hidden])`)});
                const text = panel ? panel.innerText : "";
                return Boolean(panel)
                  && text.includes("Verified")
                  && text.includes(${JSON.stringify(MCP_SERVER_URL)})
                  && text.includes('"oauth": {}')
                  && text.includes(${JSON.stringify(OPENCODE_AUTH_COMMAND)})
                  && text.includes(${JSON.stringify(OPENCODE_RECONNECT_COMMAND)});
              })()`,
              { timeoutMs: 10_000, label: "OpenCode verified config, auth, and reconnect commands visible" },
            );
            opencodePanelText = await ctx.eval(`(() => {
              const panel = document.querySelector(${JSON.stringify(`${SECTION_SELECTOR} [role="tabpanel"]:not([hidden])`)});
              return panel ? panel.innerText : "";
            })()`);

            await realMouseClick(ctx, tabByLabelExpression("Codex"), "Codex tab");
            await ctx.waitFor(
              `(() => {
                const panel = document.querySelector(${JSON.stringify(`${SECTION_SELECTOR} [role="tabpanel"]:not([hidden])`)});
                const tabs = Array.from(document.querySelectorAll(${JSON.stringify(`${SECTION_SELECTOR} [role="tab"]`)}));
                const codexTab = tabs.find((tab) => (tab.textContent || "").trim() === "Codex");
                const codexIcon = codexTab?.querySelector('img[data-product-icon="codex"]');
                const settings = Array.from(panel?.querySelectorAll("a") || [])
                  .find((link) => (link.textContent || "").trim() === "Open settings + copy URL");
                return Boolean(panel
                  && panel.innerText.includes("Setup only")
                  && panel.innerText.includes(${JSON.stringify(CODEX_COMMAND)})
                  && panel.innerText.includes(${JSON.stringify(CODEX_LOGIN_COMMAND)})
                  && panel.innerText.includes(${JSON.stringify(CODEX_RECONNECT_COMMAND)})
                  && codexIcon?.complete
                  && codexIcon.naturalWidth > 0
                  && codexIcon.src.includes("connect-icons%2Fcodex.png")
                  && settings?.getAttribute("href") === ${JSON.stringify(CODEX_CONNECTIONS_DEEPLINK)});
              })()`,
              { timeoutMs: 10_000, label: "Codex product icon, add/login commands, reconnect commands, and setup-only settings link visible" },
            );
            codexPanelText = await ctx.eval(`(() => {
              const panel = document.querySelector(${JSON.stringify(`${SECTION_SELECTOR} [role="tabpanel"]:not([hidden])`)});
              return panel ? panel.innerText : "";
            })()`);
            await grantClipboardPermissions(ctx);
            await realMouseClick(
              ctx,
              `document.querySelector(${JSON.stringify(INSTALL_COPY_BUTTON_SELECTOR)})`,
              "visible OpenWork MCP install copy button",
            );
            await ctx.waitFor(
              `(() => {
                const section = document.querySelector(${JSON.stringify(SECTION_SELECTOR)});
                return Boolean(section && section.querySelector('[data-feedback="true"]') && section.innerText.includes("Copied"));
              })()`,
              { timeoutMs: 10_000, label: "Codex command copied" },
            );

            try {
              const text = await ctx.eval("navigator.clipboard.readText()", { awaitPromise: true });
              codexClipboardRead = { text, error: "" };
            } catch (error) {
              codexClipboardRead = {
                text: "",
                error: error instanceof Error ? error.message : String(error),
              };
            }

            await realMouseClick(ctx, tabByLabelExpression("ChatGPT Desktop"), "ChatGPT Desktop tab");
            await ctx.waitFor(
              `(() => {
                const panel = document.querySelector(${JSON.stringify(`${SECTION_SELECTOR} [role="tabpanel"]:not([hidden])`)});
                const codexLinks = Array.from(panel?.querySelectorAll("a") || [])
                  .filter((link) => link.getAttribute("href") === ${JSON.stringify(CODEX_CONNECTIONS_DEEPLINK)});
                const chatgptSettings = Array.from(panel?.querySelectorAll("a") || [])
                  .find((link) => (link.textContent || "").trim() === "Open settings + copy URL");
                return Boolean(panel
                  && panel.innerText.includes("Setup only")
                  && panel.innerText.toLowerCase().includes("guided desktop setup")
                  && panel.innerText.includes(${JSON.stringify(MCP_SERVER_URL)})
                  && panel.innerText.includes("ChatGPT Settings > MCP servers")
                  && panel.innerText.includes("Open settings + copy URL")
                  && chatgptSettings?.getAttribute("href") === ${JSON.stringify(CHATGPT_SETTINGS_URL)}
                  && codexLinks.length === 0);
              })()`,
              { timeoutMs: 10_000, label: "ChatGPT Desktop setup-only OAuth starting point with ChatGPT settings link and without Codex deep link" },
            );
            await sleep(150);
          },
          assert: async () => {
            const clientMatrixScan = await ctx.eval(`(() => {
              const section = document.querySelector(${JSON.stringify(SECTION_SELECTOR)});
              const tabs = Array.from(section ? section.querySelectorAll('[role="tab"]') : []);
              const panel = section?.querySelector('[role="tabpanel"]:not([hidden])');
              const codexTab = tabs.find((tab) => (tab.textContent || "").trim() === "Codex");
              const chatgptTab = tabs.find((tab) => (tab.textContent || "").trim() === "ChatGPT Desktop");
              const codexIcon = codexTab?.querySelector('img[data-product-icon="codex"]');
              const chatgptIcon = chatgptTab?.querySelector('img[data-product-icon="chatgpt"]');
              const allCodexLinks = Array.from(section ? section.querySelectorAll('a') : [])
                .filter((link) => link.getAttribute("href") === ${JSON.stringify(CODEX_CONNECTIONS_DEEPLINK)});
              const activeCodexLinks = Array.from(panel?.querySelectorAll("a") || [])
                .filter((link) => link.getAttribute("href") === ${JSON.stringify(CODEX_CONNECTIONS_DEEPLINK)});
              const activeChatGptSettingsLinks = Array.from(panel?.querySelectorAll("a") || [])
                .filter((link) => link.getAttribute("href") === ${JSON.stringify(CHATGPT_SETTINGS_URL)});
              return {
                labels: tabs.map((tab) => (tab.textContent || "").trim()),
                chatgptSelected: chatgptTab?.getAttribute("aria-selected"),
                codexIconLoaded: Boolean(codexIcon?.complete && codexIcon.naturalWidth > 0 && codexIcon.src.includes("connect-icons%2Fcodex.png")),
                chatgptIconLoaded: Boolean(chatgptIcon?.complete && chatgptIcon.naturalWidth > 0 && chatgptIcon.src.includes("connect-icons%2Fchatgpt.png")),
                panelText: panel?.innerText || "",
                codexDeepLinkCount: allCodexLinks.length,
                activeCodexDeepLinkCount: activeCodexLinks.length,
                activeChatGptSettingsLinkCount: activeChatGptSettingsLinks.length,
              };
            })()`);
            ctx.recordEvidence({
              type: "output",
              name: "Codex command clipboard result",
              text: JSON.stringify(codexClipboardRead, null, 2),
            });
            ctx.recordEvidence({
              type: "output",
              name: "Visible client support statuses",
              text: JSON.stringify(visibleStatusEvidence, null, 2),
            });
            recordAssertion(
              ctx,
              "Every client panel exposes its visible Verified or Setup only status and support explanation",
              CLIENT_STATUS_EXPECTATIONS.every((expected) => {
                const evidence = visibleStatusEvidence[expected.label];
                return evidence?.status === expected.status
                  && evidence.statusVisible === true
                  && evidence.explanationVisible === true;
              }),
              visibleStatusEvidence,
            );
            recordAssertion(
              ctx,
              "OpenCode shows the JSON config, opencode auth command, and logout-then-auth reconnect sequence",
              opencodePanelText.includes(MCP_SERVER_URL)
                && opencodePanelText.includes('"oauth": {}')
                && opencodePanelText.includes(OPENCODE_AUTH_COMMAND)
                && opencodePanelText.indexOf("opencode mcp logout openwork") >= 0
                && opencodePanelText.indexOf(OPENCODE_AUTH_COMMAND, opencodePanelText.indexOf("opencode mcp logout openwork")) > opencodePanelText.indexOf("opencode mcp logout openwork"),
              opencodePanelText,
            );
            recordAssertion(
              ctx,
              "Codex shows the add command, login command, and logout-then-login reconnect sequence",
              codexPanelText.includes(CODEX_COMMAND)
                && codexPanelText.includes(CODEX_LOGIN_COMMAND)
                && codexPanelText.indexOf("codex mcp logout openwork") >= 0
                && codexPanelText.indexOf(CODEX_LOGIN_COMMAND, codexPanelText.indexOf("codex mcp logout openwork")) > codexPanelText.indexOf("codex mcp logout openwork"),
              codexPanelText,
            );
            recordAssertion(
              ctx,
              "navigator.clipboard.readText returns the exact native Codex MCP command",
              codexClipboardRead.error === "" && codexClipboardRead.text === CODEX_COMMAND,
              codexClipboardRead,
            );
            recordAssertion(
              ctx,
              "The installer exposes Codex and ChatGPT icons, keeps Codex as the only Codex deep link, and gives ChatGPT its own settings link while setup-only",
              clientMatrixScan.labels.includes("Codex")
                && clientMatrixScan.labels.includes("ChatGPT Desktop")
                && clientMatrixScan.chatgptSelected === "true"
                && clientMatrixScan.codexIconLoaded === true
                && clientMatrixScan.chatgptIconLoaded === true
                && clientMatrixScan.panelText.includes("Setup only")
                && clientMatrixScan.panelText.includes("ChatGPT Settings > MCP servers")
                && clientMatrixScan.panelText.includes(MCP_SERVER_URL)
                && clientMatrixScan.codexDeepLinkCount === 1
                && clientMatrixScan.activeCodexDeepLinkCount === 0
                && clientMatrixScan.activeChatGptSettingsLinkCount === 1,
              clientMatrixScan,
            );
          },
          screenshot: { name: "frame-5", requireText: ["ChatGPT Desktop", "Setup only", "Open settings + copy URL"] },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("Read the docs links to the Cloud MCP guide for OAuth details.", {
          voiceover: vo[5],
          action: async () => {
            await ensureConnectSection(ctx);
            await ctx.eval(`(() => {
              const links = Array.from(document.querySelectorAll(${JSON.stringify(`${SECTION_SELECTOR} a`)}));
              const docs = links.find((link) => (link.textContent || "").trim() === "Read the docs");
              docs?.scrollIntoView({ block: "center", behavior: "instant" });
              return Boolean(docs);
            })()`);
            await ctx.waitFor(
              `(() => Array.from(document.querySelectorAll(${JSON.stringify(`${SECTION_SELECTOR} a`)}))
                .some((link) => (link.textContent || "").trim() === "Read the docs"))()`,
              { timeoutMs: 10_000, label: "Read the docs link" },
            );
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const links = Array.from(document.querySelectorAll(${JSON.stringify(`${SECTION_SELECTOR} a`)}));
              const docs = links.find((link) => (link.textContent || "").trim() === "Read the docs");
              return {
                exists: Boolean(docs),
                href: docs ? docs.href : "",
                target: docs ? docs.target : "",
                rel: docs ? docs.rel : "",
              };
            })()`);
            recordAssertion(
              ctx,
              "Read the docs points exactly to the OpenWork Cloud MCP guide",
              actual.exists === true && actual.href === DOCS_URL,
              actual,
            );
          },
          screenshot: { name: "frame-6", requireText: ["Read the docs"] },
        });
      },
    },
  ],
};
