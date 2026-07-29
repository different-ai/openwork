import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";
import { denWebUrl, signInViaBrowser } from "./lib/den-web.mjs";

const FLOW_ID = "flat-plugin-card-treatment";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const ORGANIZATION_NAME = "Acme Robotics";

async function setViewport(ctx: FlowContext, width: number): Promise<void> {
  ctx.assert(Boolean(ctx.client), "A browser CDP client is required.");
  await ctx.client?.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: width < 768,
  });
}

async function navigate(ctx: FlowContext, path: string): Promise<void> {
  const url = new URL(path, denWebUrl()).toString();
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
  await ctx.waitFor(
    `location.pathname === ${JSON.stringify(path)} && document.readyState === 'complete'`,
    { timeoutMs: 180_000, label: `${path} cold navigation` },
  );
}

const FLAT_PLUGIN_CARDS = `(selector) => {
  const cards = [...document.querySelectorAll(selector)];
  if (cards.length === 0) return { count: 0, decorative: [] };
  const decorative = cards.flatMap((card, cardIndex) =>
    [card, ...card.querySelectorAll("*")].flatMap((entry) => {
      const style = getComputedStyle(entry);
      const image = style.backgroundImage || "";
      return image !== "none" && image !== "" ? [{ cardIndex, image }] : [];
    })
  );
  return { count: cards.length, decorative };
}`;

async function assertFlatCards(ctx: FlowContext, selector: string, label: string): Promise<void> {
  const result = await ctx.eval(`(${FLAT_PLUGIN_CARDS})(${JSON.stringify(selector)})`);
  const measured = result as { count: number; decorative: Array<{ cardIndex: number; image: string }> };
  ctx.assert(measured.count > 0, `Expected at least one ${label} Plugin card.`);
  ctx.assert(
    measured.decorative.length === 0,
    `${label} Plugin cards still contain decorative background images: ${JSON.stringify(measured.decorative).slice(0, 500)}`,
  );
}

export default defineFlow({
  id: FLOW_ID,
  title: "Den and Marketplace Plugin cards use a consistent flat semantic surface",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_WEB_URL"],
  preserveTheme: true,
  steps: [
    {
      name: "Plugin cards stay flat across surfaces and responsive states",
      run: async (ctx) => {
        await ctx.prove("Plugin cards keep their content and interactions without gradients or decorative image overlays", {
          voiceover: vo[0],
          action: async () => {
            await setViewport(ctx, 1440);
            await signInViaBrowser(ctx, EMAIL, PASSWORD, ORGANIZATION_NAME);
            await navigate(ctx, "/dashboard/plugins");
            await ctx.waitFor(
              "(document.body?.innerText ?? '').includes('Plugins')",
              { timeoutMs: 180_000, label: "Plugins screen after cold route compilation" },
            );
            await ctx.waitFor(
              "Boolean(document.querySelector('a[href*=\"/dashboard/plugins/\"]:not([href$=\"/new\"]):not([href$=\"/import\"])'))",
              { timeoutMs: 120_000, label: "seeded Den Plugin card" },
            );
            await assertFlatCards(
              ctx,
              'a[href*="/dashboard/plugins/"]:not([href$="/new"]):not([href$="/import"])',
              "Den",
            );

            const marketplaceHref = await ctx.eval(`(() => {
              const link = [...document.querySelectorAll('a[href*="/dashboard/marketplaces/"]')]
                .find((entry) => !entry.getAttribute("href")?.endsWith("/new"));
              return link?.getAttribute("href") || "";
            })()`);
            ctx.assert(typeof marketplaceHref === "string" && marketplaceHref.length > 0, "Expected a seeded Marketplace detail link.");
            await navigate(ctx, String(marketplaceHref));
            await ctx.waitFor("Boolean(document.querySelector('div[id^=\"plugin-\"]'))", {
              timeoutMs: 120_000,
              label: "seeded Marketplace Plugin card after cold route compilation",
            });
            await assertFlatCards(ctx, 'div[id^="plugin-"]', "Marketplace");

            await ctx.eval(`(() => {
              document.documentElement.classList.add("dark");
              const card = document.querySelector('div[id^="plugin-"] a, div[id^="plugin-"] button');
              if (card instanceof HTMLElement) card.focus();
              return true;
            })()`);
            await assertFlatCards(ctx, 'div[id^="plugin-"]', "dark-mode Marketplace");
            await setViewport(ctx, 390);
            await assertFlatCards(ctx, 'div[id^="plugin-"]', "narrow Marketplace");
          },
          assert: async () => {
            const state = await ctx.eval(`(() => {
              const cards = [...document.querySelectorAll('div[id^="plugin-"]')];
              const visible = cards.every((card) => {
                const rect = card.getBoundingClientRect();
                return rect.width > 0 && rect.right <= document.documentElement.clientWidth + 1;
              });
              const focused = document.activeElement?.closest('div[id^="plugin-"]') !== null;
              return { count: cards.length, visible, focused };
            })()`);
            const measured = state as { count: number; visible: boolean; focused: boolean };
            ctx.assert(measured.count > 0, "Expected Marketplace Plugin cards.");
            ctx.assert(measured.visible, "Plugin cards must stay within the narrow viewport.");
            ctx.assert(measured.focused, "A Plugin card action must retain visible keyboard focus.");
          },
          screenshot: {
            name: "flat-plugin-cards-dark-narrow",
            requireText: ["Plugins"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
});
