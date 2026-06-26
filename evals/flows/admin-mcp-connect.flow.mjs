/**
 * Regression proof for the admin MCP OAuth discovery fix (fix/admin-mcp).
 *
 * The admin MCP at den-api `/mcp/admin` reused the org-scoped `/mcp` auth
 * helpers but never registered its own OAuth protected-resource metadata, so a
 * spec-compliant MCP client connecting to `<denApi>/mcp/admin` 404'd during
 * discovery and the admin MCP never attached. The fix registers the discovery
 * routes for the admin path so the OAuth handshake resolves.
 *
 * This flow drives the real Electron app as an allowlisted platform admin
 * (alex@acme.test, seeded into AdminAllowlistTable on the Daytona Den):
 *   1. Sign in via desktop handoff (handles org onboarding + workspace pick).
 *   2. Open Settings -> Extensions -> MCP and reveal the hidden admin entry.
 *   3. Connect "OpenWork Admin Analytics".
 *   4. Assert the entry flips to Connected and the connected app count grows —
 *      only possible if admin OAuth discovery + token mint + allowlist all
 *      succeed end-to-end against den-api /mcp/admin.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL  Den API base (the fixed sandbox Den)
 * - OPENWORK_EVAL_DEN_TOKEN    Bearer session token for the admin account
 */

const ADMIN_TITLE = "OpenWork Admin Analytics";
const WORKSPACE_FOLDER = "/workspace/admin-mcp-test";

const CLICK_ANY = "button, [role=button], a, div, article, li, label";

// True when the admin card carries its green "Connected" badge. Climbs from the
// leaf title node to the nearest ancestor that also contains the badge text, so
// it works regardless of the exact card DOM nesting.
const ADMIN_CONNECTED_EXPR = `(() => {
  const all = [...document.querySelectorAll("*")];
  const titleEl = all.find((e) => e.children.length === 0 && (e.textContent ?? "").trim() === ${JSON.stringify(ADMIN_TITLE)});
  if (!titleEl) return false;
  let card = titleEl;
  for (let i = 0; i < 6 && card; i++) {
    if ((card.textContent ?? "").includes("Connected")) return true;
    card = card.parentElement;
  }
  return false;
})()`;

