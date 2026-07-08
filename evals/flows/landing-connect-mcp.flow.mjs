import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "landing-connect-mcp";
const MCP_SERVER_URL = "https://api.openworklabs.com/mcp/agent";
const DOCS_URL = "https://openworklabs.com/docs/cloud/run-in-the-cloud/cloud-mcp";
const SECTION_SELECTOR = "#connect-mcp";
const BRING_SELECTOR = '[data-testid="connect-mcp-bring"]';
const EXAMPLE_SELECTOR = '[data-testid="connect-mcp-example"]';
const INSTALL_SELECTOR = '[data-testid="connect-mcp-install"]';
const SIGNUP_URL = "https://app.openworklabs.com?mode=sign-up";
const CLAUDE_CODE_COMMAND = `claude mcp add --transport http openwork ${MCP_SERVER_URL}`;
const INSTALL_COPY_BUTTON_SELECTOR = `${SECTION_SELECTOR} [role="tabpanel"]:not([hidden]) button[aria-label="Copy the OpenWork MCP install command"]`;

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
        let cursorScan = null;
        let clipboardRead = { text: "", error: "not read" };

        await ctx.prove("Connecting an agent starts with Cursor by default, then Claude Code copies the exact MCP command and reveals the OAuth steps.", {
          voiceover: vo[4],
          action: async () => {
            await ensureConnectSection(ctx);
            await scrollSelectorIntoView(ctx, INSTALL_SELECTOR);
            cursorScan = await ctx.eval(`(() => {
              const section = document.querySelector(${JSON.stringify(SECTION_SELECTOR)});
              const tabs = Array.from(section ? section.querySelectorAll('[role="tab"]') : []);
              const cursorTab = tabs.find((tab) => (tab.textContent || "").trim() === "Cursor");
              const links = Array.from(section ? section.querySelectorAll("a") : []);
              const addToCursor = links.find((link) => (link.textContent || "").trim() === "Add to Cursor");
              const href = addToCursor ? addToCursor.href : "";
              let decodedConfig = "";
              let decodedUrl = "";
              let parseError = "";

              try {
                const config = new URL(href).searchParams.get("config") || "";
                decodedConfig = atob(config);
                const parsed = JSON.parse(decodedConfig);
                decodedUrl = typeof parsed.url === "string" ? parsed.url : "";
              } catch (error) {
                parseError = error instanceof Error ? error.message : String(error);
              }

              return {
                cursorSelected: cursorTab ? cursorTab.getAttribute("aria-selected") : null,
                addToCursorExists: Boolean(addToCursor),
                href,
                decodedConfig,
                decodedUrl,
                parseError,
              };
            })()`);

            await realMouseClick(ctx, tabByLabelExpression("Claude Code"), "Claude Code tab");
            await ctx.waitFor(
              `(() => {
                const panel = document.querySelector(${JSON.stringify(`${SECTION_SELECTOR} [role="tabpanel"]:not([hidden])`)});
                const tabs = Array.from(document.querySelectorAll(${JSON.stringify(`${SECTION_SELECTOR} [role="tab"]`)}));
                const claudeTab = tabs.find((tab) => (tab.textContent || "").trim() === "Claude Code");
                return Boolean(panel && panel.innerText.includes(${JSON.stringify(CLAUDE_CODE_COMMAND)}) && claudeTab && claudeTab.querySelector("svg"));
              })()`,
              { timeoutMs: 10_000, label: "Claude Code command and tab icon visible" },
            );
            await grantClipboardPermissions(ctx);
            await realMouseClick(
              ctx,
              `document.querySelector(${JSON.stringify(INSTALL_COPY_BUTTON_SELECTOR)})`,
              "visible OpenWork MCP install copy button",
            );
            await ctx.waitFor(
              `(() => {
                const section = document.querySelector(${JSON.stringify(SECTION_SELECTOR)});
                const text = section ? section.innerText : "";
                return Boolean(section && section.querySelector('[data-feedback="true"]') && text.includes("Copied") && text.includes("Create your free account or sign in") && text.includes("Pick your org"));
              })()`,
              { timeoutMs: 10_000, label: "Copied feedback state and reveal steps" },
            );

            try {
              const text = await ctx.eval("navigator.clipboard.readText()", { awaitPromise: true });
              clipboardRead = { text, error: "" };
            } catch (error) {
              clipboardRead = {
                text: "",
                error: error instanceof Error ? error.message : String(error),
              };
            }
            await sleep(150);
          },
          assert: async () => {
            ctx.recordEvidence({
              type: "output",
              name: "Decoded Cursor MCP config",
              text: cursorScan?.decodedConfig ?? "",
            });
            recordAssertion(
              ctx,
              "Cursor is selected by default and Add to Cursor decodes to the OpenWork MCP server URL",
              cursorScan?.cursorSelected === "true"
                && cursorScan.addToCursorExists === true
                && cursorScan.parseError === ""
                && cursorScan.decodedUrl === MCP_SERVER_URL,
              cursorScan,
            );

            const feedbackScan = await ctx.eval(`(() => {
              const section = document.querySelector(${JSON.stringify(SECTION_SELECTOR)});
              const links = Array.from(section ? section.querySelectorAll("a") : []);
              const tabs = Array.from(section ? section.querySelectorAll('[role="tab"]') : []);
              const signup = links.find((link) => (link.textContent || "").trim() === "create one free");
              const claudeTab = tabs.find((tab) => (tab.textContent || "").trim() === "Claude Code");
              return {
                feedbackActive: Boolean(section && section.querySelector('[data-feedback="true"]')),
                copiedVisible: Boolean(section && section.innerText.includes("Copied")),
                accountStepVisible: Boolean(section && section.innerText.includes("Create your free account or sign in")),
                pickOrgStepVisible: Boolean(section && section.innerText.includes("Pick your org")),
                signupExists: Boolean(signup),
                signupHref: signup ? signup.getAttribute("href") : "",
                claudeTabSelected: claudeTab ? claudeTab.getAttribute("aria-selected") : null,
                claudeTabHasSvg: Boolean(claudeTab && claudeTab.querySelector("svg")),
              };
            })()`);
            ctx.recordEvidence({
              type: "output",
              name: "Clipboard readText result",
              text: JSON.stringify(clipboardRead, null, 2),
            });
            recordAssertion(
              ctx,
              "navigator.clipboard.readText returns the exact Claude Code MCP command",
              clipboardRead.error === "" && clipboardRead.text === CLAUDE_CODE_COMMAND,
              clipboardRead,
            );
            recordAssertion(
              ctx,
              "The active Claude Code tab button contains a brand SVG icon",
              feedbackScan.claudeTabSelected === "true" && feedbackScan.claudeTabHasSvg === true,
              feedbackScan,
            );
            recordAssertion(
              ctx,
              "The install card shows the Copied feedback state and browser sign-in reveal steps after copying",
              feedbackScan.feedbackActive === true
                && feedbackScan.copiedVisible === true
                && feedbackScan.accountStepVisible === true
                && feedbackScan.pickOrgStepVisible === true
                && feedbackScan.signupExists === true
                && feedbackScan.signupHref === SIGNUP_URL,
              feedbackScan,
            );
          },
          screenshot: { name: "frame-5", requireText: ["Copied"] },
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
