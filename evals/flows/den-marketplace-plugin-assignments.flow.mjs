import {
  denApiFetch,
  denWebUrl,
  signInApi,
  signInViaBrowser,
} from "./lib/den-web.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "den-marketplace-plugin-assignments";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const ADMIN_EMAIL =
  process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD =
  process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const unique = Date.now().toString(36);

const state = {
  token: "",
  marketplaceId: "",
  marketplaceName: `Assignment proof marketplace ${unique}`,
  pluginId: "",
  pluginName: `Assignment proof plugin ${unique}`,
};

function authHeaders() {
  return { authorization: `Bearer ${state.token}` };
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual:
      actual === undefined
        ? undefined
        : JSON.stringify(actual).slice(0, 1_200),
  });
  ctx.assert(
    condition,
    `${assertion}${
      actual === undefined
        ? ""
        : `. Actual: ${JSON.stringify(actual).slice(0, 600)}`
    }`,
  );
}

async function navigateTo(ctx, path) {
  const url = new URL(path, denWebUrl()).toString();
  await ctx.eval(
    `(() => { location.assign(${JSON.stringify(url)}); return true; })()`,
  );
  await ctx.waitFor("document.readyState === 'complete'", {
    timeoutMs: 30_000,
    label: `load ${path}`,
  });
}

async function createFixtures(ctx) {
  state.token = (await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD)) ?? "";
  witness(ctx, state.token.length > 0, "The seeded administrator can sign in", {
    email: ADMIN_EMAIL,
  });

  const marketplace = await denApiFetch("/v1/marketplaces", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      name: state.marketplaceName,
      description: "Temporary Marketplace for Plugin relationship proof.",
    }),
  });
  state.marketplaceId = marketplace.body?.item?.id ?? "";
  witness(
    ctx,
    marketplace.response.status === 201 && state.marketplaceId.length > 0,
    "The proof creates an active Marketplace through the real Den API",
    {
      status: marketplace.response.status,
      marketplaceId: state.marketplaceId,
    },
  );

  const plugin = await denApiFetch("/v1/plugins", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      name: state.pluginName,
      description: "Temporary active Plugin for Marketplace assignment proof.",
      orgWide: true,
    }),
  });
  state.pluginId = plugin.body?.item?.id ?? "";
  witness(
    ctx,
    plugin.response.status === 201 && state.pluginId.length > 0,
    "The proof creates an active Plugin outside every Marketplace",
    { status: plugin.response.status, pluginId: state.pluginId },
  );
}

async function cleanup(ctx) {
  const plugin = await denApiFetch(
    `/v1/plugins/${encodeURIComponent(state.pluginId)}/archive`,
    { method: "POST", headers: authHeaders() },
  );
  const marketplace = await denApiFetch(
    `/v1/marketplaces/${encodeURIComponent(state.marketplaceId)}/archive`,
    { method: "POST", headers: authHeaders() },
  );
  witness(
    ctx,
    plugin.response.ok && marketplace.response.ok,
    "The proof archives its temporary Plugin and Marketplace",
    {
      pluginStatus: plugin.response.status,
      marketplaceStatus: marketplace.response.status,
    },
  );
}

function screenshot(name, claim, requireText, rejectText = []) {
  return {
    name,
    claim,
    requireText,
    rejectText: [
      "Failed to add Marketplace",
      "Failed to remove Marketplace",
      "Something went wrong",
      ...rejectText,
    ],
  };
}