export default {
  id: "admin-mcp-connect",
  title: "Admin MCP connects end-to-end after OAuth discovery fix",
  spec: "evals/cloud-mcp-agent-flows.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN"],
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000 });
      },
    },
    {
      name: "Sign in as the admin user via desktop handoff",
      run: async (ctx) => {
        const signedIn = await ctx.eval(
          "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())",
        );
        if (signedIn) {
          ctx.log("Already signed in; reusing session.");
          return;
        }
        const apiBase = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
        const response = await fetch(`${apiBase}/v1/auth/desktop-handoff`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ desktopScheme: "openwork" }),
        });
        const body = await response.text();
        ctx.assert(response.ok, `Handoff create failed: ${response.status} ${body.slice(0, 200)}`);
        const payload = JSON.parse(body);
        ctx.assert(typeof payload.openworkUrl === "string" && payload.openworkUrl.length > 0, "No openworkUrl in handoff response.");

        await ctx.navigateHash("/settings/cloud-account");
        await ctx.expectHashIncludes("/settings/cloud-account");
        await ctx.clickText("Paste sign-in code", { timeoutMs: 30_000 });
        await ctx.fill("#den-signin-link", payload.openworkUrl);
        await ctx.clickText("Finish sign-in");
        await ctx.waitFor(
          "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())",
          { timeoutMs: 45_000, label: "persisted den auth token" },
        );
      },
    },
    {
      name: "Complete org onboarding and open a workspace",
      run: async (ctx) => {
        // Skip if we are already inside a workspace (idempotent re-runs).
        const inWorkspace = await ctx.eval("window.location.hash.includes('/workspace/')");
        if (inWorkspace) {
          ctx.log("Already in a workspace; skipping onboarding.");
          return;
        }
        // Org picker -> select Acme Robotics -> Continue with organization.
        await ctx.waitForText("Choose your organization", { timeoutMs: 30_000 }).catch(() => {});
        await ctx.clickText("Acme Robotics", { selector: CLICK_ANY, timeoutMs: 20_000 }).catch(() => {});
        await ctx.clickText("Continue with organization", { timeoutMs: 20_000 }).catch(() => {});
        // Resources summary -> Continue to workspace.
        await ctx.clickText("Continue to workspace", { timeoutMs: 30_000 }).catch(() => {});
        // Welcome -> pick a folder -> Use this folder.
        await ctx.waitForText("Pick a folder", { timeoutMs: 30_000 });
        await ctx.fill('input[placeholder="/workspace/my-project"]', WORKSPACE_FOLDER);
        await ctx.clickText("Use this folder", { timeoutMs: 20_000 });
        await ctx.waitFor("window.location.hash.includes('/workspace/')", {
          timeoutMs: 60_000,
          label: "workspace created and opened",
        });
      },
    },
    {
      name: "Reveal the hidden admin MCP entry",
      run: async (ctx) => {
        await ctx.navigateHash("/settings/extensions/mcp");
        await ctx.waitFor("window.location.hash.includes('/settings/extensions/mcp')", { timeoutMs: 30_000 });
        await ctx.waitForText("Add Custom App", { timeoutMs: 30_000 });
        // The admin entry is defaultHidden — reveal it via "Show hidden".
        await ctx.clickText("Show hidden", { timeoutMs: 30_000 });
        await ctx.prove("The hidden admin MCP entry is discoverable after Show hidden", {
          assert: async () => {
            await ctx.expectText(ADMIN_TITLE, { timeoutMs: 20_000 });
          },
          screenshot: {
            name: "admin-entry-revealed",
            claim: "OpenWork Admin Analytics appears in MCP settings after Show hidden.",
            requireText: [ADMIN_TITLE],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "Open the admin entry detail and connect",
      run: async (ctx) => {
        // Idempotent: if the admin MCP is already connected from a prior run,
        // the card shows "Connected" and there is no Connect button to click.
        const alreadyConnected = await ctx.eval(ADMIN_CONNECTED_EXPR);
        if (alreadyConnected) {
          ctx.log("Admin MCP already connected; skipping connect click.");
          return;
        }
        // Open the (smallest) clickable region containing the admin title.
        await ctx.eval(`(() => {
          const all = [...document.querySelectorAll(${JSON.stringify(CLICK_ANY)})];
          const cands = all.filter((e) => (e.textContent ?? "").includes(${JSON.stringify(ADMIN_TITLE)}));
          cands.sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length);
          const card = cands[0];
          if (card) { card.scrollIntoView({ block: "center" }); card.click(); }
          return Boolean(card);
        })()`);
        // Detail modal -> Connect.
        await ctx.clickText("Connect", { timeoutMs: 30_000 });
      },
    },
    {
      name: "Admin MCP attaches end-to-end (engine connected)",
      run: async (ctx) => {
        // The engine attaches to <denApi>/mcp/admin. The card only flips to its
        // green "Connected" badge when the engine reports the server connected —
        // which requires OAuth discovery to resolve, the minted token accepted
        // for the /mcp resource, and the admin allowlist gate to pass. Before
        // the discovery fix this never reached "connected".
        await ctx.prove("The admin MCP attaches and shows Connected", {
          assert: async () => {
            await ctx.waitFor(ADMIN_CONNECTED_EXPR, {
              timeoutMs: 60_000,
              label: "admin MCP card shows Connected",
            });
            await ctx.expectNoText("Something went wrong");
            // Scroll the admin card into view so the connected frame is visually
            // distinct from the "revealed" frame (defeats the dedup guard).
            await ctx.eval(`(() => {
              const all = [...document.querySelectorAll("*")];
              const el = all.find((e) => e.children.length === 0 && (e.textContent ?? "").trim() === ${JSON.stringify(ADMIN_TITLE)});
              if (el) el.scrollIntoView({ block: "center" });
              return true;
            })()`);
          },
          screenshot: {
            name: "admin-mcp-connected",
            claim: "OpenWork Admin Analytics shows Connected — admin MCP attached end-to-end.",
            requireText: [ADMIN_TITLE, "Connected"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
  ],
};
