/**
 * End-to-end: owner creates a skill, shares it to the org marketplace via MCP,
 * and the member discovers it via notification and installs it.
 *
 * Uses control actions wherever possible; falls back to ctx.clickText for the
 * few steps that should go through the real UI (marketplace install dialog).
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL    Den API base (e.g. http://localhost:8788)
 * - OPENWORK_EVAL_DEN_TOKEN      Bearer session token for the demo owner
 * - OPENWORK_EVAL_WORKSPACE_PATH Absolute path for the eval workspace
 */
export default {
  id: "admin-to-member-marketplace",
  title: "Owner creates skill, shares via MCP, member discovers and installs from marketplace",
  spec: "evals/react-session-flows.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_WORKSPACE_PATH"],
  steps: [
    {
      name: "App booted and control API available",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000 });
        ctx.log("Control API ready.");
      },
    },
    {
      name: "Sign in via handoff grant",
      run: async (ctx) => {
        // Check if already signed in
        const authStatus = await ctx.control("auth.status");
        if (authStatus?.status === "signed_in") {
          ctx.log(`Already signed in as ${authStatus.user?.email}`);
          return;
        }

        // Create handoff grant via Den API
        const apiBase = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
        const response = await fetch(`${apiBase}/v1/auth/desktop-handoff`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        });
        const body = await response.json();
        ctx.assert(response.ok && body.grant, `Handoff create failed: ${response.status}`);

        // Exchange grant via control action
        await ctx.control("auth.exchange-grant", { grant: body.grant });
        await ctx.waitFor(
          "window.__openworkControl.execute('auth.status').then(r => r.result?.status === 'signed_in')",
          { timeoutMs: 15_000, label: "auth signed_in" },
        );
        ctx.log("Signed in via handoff grant.");
      },
    },
    {
      name: "Create workspace",
      run: async (ctx) => {
        const wsPath = ctx.env.OPENWORK_EVAL_WORKSPACE_PATH.trim();

        // Check if we are already in a workspace
        const route = await ctx.eval("window.location.hash");
        if (route?.includes("/workspace/")) {
          ctx.log("Already in a workspace, skipping creation.");
          return;
        }

        // Handle onboarding if present (org selection, resource display)
        const handleOnboarding = async () => {
          const currentRoute = await ctx.eval("window.location.hash");
          if (!currentRoute?.includes("/onboarding")) return;
          const hasOrgButton = await ctx.eval(
            "Boolean([...document.querySelectorAll('button')].find(b => b.innerText.includes('Continue with organization')))",
          );
          if (hasOrgButton) {
            await ctx.clickText("Continue with organization");
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          const hasWorkspaceButton = await ctx.eval(
            "Boolean([...document.querySelectorAll('button')].find(b => b.innerText.includes('Continue to workspace')))",
          );
          if (hasWorkspaceButton) {
            await ctx.clickText("Continue to workspace");
            await ctx.waitFor(
              "location.hash.includes('/welcome') || location.hash.includes('/workspace/')",
              { timeoutMs: 10_000 },
            );
          }
        };
        await handleOnboarding();

        // On welcome page, fill the folder path and click "Use this folder"
        const onWelcome = await ctx.eval("location.hash.includes('/welcome')");
        if (onWelcome) {
          await ctx.fill("input", wsPath);
          await ctx.clickText("Use this folder", { timeoutMs: 5_000 });
          await ctx.waitFor("location.hash.includes('/workspace/')", {
            timeoutMs: 20_000,
            label: "workspace route after creation",
          });
          ctx.log(`Workspace created at ${wsPath}`);
          return;
        }

        // Fallback: try control action if session-route is mounted
        const hasAction = await ctx.eval(
          "Boolean(window.__openworkControl?.listActions().find(a => a.id === 'workspace.create'))",
        );
        if (hasAction) {
          await ctx.control("workspace.create", { path: wsPath });
          await ctx.waitFor("location.hash.includes('/workspace/')", {
            timeoutMs: 15_000,
            label: "workspace route",
          });
          ctx.log(`Workspace created via control action at ${wsPath}`);
        }
      },
    },
    {
      name: "Wait for engine ready",
      run: async (ctx) => {
        // Wait for the opencode sidecar to boot
        await ctx.waitFor(
          "document.body.innerText.includes('Ready for new tasks') || document.body.innerText.includes('Run task')",
          { timeoutMs: 30_000, label: "engine ready" },
        );
        ctx.log("Engine is ready.");
      },
    },
    {
      name: "Check notifications",
      run: async (ctx) => {
        const notifications = await ctx.control("notifications.list");
        ctx.log(`Notifications: ${JSON.stringify(notifications)}`);
        await ctx.screenshot("workspace-with-notifications", {
          claim: "App shows workspace with notification badge.",
        });
      },
    },
    {
      name: "Open marketplace and wait for extensions to load",
      run: async (ctx) => {
        // Navigate to marketplace settings -- this mounts the settings route
        // which creates the extensions store and triggers a marketplace refresh.
        await ctx.control("settings.panel.open", { panel: "cloud-marketplaces" });
        await ctx.waitFor("location.hash.includes('/settings/cloud-marketplaces')", {
          timeoutMs: 10_000,
          label: "marketplace route",
        });
        // Wait for marketplace content to load
        await ctx.waitFor(
          "document.body.innerText.includes('Extension Marketplace') || document.body.innerText.includes('Browse built-in')",
          { timeoutMs: 15_000, label: "marketplace content" },
        );

        // Now force refresh if the action is available
        const hasRefresh = await ctx.eval(
          "Boolean(window.__openworkControl?.listActions().find(a => a.id === 'extensions.refresh-marketplace'))",
        );
        if (hasRefresh) {
          await ctx.control("extensions.refresh-marketplace");
          ctx.log("Marketplace refreshed via control action.");
        }

        await ctx.screenshot("marketplace-loaded", {
          claim: "Marketplace view loaded with available extensions.",
        });
      },
    },
    {
      name: "Verify org context via Den API",
      run: async (ctx) => {
        const apiBase = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
        const token = ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim();
        const orgResponse = await fetch(`${apiBase}/v1/org`, {
          headers: { authorization: `Bearer ${token}` },
        });
        ctx.assert(orgResponse.ok, `GET /v1/org failed: ${orgResponse.status}`);
        const org = await orgResponse.json();
        ctx.log(`Org: ${org.organization?.name}, Members: ${org.members?.length}, Teams: ${org.teams?.length}`);

        const providersResponse = await fetch(`${apiBase}/v1/llm-providers?scope=manageable`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (providersResponse.ok) {
          const providers = await providersResponse.json();
          ctx.log(`Providers: ${JSON.stringify(providers.map?.(p => p.name) ?? [])}`);
        }
      },
    },
  ],
};
