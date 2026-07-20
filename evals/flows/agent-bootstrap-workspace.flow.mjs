const BOOTSTRAP = {
  baseUrl: "https://api.openworklabs.com",
  apiBaseUrl: "https://api.openworklabs.com",
  requireSignin: false,
  handoff: null,
  prepared: {
    orgId: "org_01h2xcejqtf2nbrexx3vqjhp41",
    orgName: "Agent Bootstrap Workspace",
    orgSlug: "org_01h2xcejqtf2nbrexx3vqjhp41",
    skillId: "skl_01h2xcejqtf2nbrexx3vqjhp41",
    skillTitle: "First OpenWork Skill",
    skillsDir: "/tmp/openwork-agent-bootstrap-skills",
    skillPath: "/tmp/openwork-agent-bootstrap-skills/first-openwork-skill/SKILL.md",
    preparedAt: new Date().toISOString(),
  },
  claimLinks: [
    {
      id: "wcl_01h2xcejqtf2nbrexx3vqjhp41",
      role: "owner",
      token: "eval-token-not-real",
      url: "https://app.openworklabs.com/workspace-claim?token=eval-token-not-real",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  ],
};

export default {
  id: "agent-bootstrap-workspace",
  title: "Agent-prepared workspace opens to setup-complete onboarding",
  spec: "packages/openwork-bootstrap/start.md",
  steps: [
    {
      name: "Agent-prepared desktop bootstrap is visible to the user",
      run: async (ctx) => {
        await ctx.prove("A non-email bootstrap opens the desktop app to setup-complete onboarding", {
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 60_000,
              label: "control API",
            });
            await ctx.eval(`(() => localStorage.removeItem("openwork.den.settings"))()`);
            await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", {
              timeoutMs: 30_000,
              label: "desktop bridge",
            });
            const written = await ctx.eval(`(async () => {
              const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
              if (!bridge) return { ok: false, reason: "desktop bridge unavailable" };
              await bridge("setDesktopBootstrapConfig", ${JSON.stringify(BOOTSTRAP)});
              return { ok: true };
            })()`, { awaitPromise: true });
            ctx.assert(written?.ok, written?.reason ?? "Failed to write desktop bootstrap config.");
            await ctx.eval("(() => { window.location.hash = '/session'; window.location.reload(); return true; })()");
          },
          assert: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 60_000,
              label: "control API after reload",
            });
            await ctx.waitForText("Setup complete", { timeoutMs: 30_000 });
            const route = await ctx.eval("window.__openworkControl.snapshot().route");
            ctx.assert(route === "/onboarding", `Expected /onboarding, got ${route}`);
            await ctx.expectText("Agent Bootstrap Workspace");
            await ctx.expectText("Claim this workspace");
            const marker = await ctx.eval(`(() => {
              const prepared = document.querySelector('[data-openwork-prepared="true"]');
              const provisional = document.querySelector('[data-openwork-provisional="true"]');
              return Boolean(prepared && provisional);
            })()`);
            ctx.assert(marker === true, "Prepared/provisional markers were not rendered.");
            await ctx.expectNoText("First skill ready");
            await ctx.expectNoText("Try asking");
            await ctx.expectNoText("Open your workspace and try a task");
          },
          screenshot: {
            name: "agent-bootstrap-workspace-ready",
            requireText: ["Setup complete", "Agent Bootstrap Workspace", "Claim this workspace"],
            rejectText: ["First skill ready", "Try asking", "Open your workspace and try a task", "Something went wrong"],
          },
        });
      },
    },
  ],
};