export default {
  id: FLOW_ID,
  title: "Den manages Marketplace assignments from the Plugin detail tab",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Create isolated fixtures",
      run: async (ctx) => {
        if (ctx.client?.send) {
          await ctx.client.send("Emulation.setDeviceMetricsOverride", {
            width: 1440,
            height: 1000,
            deviceScaleFactor: 1,
            mobile: false,
          });
        }
        await createFixtures(ctx);
        await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
      },
    },
    {
      name: "Open the Plugin Marketplaces tab",
      run: async (ctx) => {
        await ctx.prove(
          "The Plugin detail page owns Marketplace assignment with the same compact add pattern as member access",
          {
            voiceover: vo[0],
            action: async () => {
              await navigateTo(
                ctx,
                `/dashboard/plugins/${encodeURIComponent(state.pluginId)}`,
              );
              await ctx.waitForText(state.pluginName, { timeoutMs: 30_000 });
              await ctx.eval(
                `[...document.querySelectorAll('[role="tab"]')]
                  .find((tab) => tab.textContent?.includes("Marketplaces"))?.click()`,
              );
              await ctx.waitFor(
                `Boolean(document.querySelector('[data-testid="plugin-marketplace-assignment-controls"]'))`,
                { timeoutMs: 10_000, label: "Plugin Marketplace controls" },
              );
              await ctx.waitFor(
                `(() => {
                  const candidateVisible = [...document.querySelectorAll('button')]
                    .some((button) => button.textContent?.includes(${JSON.stringify(state.marketplaceName)}));
                  if (candidateVisible) return true;
                  const pickerOpen = Boolean(document.querySelector('input[placeholder="Search Marketplaces..."]'));
                  if (!pickerOpen) document.querySelector('[data-testid="add-plugin-marketplace"]')?.click();
                  return false;
                })()`,
                { timeoutMs: 30_000, label: "eligible Marketplace" },
              );
            },
            assert: async () => {
              const initial = await ctx.eval(`(() => ({
                tabSelected: [...document.querySelectorAll('[role="tab"]')]
                  .some((tab) => tab.getAttribute('aria-selected') === 'true' && tab.textContent?.includes('Marketplaces')),
                emptyCopy: document.body.textContent?.includes('This plugin is not in a Marketplace yet.') ?? false,
                candidateVisible: [...document.querySelectorAll('button')]
                  .some((button) => button.textContent?.includes(${JSON.stringify(state.marketplaceName)})),
              }))()`);
              witness(
                ctx,
                initial.tabSelected && initial.emptyCopy && initial.candidateVisible,
                "The empty Plugin lists the unassigned Marketplace as eligible",
                initial,
              );
            },
            screenshot: screenshot(
              "plugin-marketplaces-eligible",
              "The Plugin has a dedicated Marketplaces tab with an eligible Marketplace picker.",
              [
                state.pluginName,
                "Marketplaces",
                "MARKETPLACE ACCESS",
                "This plugin is not in a Marketplace yet.",
                state.marketplaceName,
              ],
            ),
          },
        );
      },
    },
    {
      name: "Add the Marketplace",
      run: async (ctx) => {
        await ctx.prove(
          "Adding from Plugin detail creates the exact Marketplace relationship",
          {
            voiceover: vo[1],
            action: async () => {
              const selected = await ctx.eval(`(() => {
                const option = [...document.querySelectorAll('button')]
                  .find((button) => button.textContent?.includes(${JSON.stringify(state.marketplaceName)}));
                option?.click();
                return Boolean(option);
              })()`);
              witness(ctx, selected, "The proof selects the eligible Marketplace");
              await ctx.waitFor(
                `[...document.querySelectorAll('a')]
                  .some((link) => link.textContent?.includes(${JSON.stringify(state.marketplaceName)}))`,
                { timeoutMs: 30_000, label: "assigned Marketplace row" },
              );
            },
            assert: async () => {
              const resolved = await denApiFetch(
                `/v1/marketplaces/${encodeURIComponent(state.marketplaceId)}/resolved`,
                { headers: authHeaders() },
              );
              const assigned = resolved.body?.item?.plugins?.some(
                (plugin) => plugin?.id === state.pluginId,
              );
              witness(
                ctx,
                resolved.response.ok && assigned === true,
                "The real resolved Marketplace contains the assigned Plugin",
                {
                  status: resolved.response.status,
                  pluginIds: resolved.body?.item?.plugins?.map(
                    (plugin) => plugin?.id,
                  ),
                },
              );
            },
            screenshot: screenshot(
              "plugin-marketplace-assigned",
              "The Marketplace appears as an assignment on the Plugin detail page.",
              [
                state.pluginName,
                "MARKETPLACE ACCESS",
                state.marketplaceName,
                "Add Marketplace",
              ],
            ),
          },
        );
      },
    },
    {
      name: "Confirm relationship-only removal",
      run: async (ctx) => {
        await ctx.prove(
          "Removal is explicitly scoped to this Plugin-to-Marketplace relationship",
          {
            voiceover: vo[2],
            action: async () => {
              await ctx.eval(
                `document.querySelector(${JSON.stringify(`[data-testid="remove-plugin-marketplace-${state.marketplaceId}"]`)})?.click()`,
              );
              await ctx.waitForText(`Remove ${state.marketplaceName}?`, {
                timeoutMs: 10_000,
              });
            },
            assert: async () => {
              const dialog = await ctx.eval(`(() => {
                const element = document.querySelector('[role="alertdialog"]');
                return {
                  visible: Boolean(element),
                  text: element?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
                };
              })()`);
              witness(
                ctx,
                dialog.visible &&
                  dialog.text.includes(
                    `This removes ${state.pluginName} from ${state.marketplaceName} only.`,
                  ) &&
                  dialog.text.includes(
                    "The Plugin and Marketplace remain available.",
                  ),
                "The confirmation preserves both global resources",
                dialog,
              );
            },
            screenshot: screenshot(
              "plugin-marketplace-removal-confirmation",
              "The named confirmation makes the relationship-only removal boundary explicit.",
              [
                `Remove ${state.marketplaceName}?`,
                `This removes ${state.pluginName} from ${state.marketplaceName} only.`,
                "The Plugin and Marketplace remain available.",
                "Remove Marketplace",
              ],
            ),
          },
        );
      },
    },
    {
      name: "Remove only the relationship",
      run: async (ctx) => {
        await ctx.prove(
          "Confirmed removal leaves both resources active and makes the Marketplace eligible again",
          {
            voiceover: vo[3],
            action: async () => {
              await ctx.eval(
                `document.querySelector('[data-testid="confirm-remove-plugin-marketplace"]')?.click()`,
              );
              await ctx.waitForText("This plugin is not in a Marketplace yet.", {
                timeoutMs: 30_000,
              });
              await ctx.waitFor(
                `(() => {
                  const candidateVisible = [...document.querySelectorAll('button')]
                    .some((button) => button.textContent?.includes(${JSON.stringify(state.marketplaceName)}));
                  if (candidateVisible) return true;
                  const pickerOpen = Boolean(document.querySelector('input[placeholder="Search Marketplaces..."]'));
                  if (!pickerOpen) document.querySelector('[data-testid="add-plugin-marketplace"]')?.click();
                  return false;
                })()`,
                { timeoutMs: 10_000, label: "Marketplace eligible after removal" },
              );
            },
            assert: async () => {
              const [resolved, plugin] = await Promise.all([
                denApiFetch(
                  `/v1/marketplaces/${encodeURIComponent(state.marketplaceId)}/resolved`,
                  { headers: authHeaders() },
                ),
                denApiFetch(`/v1/plugins/${encodeURIComponent(state.pluginId)}`, {
                  headers: authHeaders(),
                }),
              ]);
              witness(
                ctx,
                resolved.response.ok &&
                  resolved.body?.item?.plugins?.every(
                    (entry) => entry?.id !== state.pluginId,
                  ) &&
                  plugin.response.ok &&
                  plugin.body?.item?.status === "active",
                "The relationship is gone while the Plugin and Marketplace remain active",
                {
                  marketplaceStatus: resolved.body?.item?.marketplace?.status ?? "active",
                  resolvedPluginIds: resolved.body?.item?.plugins?.map(
                    (entry) => entry?.id,
                  ),
                  pluginStatus: plugin.body?.item?.status,
                },
              );
            },
            screenshot: screenshot(
              "plugin-marketplace-relationship-removed",
              "The Plugin is unassigned again and the active Marketplace is available to add.",
              [
                state.pluginName,
                "This plugin is not in a Marketplace yet.",
                "Add Marketplace",
                state.marketplaceName,
              ],
            ),
          },
        );
        await cleanup(ctx);
      },
    },
  ],
};
