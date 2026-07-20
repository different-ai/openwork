import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "roadmap-every-surface";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

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

async function applyDesktopViewport(ctx) {
  if (!ctx.client?.send) return;

  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function navigateTo(ctx, path, expectedText) {
  await applyDesktopViewport(ctx);
  await fetch(routeUrl(ctx, path)).catch(() => {});
  await ctx.eval(`location.href = ${JSON.stringify(routeUrl(ctx, path))}; true`);
  await ctx.waitFor(
    `location.pathname === ${JSON.stringify(path)} && document.body.innerText.includes(${JSON.stringify(expectedText)})`,
    { timeoutMs: 30_000, label: `${path} route with ${expectedText}` },
  );
}

async function scrollTo(ctx, selector, block = "start") {
  await ctx.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element?.scrollIntoView({ block: ${JSON.stringify(block)}, behavior: "instant" });
    return Boolean(element);
  })()`);
  await ctx.waitFor(
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    })()`,
    { timeoutMs: 10_000, label: `${selector} visible` },
  );
}

async function sectionState(ctx, selector) {
  return ctx.eval(`(() => {
    const section = document.querySelector(${JSON.stringify(selector)});
    const text = section?.innerText || "";
    return {
      exists: Boolean(section),
      text,
      live: Array.from(section?.querySelectorAll("span") || []).filter((node) => node.textContent?.trim() === "Live").length,
      partial: Array.from(section?.querySelectorAll("span") || []).filter((node) => node.textContent?.trim() === "Partial").length,
      building: Array.from(section?.querySelectorAll("span") || []).filter((node) => node.textContent?.trim() === "Building").length,
      next: Array.from(section?.querySelectorAll("span") || []).filter((node) => node.textContent?.trim() === "Next").length,
      exploring: Array.from(section?.querySelectorAll("span") || []).filter((node) => node.textContent?.trim() === "Exploring").length,
    };
  })()`);
}

