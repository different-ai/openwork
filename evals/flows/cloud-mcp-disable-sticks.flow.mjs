/**
 * Regression proof: disabling the auto-configured OpenWork Cloud Control MCP
 * ("openwork-cloud") sticks.
 *
 * Previously the background reconciler (syncCloudControlMcp) rewrote the
 * entry with `enabled: true` on every sync tick — settings mount, sign-in,
 * org change, and a 5-minute interval — because (a) it never consulted the
 * user's disable/remove intent and (b) its "recently synced" marker used a
 * refresh margin equal to the minted token TTL, so it was stale the instant
 * it was written. Users could not turn the MCP off.
 *
 * The fix persists the user's intent (localStorage
 * `openwork.den.mcp.cloudControlUserState`), makes the reconciler respect it
 * (plus an enabled:false guard), and fixes the marker margin. This flow
 * drives the real app:
 *   1. Sign in to OpenWork Cloud via desktop handoff.
 *   2. Wait for the reconciler to auto-configure openwork-cloud.
 *   3. Disable it via the Settings toggle.
 *   4. Remount settings (the exact trigger that used to resurrect it) and
 *      assert it is still Paused and the intent record persists.
 *   5. Re-enable it and assert the intent record clears.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL  Den API base
 * - OPENWORK_EVAL_DEN_TOKEN    Bearer session token for a seeded user
 */

const CLOUD_TITLE = "OpenWork Cloud Control";
const USER_STATE_KEY = "openwork.den.mcp.cloudControlUserState";
const CLICK_ANY = "button, [role=button], a, div, article, li, label";

// The configured-server row shows the friendly status next to the title;
// catalog cards do not. Use that to target the configured row.
const cloudRowExpr = (statuses) => `(() => {
  const buttons = [...document.querySelectorAll("button")];
  return buttons.some((el) => {
    const text = el.textContent ?? "";
    return text.includes(${JSON.stringify(CLOUD_TITLE)}) &&
      ${JSON.stringify(statuses)}.some((status) => text.includes(status));
  });
})()`;

// Background refreshes can collapse an expanded row between two separate
// clicks. This expression converges regardless: click the detail button when
// visible, otherwise (re-)expand the row and let the poll retry.
const expandAndClickDetailExpr = (statuses, label) => `(() => {
  const buttons = [...document.querySelectorAll("button")];
  const detail = buttons.find((el) => (el.textContent ?? "").trim() === ${JSON.stringify(label)});
  if (detail && !detail.disabled) {
    detail.click();
    return true;
  }
  const row = buttons.find((el) => {
    const text = el.textContent ?? "";
    return text.includes(${JSON.stringify(CLOUD_TITLE)}) &&
      ${JSON.stringify(statuses)}.some((status) => text.includes(status));
  });
  if (row) {
    row.scrollIntoView({ block: "center" });
    row.click();
  }
  return false;
})()`;

const CONFIGURED_STATUSES = ["Ready", "Paused", "Needs sign-in", "Offline", "Issue", "Checking"];

// Note: the catalog card up top also contains the title; the configured row
// is the one that shows a friendly status (Ready/Paused/...).
const scrollCloudRowExpr = `(() => {
  const statuses = ${JSON.stringify(CONFIGURED_STATUSES)};
  const buttons = [...document.querySelectorAll("button")];
  const row = buttons.find((el) => {
    const text = el.textContent ?? "";
    return text.includes(${JSON.stringify(CLOUD_TITLE)}) && statuses.some((status) => text.includes(status));
  });
  if (row) row.scrollIntoView({ block: "center" });
  return true;
})()`;

