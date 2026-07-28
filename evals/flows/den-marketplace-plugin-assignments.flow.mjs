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
      description: "Temporary marketplace for assignment relationship proof.",
    }),
  });
  state.marketplaceId = marketplace.body?.item?.id ?? "";
  witness(
    ctx,
    marketplace.response.status === 201 && state.marketplaceId.length > 0,
    "The proof creates an empty Marketplace through the real Den API",
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
      description: "Temporary active Plugin for relationship assignment proof.",
      orgWide: true,
    }),
  });
  state.pluginId = plugin.body?.item?.id ?? "";
  witness(
    ctx,
    plugin.response.status === 201 && state.pluginId.length > 0,
    "The proof creates an active Plugin outside the Marketplace",
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
      "Failed to assign plugin",
      "Failed to remove plugin",
      "Something went wrong",
      ...rejectText,
    ],
  };
}

export default {
  id: FLOW_ID,
  title:
    "Den assigns and removes existing Plugins from one Marketplace relationship",
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
      name: "Choose an eligible existing Plugin",
      run: async (ctx) => {
        await ctx.prove(
          "An administrator can choose an active Plugin not yet assigned to the Marketplace",
          {
            voiceover: vo[0],
            action: async () => {
              await navigateTo(
                ctx,
                `/dashboard/marketplaces/${encodeURIComponent(state.marketplaceId)}`,
              );
              await ctx.waitForText("Assign an existing plugin", {
                timeoutMs: 30_000,
              });
              await ctx.eval(
                `document.querySelector('button[aria-label="Eligible plugin"]')?.click()`,
              );
              await ctx.waitFor(
                `(() => [...document.querySelectorAll('[role="option"]')]
                  .some((option) => option.textContent?.trim() === ${JSON.stringify(state.pluginName)}))()`,
                { timeoutMs: 30_000, label: "eligible proof plugin" },
              );
            },
            assert: async () => {
              const initial = await ctx.eval(`(() => ({
                countText: [...document.querySelectorAll('p')]
                  .find((entry) => (entry.textContent ?? '').trim() === '0 plugins')
                  ?.textContent?.trim() ?? "",
                candidateNames: [...document.querySelectorAll('[role="option"]')]
                  .map((option) => option.textContent?.trim() ?? ""),
              }))()`);
              witness(
                ctx,
                initial.countText === "0 plugins" &&
                  initial.candidateNames.includes(state.pluginName),
                "The empty Marketplace lists the unassigned Plugin as eligible",
                initial,
              );
            },
            screenshot: screenshot(
              "marketplace-existing-plugin-eligible",
              "The Marketplace offers an active, unassigned Plugin as an assignment candidate.",
              [
                state.marketplaceName,
                "0 plugins",
                "Assign an existing plugin",
                state.pluginName,
              ],
            ),
          },
        );
      },
    },
    {
      name: "Assign the existing Plugin",
      run: async (ctx) => {
        await ctx.prove(
          "Assigning creates the exact Marketplace relationship and removes the Plugin from eligibility",
          {
            voiceover: vo[1],
            action: async () => {
              const selected = await ctx.eval(`(() => {
                const option = [...document.querySelectorAll('[role="option"]')]
                  .find((entry) => entry.textContent?.trim() === ${JSON.stringify(state.pluginName)});
                option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                return Boolean(option);
              })()`);
              witness(ctx, selected, "The proof selects the eligible Plugin");
              await ctx.waitFor(
                `!document.querySelector('[data-testid="assign-marketplace-plugin"]')?.disabled`,
                { timeoutMs: 10_000, label: "enabled assignment action" },
              );
              await ctx.eval(
                `document.querySelector('[data-testid="assign-marketplace-plugin"]')?.click()`,
              );
              await ctx.waitFor(
                `(() => document.querySelector(${JSON.stringify(`#plugin-${state.pluginId}`)})
                  && !document.querySelector('[role="alertdialog"]'))()`,
                { timeoutMs: 30_000, label: "assigned Plugin card" },
              );
              await ctx.eval(
                `document.querySelector('button[aria-label="Eligible plugin"]')?.click()`,
              );
              const stillEligible = await ctx.eval(
                `[...document.querySelectorAll('[role="option"]')]
                  .some((option) => option.textContent?.trim() === ${JSON.stringify(state.pluginName)})`,
              );
              witness(
                ctx,
                !stillEligible,
                "The assigned Plugin is removed from the eligible choices",
              );
              await ctx.eval(
                `document.querySelector('button[aria-label="Eligible plugin"]')?.click()`,
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
              "marketplace-existing-plugin-assigned",
              "The assigned Plugin appears in the Marketplace and is no longer offered as a candidate.",
              [
                state.marketplaceName,
                "1 plugin",
                state.pluginName,
                "Remove",
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
          "Removal is explicitly scoped to the Marketplace relationship",
          {
            voiceover: vo[2],
            action: async () => {
              await ctx.eval(
                `document.querySelector(${JSON.stringify(`[data-testid="remove-marketplace-plugin-${state.pluginId}"]`)})?.click()`,
              );
              await ctx.waitForText(`Remove ${state.pluginName}?`, {
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
                    `This removes the plugin from ${state.marketplaceName} only.`,
                  ) &&
                  dialog.text.includes(
                    "The global plugin and its configuration will remain available.",
                  ),
                "The confirmation explains that the global Plugin remains available",
                dialog,
              );
            },
            screenshot: screenshot(
              "marketplace-plugin-removal-confirmation",
              "The named confirmation makes the relationship-only removal boundary explicit.",
              [
                `Remove ${state.pluginName}?`,
                `This removes the plugin from ${state.marketplaceName} only.`,
                "The global plugin and its configuration will remain available.",
                "Remove from marketplace",
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
          "Confirmed removal empties the Marketplace while leaving the Plugin active",
          {
            voiceover: vo[3],
            action: async () => {
              await ctx.eval(
                `document.querySelector('[data-testid="confirm-remove-marketplace-plugin"]')?.click()`,
              );
              await ctx.waitFor(
                `!document.querySelector(${JSON.stringify(`#plugin-${state.pluginId}`)})`,
                { timeoutMs: 30_000, label: "removed Plugin relationship" },
              );
              await ctx.eval(
                `document.querySelector('button[aria-label="Eligible plugin"]')?.click()`,
              );
              await ctx.waitFor(
                `[...document.querySelectorAll('[role="option"]')]
                  .some((option) => option.textContent?.trim() === ${JSON.stringify(state.pluginName)})`,
                { timeoutMs: 10_000, label: "Plugin eligible after removal" },
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
                "The relationship is gone and the global Plugin remains active",
                {
                  resolvedPluginIds: resolved.body?.item?.plugins?.map(
                    (entry) => entry?.id,
                  ),
                  pluginStatus: plugin.body?.item?.status,
                },
              );
            },
            screenshot: screenshot(
              "marketplace-plugin-relationship-removed",
              "The Marketplace is empty again and the still-active Plugin is eligible for reassignment.",
              [
                state.marketplaceName,
                "0 plugins",
                "No plugins in this marketplace yet",
                state.pluginName,
              ],
            ),
          },
        );
        await cleanup(ctx);
      },
    },
  ],
};
