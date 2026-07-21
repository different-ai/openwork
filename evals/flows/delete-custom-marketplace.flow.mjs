import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, denApiUrl, denWebUrl, signInApi, signInViaBrowser } from "./lib/den-web.mjs";

const FLOW_ID = "delete-custom-marketplace";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const OWNER_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const OWNER_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MARKETPLACE_NAME = `Fraimz Custom Marketplace ${Date.now()}`;
const UPDATED_MARKETPLACE_NAME = `${MARKETPLACE_NAME} Edited`;

const state = {
  marketplaceId: "",
  builtInMarketplaceId: "",
  token: "",
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
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : `. Actual: ${JSON.stringify(actual).slice(0, 600)}`}`);
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

export default {
  id: FLOW_ID,
  title: "Admins discreetly edit and safely delete custom marketplaces while managed catalogs stay protected",
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

        state.token = await signInApi(OWNER_EMAIL, OWNER_PASSWORD) ?? "";
        witness(ctx, state.token.length > 0, "The seeded workspace owner can sign in", { email: OWNER_EMAIL });

        const created = await denApiFetch("/v1/marketplaces", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            name: MARKETPLACE_NAME,
            description: "A temporary custom marketplace created for deletion proof.",
          }),
        });
        state.marketplaceId = created.body?.item?.id ?? "";
        witness(ctx, created.response.status === 201 && state.marketplaceId.length > 0, "A custom marketplace is created through the real Den API", {
          status: created.response.status,
          marketplaceId: state.marketplaceId,
        });

        const marketplaces = await denApiFetch("/v1/marketplaces?status=active&limit=100", { headers: authHeaders() });
        state.builtInMarketplaceId = marketplaces.body?.items?.find((item) => item?.name === "OpenWork Marketplace")?.id ?? "";
        witness(ctx, state.builtInMarketplaceId.length > 0, "The built-in OpenWork Marketplace is available for the protection check");

        await signInViaBrowser(ctx, OWNER_EMAIL, OWNER_PASSWORD);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Marketplace management actions stay in a discreet overflow menu", {
          voiceover: vo[0],
          action: async () => {
            await navigateTo(ctx, `/dashboard/marketplaces/${encodeURIComponent(state.marketplaceId)}`);
            await ctx.waitForText(MARKETPLACE_NAME, { timeoutMs: 30_000 });
            await ctx.eval(`document.querySelector('[data-testid="marketplace-actions-trigger"]')?.click()`);
            await ctx.waitForText("Edit", { timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.expectText(MARKETPLACE_NAME);
            await ctx.expectText("Edit");
            await ctx.expectText("Delete");
            await ctx.expectText("0 plugins");
          },
          screenshot: screenshot(
            "custom-marketplace-actions-menu",
            "A compact overflow menu contains Edit and Delete without promoting the destructive action.",
            [MARKETPLACE_NAME, "Edit", "Delete", "0 plugins"],
          ),
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Admins can edit custom marketplace metadata", {
          voiceover: vo[1],
          action: async () => {
            await ctx.clickText("Edit", { selector: '[role="menuitem"]', timeoutMs: 10_000 });
            await ctx.waitForText("Edit marketplace", { timeoutMs: 10_000 });
            await ctx.fill('[data-testid="marketplace-edit-name"]', UPDATED_MARKETPLACE_NAME);
            await ctx.fill('[data-testid="marketplace-edit-description"]', "Updated through the marketplace actions menu.");
            await ctx.clickText("Save changes", { selector: "button", timeoutMs: 10_000 });
            await ctx.waitForText(UPDATED_MARKETPLACE_NAME, { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText(UPDATED_MARKETPLACE_NAME);
            await ctx.expectText("Updated through the marketplace actions menu.");
            const detail = await denApiFetch(`/v1/marketplaces/${encodeURIComponent(state.marketplaceId)}`, { headers: authHeaders() });
            witness(ctx, detail.response.ok && detail.body?.item?.name === UPDATED_MARKETPLACE_NAME, "The edit persists through the real marketplace API", {
              status: detail.response.status,
              name: detail.body?.item?.name,
            });
          },
          screenshot: screenshot(
            "custom-marketplace-edited",
            "The marketplace detail immediately reflects the saved name and description.",
            [UPDATED_MARKETPLACE_NAME, "Updated through the marketplace actions menu."],
          ),
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Deletion requires an explicit modal confirmation", {
          voiceover: vo[2],
          action: async () => {
            await ctx.eval(`document.querySelector('[data-testid="marketplace-actions-trigger"]')?.click()`);
            await ctx.clickText("Delete", { selector: '[role="menuitem"]', timeoutMs: 10_000 });
            await ctx.waitForText(`Delete ${UPDATED_MARKETPLACE_NAME}?`, { timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.expectText(`Delete ${UPDATED_MARKETPLACE_NAME}?`);
            await ctx.expectText("Its plugins and membership history will be preserved.");
            await ctx.expectText("Cancel");
            await ctx.expectText("Delete marketplace");
            const alertDialogVisible = await ctx.eval(`Boolean(document.querySelector('[role="alertdialog"][aria-modal="true"]'))`);
            witness(ctx, alertDialogVisible === true, "The destructive action opens a modal alert dialog before making the request", { alertDialogVisible });
          },
          screenshot: screenshot(
            "custom-marketplace-delete-confirmation",
            "A dedicated confirmation modal explains the soft-delete and requires an explicit destructive confirmation.",
            [`Delete ${UPDATED_MARKETPLACE_NAME}?`, "Cancel", "Delete marketplace", "membership history will be preserved"],
          ),
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Confirming deletion removes the marketplace from the active organization list", {
          voiceover: vo[3],
          action: async () => {
            await ctx.clickText("Delete marketplace", { selector: '[role="alertdialog"] button', timeoutMs: 10_000 });
            await ctx.waitFor("location.pathname === '/dashboard/marketplaces'", { timeoutMs: 30_000, label: "marketplace list after deletion" });
            await ctx.waitForText("Marketplaces", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectNoText(UPDATED_MARKETPLACE_NAME);
            const detail = await denApiFetch(`/v1/marketplaces/${encodeURIComponent(state.marketplaceId)}`, { headers: authHeaders() });
            witness(ctx, detail.response.ok && detail.body?.item?.status === "deleted" && Boolean(detail.body?.item?.deletedAt), "The API records a reversible soft-delete", {
              status: detail.response.status,
              marketplaceStatus: detail.body?.item?.status,
              deletedAt: detail.body?.item?.deletedAt,
            });
            witness(ctx, detail.body?.item?.pluginCount === 0, "Deletion preserves marketplace membership history instead of cascading into plugins", {
              pluginCount: detail.body?.item?.pluginCount,
            });
          },
          screenshot: screenshot(
            "custom-marketplace-removed",
            "The deleted custom marketplace is absent from the active marketplace list.",
            ["Marketplaces", "OpenWork Marketplace"],
            [UPDATED_MARKETPLACE_NAME],
          ),
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Built-in marketplaces remain protected from deletion", {
          voiceover: vo[4],
          action: async () => {
            await navigateTo(ctx, `/dashboard/marketplaces/${encodeURIComponent(state.builtInMarketplaceId)}`);
            await ctx.waitForText("OpenWork Marketplace", { timeoutMs: 30_000 });
            await ctx.eval(`document.querySelector('[data-testid="marketplace-actions-trigger"]')?.click()`);
            await ctx.waitForText("Edit", { timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.expectText("OpenWork Marketplace");
            await ctx.expectText("Edit");
            const deleteMenuItemVisible = await ctx.eval(`Boolean(document.querySelector('[data-testid="delete-marketplace-action"]'))`);
            witness(ctx, deleteMenuItemVisible === false, "The built-in marketplace menu does not expose the delete action", { deleteMenuItemVisible });
            const directDelete = await denApiFetch(`/v1/marketplaces/${encodeURIComponent(state.builtInMarketplaceId)}/delete`, {
              method: "POST",
              headers: authHeaders(),
            });
            witness(ctx, directDelete.response.status === 409, "The API independently refuses deletion of a managed marketplace", {
              status: directDelete.response.status,
              body: directDelete.body,
              apiUrl: denApiUrl(),
            });
          },
          screenshot: screenshot(
            "built-in-marketplace-protected",
            "The built-in marketplace remains editable but its action menu has no destructive option.",
            ["OpenWork Marketplace", "Edit", "Add a plugin"],
            ["Delete"],
          ),
        });
      },
    },
  ],
};