export default {
  id: FLOW_ID,
  title: "The OpenWork roadmap presents desktop as home and the same workspace on every surface",
  kind: "user-facing",
  spec: "evals/voiceovers/roadmap-every-surface.md",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_LANDING_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The roadmap goes directly from its introduction into the dated product sections without the unclear system diagram.", {
          voiceover: vo[0],
          action: async () => {
            await navigateTo(ctx, "/roadmap", "on every surface.");
            await ctx.eval("scrollTo(0, 0); true");
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const roadmap = document.querySelector('[data-testid="openwork-roadmap"]');
              const shell = document.querySelector('[data-testid="roadmap-page-shell"]');
              const text = roadmap?.innerText || "";
              const firstSectionAfterHero = roadmap?.children[1]?.querySelector("#desktop-home");
              return {
                path: location.pathname,
                roadmapExists: Boolean(roadmap),
                shellBackground: shell ? getComputedStyle(shell).backgroundColor : null,
                shaderCanvasCount: shell?.querySelectorAll("canvas").length ?? null,
                startsWithDesktopSection: Boolean(firstSectionAfterHero),
                hasRemovedWindowLabel: text.includes("Home base · live"),
                hasRemovedProjectLabel: text.includes("Project workspace"),
              };
            })()`);
            recordAssertion(
              ctx,
              "The roadmap has a solid background with no shader canvas and the introduction is followed by the desktop section",
              actual.path === "/roadmap"
                && actual.roadmapExists === true
                && actual.shellBackground === "rgb(246, 249, 252)"
                && actual.shaderCanvasCount === 0
                && actual.startsWithDesktopSection === true
                && actual.hasRemovedWindowLabel === false
                && actual.hasRemovedProjectLabel === false,
              actual,
            );
          },
          screenshot: {
            name: "frame-1-roadmap-introduction",
            requireText: ["your workspace,", "on every surface.", "the desktop app is home"],
            rejectText: ["Home base · live", "Project workspace", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The desktop section distinguishes what is live from the work actively being built.", {
          voiceover: vo[1],
          action: async () => {
            await scrollTo(ctx, "#desktop-home");
          },
          assert: async () => {
            const actual = await sectionState(ctx, "#desktop-home");
            recordAssertion(
              ctx,
              "The desktop section shows artifacts and browser control as Live, isolated sandboxes as Partial, and long-running organization as Building",
              actual.exists === true
                && actual.text.includes("the desktop app is home")
                && actual.text.includes("Local files and workspaces")
                && actual.text.includes("Organization-managed capabilities")
                && actual.text.includes("Artifacts")
                && actual.text.includes("Built-in browser control")
                && actual.text.includes("Isolated sandbox workspaces")
                && actual.text.includes("Better organization for long-running work")
                && actual.live === 6
                && actual.partial === 1
                && actual.building === 1,
              actual,
            );
          },
          screenshot: {
            name: "frame-2-desktop-home",
            requireText: ["the desktop app is home", "Artifacts", "Built-in browser control", "Partial"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The portability section shows how the desktop setup travels through OpenWork Connect.", {
          voiceover: vo[2],
          action: async () => {
            await scrollTo(ctx, "#setup-follows");
          },
          assert: async () => {
            const actual = await sectionState(ctx, "#setup-follows");
            recordAssertion(
              ctx,
              "The Connect section names the supported agents, marketplace controls, authentication modes, and Git sync direction",
              actual.exists === true
                && actual.text.includes("your setup follows you")
                && actual.text.includes("OpenWork Connect MCP")
                && actual.text.includes("Codex, Claude Code, Cursor, and OpenCode")
                && actual.text.includes("Organization marketplaces and access controls")
                && actual.text.includes("Shared and per-user authentication")
                && actual.text.includes("Git-based publishing and automatic sync")
                && actual.live === 4
                && actual.building === 1,
              actual,
            );
          },
          screenshot: {
            name: "frame-3-setup-follows",
            requireText: ["your setup follows you", "OpenWork Connect MCP", "Git-based publishing"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The central management section distinguishes controls available today from broader observability coverage being built.", {
          voiceover: vo[3],
          action: async () => {
            await scrollTo(ctx, "#central-management");
          },
          assert: async () => {
            const actual = await sectionState(ctx, "#central-management");
            recordAssertion(
              ctx,
              "Central management includes desktop policies, teams, marketplaces, Anthropic-compatible plugins, SSO, telemetry, and OpenTelemetry coverage",
              actual.exists === true
                && actual.text.includes("central management")
                && actual.text.includes("Desktop policies")
                && actual.text.includes("Members, teams, and roles")
                && actual.text.includes("Skills and plugin marketplaces")
                && actual.text.includes("Anthropic-compatible plugins")
                && actual.text.includes("SAML SSO")
                && actual.text.includes("Usage and adoption telemetry")
                && actual.text.includes("OpenTelemetry coverage")
                && actual.live === 6
                && actual.building === 1,
              actual,
            );
          },
          screenshot: {
            name: "frame-4-central-management",
            requireText: ["central management", "Desktop policies", "Skills and plugin marketplaces"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("The hosted-workspace section explains the persistent runtime and the sequence of upcoming work.", {
          voiceover: vo[4],
          action: async () => {
            await scrollTo(ctx, "#hosted-workspaces");
          },
          assert: async () => {
            const actual = await sectionState(ctx, "#hosted-workspaces");
            recordAssertion(
              ctx,
              "The hosted-workspace section includes remote connections, persistence, reproducibility, background work, schedules, and surface handoff",
              actual.exists === true
                && actual.text.includes("a workspace that stays on")
                && actual.text.includes("persistent filesystem")
                && actual.text.includes("Remote workspace connections")
                && actual.text.includes("Reproducible environments")
                && actual.text.includes("Long-running and background tasks")
                && actual.text.includes("Scheduled workflows")
                && actual.text.includes("Continue from another surface")
                && actual.live === 1
                && actual.building === 3
                && actual.next === 2,
              actual,
            );
          },
          screenshot: {
            name: "frame-5-hosted-workspaces",
            requireText: ["a workspace that stays on", "Persistent hosted workspaces", "Scheduled workflows"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("The surfaces section makes the sequence from desktop to Slack, mobile, and beyond explicit.", {
          voiceover: vo[5],
          action: async () => {
            await scrollTo(ctx, "#every-surface");
          },
          assert: async () => {
            const actual = await sectionState(ctx, "#every-surface");
            recordAssertion(
              ctx,
              "Desktop and MCP agents are Live, Slack and mobile are Next, and later surfaces are Exploring",
              actual.exists === true
                && actual.text.includes("OpenWork on every surface")
                && actual.text.includes("OpenWork desktop")
                && actual.text.includes("Existing AI agents through MCP")
                && actual.text.includes("Slack")
                && actual.text.includes("Mobile")
                && actual.text.includes("Email and messaging")
                && actual.text.includes("Custom organization agents")
                && actual.live === 2
                && actual.next === 2
                && actual.exploring === 2,
              actual,
            );
          },
          screenshot: {
            name: "frame-6-every-surface",
            requireText: ["OpenWork on every surface", "Slack", "Mobile", "Exploring"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await ctx.prove("The docs route renders the same shared roadmap with central management and no specifications section.", {
          voiceover: vo[6],
          action: async () => {
            await navigateTo(ctx, "/docs/roadmap", "central management");
            await scrollTo(ctx, "#central-management");
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const roadmap = document.querySelector('[data-testid="openwork-roadmap"]');
              const centralManagement = document.querySelector("#central-management");
              const specs = document.querySelector("#specifications");
              const text = roadmap?.innerText || "";
              const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "";
              return {
                path: location.pathname,
                sharedRoadmapExists: Boolean(roadmap),
                centralManagementExists: Boolean(centralManagement),
                specificationsExist: Boolean(specs),
                hasDesktopPolicies: text.includes("Desktop policies"),
                hasSandbox: text.includes("Isolated sandbox workspaces"),
                hasSystemsSection: Boolean(document.querySelector("#systems")),
                hasOldSpecificationsCopy: text.includes("upcoming specifications"),
                canonical,
              };
            })()`);
            recordAssertion(
              ctx,
              "The local docs route uses the shared roadmap, includes central management and desktop capabilities, omits specifications, and canonicals to the public roadmap",
              actual.path === "/docs/roadmap"
                && actual.sharedRoadmapExists === true
                && actual.centralManagementExists === true
                && actual.specificationsExist === false
                && actual.hasDesktopPolicies === true
                && actual.hasSandbox === true
                && actual.hasSystemsSection === true
                && actual.hasOldSpecificationsCopy === false
                && actual.canonical.endsWith("/roadmap"),
              actual,
            );
          },
          screenshot: {
            name: "frame-7-docs-central-management",
            requireText: ["central management", "Desktop policies", "Skills and plugin marketplaces"],
            rejectText: ["upcoming specifications", "Something went wrong"],
          },
        });
      },
    },
  ],
};
