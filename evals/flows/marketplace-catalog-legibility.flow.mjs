import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, denWebUrl, signInApi, signInViaBrowser } from "./lib/den-web.mjs";

const FLOW_ID = "marketplace-catalog-legibility";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const OWNER_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const OWNER_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const EMPTY_MARKETPLACE_NAME = `Fraimz Empty Catalog ${Date.now()}`;

const state = {
  token: "",
  emptyMarketplaceId: "",
  populatedMarketplaceId: "",
  populatedMarketplaceName: "",
  populatedPluginCount: 0,
};

function authHeaders() {
  return { authorization: `Bearer ${state.token}` };
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : JSON.stringify(actual).slice(0, 1_200),
  });
  ctx.assert(
    condition,
    `${assertion}${actual === undefined ? "" : `. Actual: ${JSON.stringify(actual).slice(0, 600)}`}`,
  );
}

async function navigateTo(ctx, path) {
  const url = new URL(path, denWebUrl()).toString();
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${path}` });
}

function screenshot(name, claim, requireText, rejectText = []) {
  return {
    name,
    claim,
    requireText,
    rejectText: ["Something went wrong", ...rejectText],
  };
}

/** Reads the rendered catalogue rows so assertions witness the DOM, not the API. */
const READ_ROWS = `(() => {
  const list = document.querySelector('[data-testid="catalog-list"]');
  if (!list) return null;
  return [...list.querySelectorAll('[data-testid="catalog-row"]')].map((row) => ({
    title: row.querySelector('[data-testid="catalog-row-title"]')?.textContent?.trim() ?? "",
    value: row.querySelector('[data-testid="catalog-row-value"]')?.textContent?.trim() ?? "",
    muted: row.querySelector('[data-testid="catalog-row-value"]')?.dataset.muted === "true",
    badge: row.querySelector('[data-testid="catalog-row-badge"]')?.textContent?.trim() ?? "",
    left: Math.round(row.querySelector('[data-testid="catalog-row-value"]')?.getBoundingClientRect().right ?? 0),
  }));
})()`;

export default {
  id: FLOW_ID,
  title: "The marketplace catalogue reads as one list, with identity, aligned counts, and readiness that only speaks when it must",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Setup",
      run: async (ctx) => {
        await ctx.client.send("Emulation.setDeviceMetricsOverride", {
          width: 1440,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });

        state.token = (await signInApi(OWNER_EMAIL, OWNER_PASSWORD)) ?? "";
        witness(ctx, state.token.length > 0, "The seeded workspace owner can sign in", { email: OWNER_EMAIL });

        // A failed run leaves its scratch marketplace behind; clear them so the
        // directory shows one empty catalogue rather than a pile of them.
        const existing = await denApiFetch("/v1/marketplaces?status=active&limit=100", {
          headers: authHeaders(),
        });
        for (const item of existing.body?.items ?? []) {
          if (typeof item?.name === "string" && item.name.startsWith("Fraimz Empty Catalog")) {
            await denApiFetch(`/v1/marketplaces/${encodeURIComponent(item.id)}/delete`, {
              method: "POST",
              headers: authHeaders(),
            });
          }
        }

        const created = await denApiFetch("/v1/marketplaces", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ name: EMPTY_MARKETPLACE_NAME }),
        });
        state.emptyMarketplaceId = created.body?.item?.id ?? "";
        witness(
          ctx,
          created.response.status === 201 && state.emptyMarketplaceId.length > 0,
          "An empty marketplace exists so the zero state is real data, not a mock",
          { status: created.response.status },
        );

        const marketplaces = await denApiFetch("/v1/marketplaces?status=active&limit=100", {
          headers: authHeaders(),
        });
        const populated = (marketplaces.body?.items ?? [])
          .filter((item) => (item?.pluginCount ?? 0) > 0)
          .sort((a, b) => (b?.pluginCount ?? 0) - (a?.pluginCount ?? 0))[0];
        state.populatedMarketplaceId = populated?.id ?? "";
        state.populatedMarketplaceName = populated?.name ?? "";
        state.populatedPluginCount = populated?.pluginCount ?? 0;
        witness(
          ctx,
          state.populatedMarketplaceId.length > 0,
          "At least one seeded marketplace actually contains plugins",
          { name: state.populatedMarketplaceName, pluginCount: state.populatedPluginCount },
        );

        await signInViaBrowser(ctx, OWNER_EMAIL, OWNER_PASSWORD);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The marketplace directory renders as one list with per-entry identity", {
          voiceover: vo[0],
          action: async () => {
            await navigateTo(ctx, "/dashboard/marketplaces");

            await ctx.waitForText("OpenWork Marketplace", { timeoutMs: 30_000 });
            await ctx.waitFor(`Boolean(document.querySelector('[data-testid="catalog-row"]'))`, {
              timeoutMs: 20_000,
              label: "catalogue rows",
            });
          },
          assert: async () => {
            const rows = await ctx.eval(READ_ROWS);
            witness(ctx, Array.isArray(rows) && rows.length > 1, "The directory renders a single divided list of marketplaces", {
              rowCount: rows?.length,
            });

            const identityCount = await ctx.eval(
              `document.querySelectorAll('[data-testid="catalog-identity-tile"]').length`,
            );
            witness(
              ctx,
              identityCount === rows.length,
              "Every row carries its own identity tile rather than a hashed colour slab",
              { identityCount, rowCount: rows.length },
            );

            const rightEdges = new Set(rows.map((row) => row.left));
            witness(ctx, rightEdges.size === 1, "Every plugin count shares one right edge, so the figures compare down the column", {
              rightEdges: [...rightEdges],
            });

            const counts = rows.map((row) => Number(row.value));
            const descending = counts.every((count, index) => index === 0 || counts[index - 1] >= count);
            witness(
              ctx,
              descending,
              "Stocked catalogues lead the list instead of whatever was created most recently",
              { order: rows.map((row) => `${row.title}: ${row.value}`) },
            );
          },
          screenshot: screenshot(
            "marketplace-directory-list",
            "Marketplaces render as one divided list: logo or monogram on the left, a single aligned column of plugin counts on the right.",
            ["OpenWork Marketplace", "Plugins"],
          ),
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("An empty marketplace reads as a zero in the same column", {
          voiceover: vo[1],
          action: async () => {
            await ctx.fill('input[type="search"]', EMPTY_MARKETPLACE_NAME);
            await ctx.waitFor(
              `(() => {
                const rows = document.querySelectorAll('[data-testid="catalog-row"]');
                return rows.length === 1;
              })()`,
              { timeoutMs: 15_000, label: "filtered to the empty marketplace" },
            );
          },
          assert: async () => {
            const rows = await ctx.eval(READ_ROWS);
            const row = rows?.[0];
            witness(ctx, row?.title === EMPTY_MARKETPLACE_NAME, "Search narrows the list to the empty marketplace", {
              title: row?.title,
            });
            witness(ctx, row?.value === "0", "The empty marketplace shows a zero rather than an absent count", {
              value: row?.value,
            });
            witness(ctx, row?.muted === true, "That zero is dimmed, so it reads as a quantity and not as a live count", {
              muted: row?.muted,
            });
          },
          screenshot: screenshot(
            "marketplace-empty-zero",
            "A marketplace with nothing in it shows a greyed zero in the same column as every other count.",
            [EMPTY_MARKETPLACE_NAME, "0"],
          ),
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("A marketplace detail shows what each plugin contains", {
          voiceover: vo[2],
          action: async () => {
            await navigateTo(ctx, `/dashboard/marketplaces/${encodeURIComponent(state.populatedMarketplaceId)}`);
            await ctx.waitForText(state.populatedMarketplaceName, { timeoutMs: 30_000 });
            await ctx.waitFor(`Boolean(document.querySelector('[data-testid="catalog-row"]'))`, {
              timeoutMs: 20_000,
              label: "plugin rows",
            });
          },
          assert: async () => {
            const rows = await ctx.eval(READ_ROWS);
            witness(
              ctx,
              Array.isArray(rows) && rows.length === state.populatedPluginCount,
              "Every plugin the API reports for this marketplace is rendered as a row",
              { rendered: rows?.length, apiCount: state.populatedPluginCount },
            );
            witness(
              ctx,
              rows.every((row) => /^\d+$/.test(row.value)),
              "Each plugin states how many components it carries",
              { values: rows.map((row) => row.value) },
            );

            const headerTile = await ctx.eval(
              `Boolean(document.querySelector('[data-testid="catalog-identity-tile"]'))`,
            );
            witness(ctx, headerTile === true, "The detail header reuses the same identity tile as the directory");
          },
          screenshot: screenshot(
            "marketplace-detail-contents",
            "The marketplace detail keeps the directory's identity tile and lists its plugins with an aligned component count.",
            [state.populatedMarketplaceName, "COMPONENTS", "Add a plugin"],
          ),
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Readiness stays silent when every plugin is cloud ready", {
          voiceover: vo[3],
          action: async () => {
            // Scroll to the tail of the catalogue: the claim is about every
            // row staying quiet, not just the rows above the fold.
            await ctx.eval(`(() => {
              const rows = [...document.querySelectorAll('[data-testid="catalog-row"]')];
              rows[rows.length - 1]?.scrollIntoView({ block: "end" });
              return true;
            })()`);
            await ctx.waitFor(
              `(() => {
                const rows = [...document.querySelectorAll('[data-testid="catalog-row"]')];
                const last = rows[rows.length - 1];
                if (!last) return false;
                const box = last.getBoundingClientRect();
                return box.bottom > 0 && box.bottom <= window.innerHeight + 2;
              })()`,
              { timeoutMs: 20_000, label: "last plugin row in view" },
            );
          },
          assert: async () => {
            const readiness = await denApiFetch(
              `/v1/marketplaces/${encodeURIComponent(state.populatedMarketplaceId)}/resolved`,
              { headers: authHeaders() },
            );
            const states = (readiness.body?.item?.plugins ?? []).map(
              (plugin) => plugin?.cloudReadiness?.state ?? "unknown",
            );
            const needsAction = states.filter(
              (value) => value !== "ready" && value !== "desktop_only" && value !== "unknown",
            ).length;

            const badges = await ctx.eval(
              `[...document.querySelectorAll('[data-testid="catalog-row-badge"]')].map((node) => node.textContent.trim())`,
            );

            witness(
              ctx,
              badges.every((badge) => badge !== "Cloud ready"),
              "No row claims to be cloud ready, because on Den every row would",
              { badges },
            );
            witness(
              ctx,
              badges.length === needsAction,
              "A badge appears exactly for the plugins the API says are not settled yet",
              { badges, apiStates: states },
            );
          },
          screenshot: screenshot(
            "marketplace-readiness-quiet",
            "No plugin advertises being cloud ready; the page only speaks up for a plugin that needs a connection.",
            [state.populatedMarketplaceName],
            ["Cloud ready", "Desktop only"],
          ),
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("The plugin directory uses the same list and its tabs carry counts", {
          voiceover: vo[4],
          action: async () => {
            await navigateTo(ctx, "/dashboard/plugins");
            await ctx.waitForText("Plugins", { timeoutMs: 30_000 });
            await ctx.waitFor(`Boolean(document.querySelector('[data-testid="catalog-row"]'))`, {
              timeoutMs: 20_000,
              label: "plugin rows",
            });
          },
          assert: async () => {
            const rows = await ctx.eval(READ_ROWS);
            witness(ctx, Array.isArray(rows) && rows.length > 0, "The plugin directory renders the same divided list", {
              rowCount: rows?.length,
            });

            const rightEdges = new Set(rows.map((row) => row.left));
            witness(ctx, rightEdges.size === 1, "Component counts share one right edge here too", {
              rightEdges: [...rightEdges],
            });

            const tabs = await ctx.eval(`(() => {
              return [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent.trim());
            })()`);
            const labelled = tabs.filter((tab) => /\d/.test(tab));
            witness(
              ctx,
              labelled.length === tabs.length,
              "Every tab states how much is behind it, including the empty ones",
              { tabs },
            );
          },
          screenshot: screenshot(
            "plugins-directory-counted-tabs",
            "The plugins directory is the same list, and every tab shows its count so empty tabs are visible without clicking.",
            ["Plugins", "COMPONENTS", "Create plugin"],
          ),
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("The plugin detail opens with the same identity the user clicked", {
          voiceover: vo[5],
          action: async () => {
            await ctx.eval(`(() => {
              document.querySelector('[data-testid="catalog-row"]')?.click();
              return true;
            })()`);
            await ctx.waitFor("location.pathname.includes('/dashboard/plugins/')", {
              timeoutMs: 30_000,
              label: "plugin detail route",
            });
            await ctx.waitFor(
              `Boolean(document.querySelector('[data-testid="catalog-identity-tile"]'))`,
              { timeoutMs: 20_000, label: "plugin identity tile" },
            );
          },
          assert: async () => {
            const header = await ctx.eval(`(() => {
              const tile = document.querySelector('[data-testid="catalog-identity-tile"]');
              const heading = document.querySelector('h1');
              return {
                tile: tile?.textContent?.trim() ?? "",
                title: heading?.textContent?.trim() ?? "",
                meta: heading?.parentElement?.parentElement?.innerText ?? "",
              };
            })()`);

            witness(
              ctx,
              header.title.length > 0 && header.tile === header.title.slice(0, 1).toUpperCase(),
              "The detail header carries the same monogram tile the row showed",
              header,
            );
            witness(ctx, header.meta.includes("Updated"), "Provenance and recency sit on one line under the title", {
              meta: header.meta.slice(0, 200),
            });
            witness(
              ctx,
              state.token.length > 0 && !header.meta.includes("Cloud ready"),
              "The header does not repeat a readiness claim that would be true of every plugin",
            );
          },
          screenshot: screenshot(
            "plugin-detail-identity",
            "The plugin detail opens with the same monogram tile, the marketplace it came from, and when it last changed.",
            ["Updated", "Back"],
            ["Cloud ready"],
          ),
        });
      },
    },
  ],
};