export default {
  id: "cloud-mcp-disable-sticks",
  title: "Disabling the OpenWork Cloud Control MCP sticks across sync",
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
      name: "Sign in to OpenWork Cloud via desktop handoff",
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
        // Post-sign-in org onboarding may appear; drive through it best-effort.
        await ctx.clickText("Acme Robotics", { selector: CLICK_ANY, timeoutMs: 10_000 }).catch(() => {});
        await ctx.clickText("Continue with organization", { timeoutMs: 10_000 }).catch(() => {});
        await ctx.clickText("Continue to workspace", { timeoutMs: 10_000 }).catch(() => {});
      },
    },
    {
      name: "Reconciler auto-configures the Cloud Control MCP",
      run: async (ctx) => {
        // Start from a clean slate for idempotent re-runs: clear any prior
        // user-intent record so the reconciler is allowed to configure it.
        await ctx.eval(`(() => { localStorage.removeItem(${JSON.stringify(USER_STATE_KEY)}); localStorage.removeItem("openwork.den.mcp.sync"); return true; })()`);
        await ctx.navigateHash("/settings/extensions/mcp");
        await ctx.waitFor("window.location.hash.includes('/settings/extensions/mcp')", { timeoutMs: 30_000 });
        await ctx.waitForText("Add Custom App", { timeoutMs: 30_000 });
        await ctx.waitFor(cloudRowExpr(CONFIGURED_STATUSES), {
          timeoutMs: 90_000,
          label: "openwork-cloud configured row",
        });
        // Idempotent re-runs: a previous run may have left the entry Paused.
        // Restore the enabled baseline before proving the disable behavior.
        const paused = await ctx.eval(cloudRowExpr(["Paused"]));
        if (paused) {
          ctx.log("Entry starts Paused from a previous run; re-enabling first.");
          await ctx.waitFor(expandAndClickDetailExpr(["Paused"], "Enable"), {
            timeoutMs: 30_000,
            label: "re-enable paused entry for a clean baseline",
          });
          await ctx.waitFor(`!${cloudRowExpr(["Paused"])}`, {
            timeoutMs: 60_000,
            label: "entry no longer Paused",
          });
        }
        await ctx.prove("Signing in auto-configures the openwork-cloud MCP", {
          assert: async () => {
            await ctx.waitFor(cloudRowExpr(CONFIGURED_STATUSES.filter((status) => status !== "Paused")), {
              timeoutMs: 90_000,
              label: "openwork-cloud configured row (enabled)",
            });
            await ctx.eval(scrollCloudRowExpr);
          },
          screenshot: {
            name: "cloud-mcp-configured",
            claim: "OpenWork Cloud Control appears as a configured MCP after cloud sign-in.",
            requireText: [CLOUD_TITLE],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "Disable the Cloud Control MCP",
      run: async (ctx) => {
        await ctx.prove("The user can disable the Cloud Control MCP and it reports Paused", {
          action: async () => {
            await ctx.waitFor(expandAndClickDetailExpr(CONFIGURED_STATUSES, "Disable"), {
              timeoutMs: 30_000,
              label: "expand openwork-cloud row and click Disable",
            });
          },
          assert: async () => {
            await ctx.waitFor(cloudRowExpr(["Paused"]), {
              timeoutMs: 30_000,
              label: "openwork-cloud row shows Paused",
            });
            const intent = await ctx.eval(`localStorage.getItem(${JSON.stringify(USER_STATE_KEY)})`);
            ctx.assert(intent === "disabled", `Expected persisted intent "disabled", got ${JSON.stringify(intent)}`);
            await ctx.eval(scrollCloudRowExpr);
          },
          screenshot: {
            name: "cloud-mcp-disabled",
            claim: "OpenWork Cloud Control is Paused after the user disables it.",
            requireText: [CLOUD_TITLE, "Paused"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "Disable survives the resurrection trigger (settings remount + sync)",
      run: async (ctx) => {
        await ctx.prove("Remounting Settings no longer re-enables the disabled MCP", {
          action: async () => {
            // Leaving and re-entering Settings remounts the cloud auto-sync
            // hook, which fires syncCloudControlMcp immediately — the exact
            // path that used to rewrite the entry with enabled: true.
            await ctx.navigateHash("/settings/general");
            await ctx.waitFor("window.location.hash.includes('/settings/general')", { timeoutMs: 20_000 });
            await ctx.navigateHash("/settings/extensions/mcp");
            await ctx.waitFor("window.location.hash.includes('/settings/extensions/mcp')", { timeoutMs: 20_000 });
            await ctx.waitForText("Add Custom App", { timeoutMs: 30_000 });
            // Give the sync tick time to run (it fires on mount).
            await new Promise((resolve) => setTimeout(resolve, 6_000));
          },
          assert: async () => {
            await ctx.waitFor(cloudRowExpr(["Paused"]), {
              timeoutMs: 30_000,
              label: "openwork-cloud row still Paused after remount",
            });
            const intent = await ctx.eval(`localStorage.getItem(${JSON.stringify(USER_STATE_KEY)})`);
            ctx.assert(intent === "disabled", `Persisted intent lost after sync tick: ${JSON.stringify(intent)}`);
            // Expand the row details (shows the Enable action) so this frame
            // is visually distinct from the pre-remount Paused frame.
            await ctx.waitFor(`(() => {
              const buttons = [...document.querySelectorAll("button")];
              if (buttons.some((el) => (el.textContent ?? "").trim() === "Enable")) return true;
              const row = buttons.find((el) => {
                const text = el.textContent ?? "";
                return text.includes(${JSON.stringify(CLOUD_TITLE)}) && text.includes("Paused");
              });
              if (row) { row.scrollIntoView({ block: "center" }); row.click(); }
              return false;
            })()`, { timeoutMs: 15_000, label: "expanded paused row details" });
          },
          screenshot: {
            name: "cloud-mcp-still-disabled",
            claim: "OpenWork Cloud Control stays Paused after the settings remount sync tick.",
            requireText: [CLOUD_TITLE, "Paused"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "Re-enabling clears the intent and hands control back to the reconciler",
      run: async (ctx) => {
        await ctx.prove("The user can re-enable the Cloud Control MCP", {
          action: async () => {
            await ctx.waitFor(expandAndClickDetailExpr(["Paused"], "Enable"), {
              timeoutMs: 30_000,
              label: "expand paused openwork-cloud row and click Enable",
            });
          },
          assert: async () => {
            await ctx.waitFor(
              `localStorage.getItem(${JSON.stringify(USER_STATE_KEY)}) === null`,
              { timeoutMs: 20_000, label: "user intent cleared on enable" },
            );
            await ctx.waitFor(cloudRowExpr(CONFIGURED_STATUSES.filter((status) => status !== "Paused")), {
              timeoutMs: 60_000,
              label: "openwork-cloud row no longer Paused",
            });
            // Bring the row into the viewport so the frame is visually
            // distinct from the previous capture (defeats the dedup guard).
            await ctx.eval(scrollCloudRowExpr);
          },
          screenshot: {
            name: "cloud-mcp-reenabled",
            claim: "OpenWork Cloud Control leaves Paused after re-enable and the intent record is cleared.",
            requireText: [CLOUD_TITLE],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
  ],
};
