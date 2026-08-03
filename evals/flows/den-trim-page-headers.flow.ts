import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";
import { denWebUrl, signInViaBrowser } from "./lib/den-web.mjs";

const FLOW_ID = "den-trim-page-headers";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const ORGANIZATION_NAME = "Acme Robotics";
const SCREENSHOT_REJECT_TEXT = [
  "Something went wrong",
  "Failed to fetch",
  "Loading...",
  "Loading…",
  "Loading members",
  "Loading plugins",
  "Loading connectors",
  "Loading settings",
  "Error loading",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertMeasurement(ctx: FlowContext, value: unknown, assertion: string): void {
  ctx.assert(
    isRecord(value) && value.passed === true,
    `${assertion}. Observed: ${JSON.stringify(value)}`,
  );
}

async function setViewport(ctx: FlowContext, width: number, height: number): Promise<void> {
  ctx.assert(Boolean(ctx.client), "A browser CDP client is required.");
  await ctx.client?.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 768,
  });
}

async function navigateTo(ctx: FlowContext, path: string, title: string): Promise<void> {
  const url = new URL(path, denWebUrl()).toString();
  ctx.assert(Boolean(ctx.page), "A browser page is required.");
  await ctx.page?.goto(url, { waitUntil: "domcontentloaded" });
  await ctx.waitFor(
    `(() => {
      if (location.pathname !== ${JSON.stringify(path)} || document.readyState !== "complete") return false;
      const text = document.body?.innerText ?? "";
      if (/Something went wrong|Failed to fetch|Loading(?:\.\.\.|…| members| plugins| connectors| settings)|Error loading/i.test(text)) return false;
      const heroes = [...document.querySelectorAll("[data-dashboard-hero]")]
        .filter((entry) => {
          const rect = entry.getBoundingClientRect();
          const style = getComputedStyle(entry);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
      return heroes.length === 1
        && [...heroes[0].querySelectorAll("h1")].some((entry) => (entry.textContent ?? "").trim() === ${JSON.stringify(title)});
    })()`,
    { timeoutMs: 180_000, label: `${title} Trim header at ${path}` },
  );
}

async function measureRouteHeader(ctx: FlowContext): Promise<unknown> {
  return ctx.eval(`(() => {
    const heroes = [...document.querySelectorAll("[data-dashboard-hero]")]
      .filter((entry) => {
        const rect = entry.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(entry).visibility !== "hidden";
      });
    const hero = heroes[0];
    const heading = hero?.querySelector("h1");
    const meshSlot = hero ? [...hero.children].find((entry) => {
      const style = getComputedStyle(entry);
      return Math.abs(parseFloat(style.height) - 280) <= 1 && Math.abs(parseFloat(style.top) + 90) <= 1;
    }) : null;
    const surfaces = meshSlot ? [...meshSlot.querySelectorAll("div, canvas")] : [];
    const hasGradientSurface = surfaces.some((entry) => {
      if (entry instanceof HTMLCanvasElement) return entry.width > 0 && entry.height > 0;
      const image = getComputedStyle(entry).backgroundImage;
      return image.includes("gradient");
    });
    const rect = hero?.getBoundingClientRect();
    return {
      passed: heroes.length === 1
        && Boolean(rect && Math.abs(rect.height - 104) <= 1)
        && Boolean(heading)
        && hasGradientSurface,
      path: location.pathname,
      title: heading?.textContent?.trim() ?? null,
      heroCount: heroes.length,
      heroHeight: rect?.height ?? null,
      hasGradientSurface,
    };
  })()`);
}

export default defineFlow({
  id: FLOW_ID,
  title: "Den dashboard pages share a compact, readable Trim header",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  preserveTheme: true,
  steps: [
    {
      name: "Members uses the compact Trim header",
      run: async (ctx) => {
        await ctx.prove("Members has one 104-pixel Trim header with a plain white title", {
          voiceover: vo[0],
          action: async () => {
            await setViewport(ctx, 1440, 1000);
            await signInViaBrowser(ctx, EMAIL, PASSWORD, ORGANIZATION_NAME);
            await navigateTo(ctx, "/dashboard/members", "Members");
          },
          assert: async () => {
            const measurement = await ctx.eval(`(() => {
              const heroes = [...document.querySelectorAll("[data-dashboard-hero]")]
                .filter((entry) => {
                  const rect = entry.getBoundingClientRect();
                  const style = getComputedStyle(entry);
                  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
                });
              const hero = heroes[0];
              const heading = hero?.querySelector("h1");
              const heroRect = hero?.getBoundingClientRect();
              const headingStyle = heading ? getComputedStyle(heading) : null;
              const titleIsWhite = headingStyle
                ? headingStyle.color === "rgb(255, 255, 255)" || headingStyle.color === "rgba(255, 255, 255, 1)"
                : false;
              return {
                passed: heroes.length === 1
                  && Boolean(heroRect && Math.abs(heroRect.height - 104) <= 1)
                  && heading?.textContent?.trim() === "Members"
                  && headingStyle?.fontSize === "24px"
                  && titleIsWhite
                  && hero?.querySelectorAll("svg").length === 0,
                heroCount: heroes.length,
                heroHeight: heroRect?.height ?? null,
                title: heading?.textContent?.trim() ?? null,
                titleSize: headingStyle?.fontSize ?? null,
                titleColor: headingStyle?.color ?? null,
                svgOrIconChipCount: hero?.querySelectorAll("svg").length ?? null,
              };
            })()`);
            assertMeasurement(ctx, measurement, "Members should show exactly one 104px hero, a white 24px h1, and no SVG/icon chip");
          },
          screenshot: {
            name: "members-compact-trim-header",
            requireText: ["Members", "Invite teammates, adjust roles, and keep access clean."],
            rejectText: SCREENSHOT_REJECT_TEXT,
          },
        });
      },
    },
    {
      name: "The mesh and ink scrim remain visible",
      run: async (ctx) => {
        await ctx.prove("The Trim header preserves the mesh palette and applies the expected readability scrim", {
          voiceover: vo[1],
          action: async () => {
            await navigateTo(ctx, "/dashboard/members", "Members");
            await ctx.waitFor(
              `(() => {
                const hero = document.querySelector("[data-dashboard-hero]");
                return Boolean(hero && (hero.querySelector("canvas") || [...hero.querySelectorAll("div")].some((entry) => getComputedStyle(entry).backgroundImage.includes("gradient"))));
              })()`,
              { timeoutMs: 30_000, label: "Members mesh canvas or CSS fallback" },
            );
          },
          assert: async () => {
            const measurement = await ctx.eval(`(() => {
              const hero = document.querySelector("[data-dashboard-hero]");
              const layers = hero ? [...hero.children] : [];
              const meshSlot = layers.find((entry) => {
                const style = getComputedStyle(entry);
                return Math.abs(parseFloat(style.height) - 280) <= 1 && Math.abs(parseFloat(style.top) + 90) <= 1;
              });
              const scrim = layers.find((entry) => {
                const image = getComputedStyle(entry).backgroundImage;
                return image.includes("linear-gradient") && image.includes("0.52") && image.includes("0.18") && image.includes("0.04");
              });
              const fallback = meshSlot ? [...meshSlot.querySelectorAll("div")].find((entry) => getComputedStyle(entry).backgroundImage.includes("gradient")) : null;
              const canvas = meshSlot?.querySelector("canvas");
              const slotStyle = meshSlot ? getComputedStyle(meshSlot) : null;
              return {
                passed: Boolean(meshSlot && scrim && (canvas || fallback)),
                slotHeight: slotStyle?.height ?? null,
                slotTop: slotStyle?.top ?? null,
                scrimBackground: scrim ? getComputedStyle(scrim).backgroundImage : null,
                renderSurface: canvas ? "canvas" : fallback ? "css-gradient" : null,
              };
            })()`);
            assertMeasurement(ctx, measurement, "The mesh/fallback slot should be 280px high at -90px with all three ink-scrim opacity stops");
          },
          screenshot: {
            name: "members-mesh-and-scrim",
            requireText: ["Members", "Invite teammates, adjust roles, and keep access clean."],
            rejectText: SCREENSHOT_REJECT_TEXT,
          },
        });
      },
    },
    {
      name: "Description and tabs follow the header",
      run: async (ctx) => {
        await ctx.prove("Members keeps its description outside the hero and before its tabs", {
          voiceover: vo[2],
          action: async () => {
            await navigateTo(ctx, "/dashboard/members", "Members");
            await ctx.waitFor(
              `(() => ["Members", "Teams", "Roles"].every((label) => [...document.querySelectorAll('[role="tab"]')].some((entry) => (entry.textContent ?? "").includes(label))))()`,
              { timeoutMs: 60_000, label: "Members, Teams, and Roles tabs" },
            );
          },
          assert: async () => {
            const measurement = await ctx.eval(`(() => {
              const hero = document.querySelector("[data-dashboard-hero]");
              const description = [...document.querySelectorAll("p")]
                .find((entry) => (entry.textContent ?? "").trim() === "Invite teammates, adjust roles, and keep access clean.");
              const tabs = [...document.querySelectorAll('[role="tab"]')]
                .filter((entry) => ["Members", "Teams", "Roles"].some((label) => (entry.textContent ?? "").includes(label)));
              const firstTab = tabs[0];
              const heroBeforeDescription = Boolean(hero && description && (hero.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING));
              const descriptionBeforeTabs = Boolean(description && firstTab && (description.compareDocumentPosition(firstTab) & Node.DOCUMENT_POSITION_FOLLOWING));
              return {
                passed: Boolean(hero && description && !hero.contains(description) && heroBeforeDescription && descriptionBeforeTabs && tabs.length === 3),
                descriptionOutsideHero: Boolean(hero && description && !hero.contains(description)),
                heroBeforeDescription,
                descriptionBeforeTabs,
                tabs: tabs.map((entry) => (entry.textContent ?? "").replace(/\\s+/g, " ").trim()),
              };
            })()`);
            assertMeasurement(ctx, measurement, "The description should be after and outside the hero, before all three Members tabs");
          },
          screenshot: {
            name: "members-description-and-tabs",
            requireText: ["Invite teammates, adjust roles, and keep access clean.", "Members", "Teams", "Roles", "Add member"],
            rejectText: SCREENSHOT_REJECT_TEXT,
          },
        });
      },
    },
    {
      name: "Trim headers stay consistent across dashboard routes",
      run: async (ctx) => {
        await ctx.prove("Members, Plugins, Connectors, and Org settings use the same compact gradient shell", {
          voiceover: vo[3],
          action: async () => {
            const routes = [
              { path: "/dashboard/members", title: "Members" },
              { path: "/dashboard/plugins", title: "Plugins" },
              { path: "/dashboard/mcp-connections", title: "Connectors" },
              { path: "/dashboard/org-settings", title: "Org settings" },
            ];
            for (const route of routes) {
              await navigateTo(ctx, route.path, route.title);
              const measurement = await measureRouteHeader(ctx);
              const correctRoute = isRecord(measurement)
                && measurement.path === route.path
                && measurement.title === route.title;
              ctx.assert(correctRoute, `${route.path} should render the ${route.title} h1. Observed: ${JSON.stringify(measurement)}`);
              assertMeasurement(ctx, measurement, `${route.title} should have one 104px hero and a gradient surface`);
              ctx.recordEvidence({
                type: "assertion",
                status: "passed",
                assertion: `${route.title} route has the shared 104px gradient Trim header`,
                actual: measurement,
              });
            }
          },
          assert: async () => {
            const finalHeader = await measureRouteHeader(ctx);
            assertMeasurement(ctx, finalHeader, "The route sequence should finish on a valid non-Members Trim header");
            ctx.assert(
              isRecord(finalHeader) && finalHeader.path === "/dashboard/org-settings" && finalHeader.title === "Org settings",
              `Expected the screenshot route to finish on Org settings. Observed: ${JSON.stringify(finalHeader)}`,
            );
          },
          screenshot: {
            name: "org-settings-shared-trim-header",
            requireText: ["Org settings", "Control your organization's settings."],
            rejectText: SCREENSHOT_REJECT_TEXT,
          },
        });
      },
    },
    {
      name: "Members remains usable at a narrow viewport",
      run: async (ctx) => {
        await ctx.prove("The Members Trim header, tabs, and Add member action fit a 375-pixel viewport", {
          voiceover: vo[4],
          action: async () => {
            await setViewport(ctx, 375, 480);
            await navigateTo(ctx, "/dashboard/members", "Members");
            await ctx.eval("(() => { scrollTo(0, 0); return true; })()");
            await ctx.waitFor(
              `(() => [...document.querySelectorAll("button")].some((entry) => (entry.textContent ?? "").trim() === "Add member"))()`,
              { timeoutMs: 60_000, label: "narrow Add member action" },
            );
          },
          assert: async () => {
            const measurement = await ctx.eval(`(() => {
              const hero = document.querySelector("[data-dashboard-hero]");
              const title = hero?.querySelector("h1");
              const tabs = document.querySelector('[role="tablist"]');
              const addMember = [...document.querySelectorAll("button")]
                .find((entry) => (entry.textContent ?? "").trim() === "Add member");
              const heroRect = hero?.getBoundingClientRect();
              const titleRect = title?.getBoundingClientRect();
              const tabsRect = tabs?.getBoundingClientRect();
              const actionRect = addMember?.getBoundingClientRect();
              const horizontallyContained = (rect) => Boolean(rect && rect.left >= -1 && rect.right <= innerWidth + 1);
              const visiblySized = (rect) => Boolean(rect && rect.width > 0 && rect.height > 0);
              return {
                passed: Boolean(
                  heroRect && heroRect.top >= 0 && heroRect.bottom <= innerHeight
                  && visiblySized(titleRect) && visiblySized(tabsRect) && visiblySized(actionRect)
                  && horizontallyContained(heroRect) && horizontallyContained(titleRect)
                  && horizontallyContained(tabsRect) && horizontallyContained(actionRect)
                  && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
                ),
                viewport: { width: innerWidth, height: innerHeight },
                hero: heroRect ? { left: heroRect.left, right: heroRect.right, top: heroRect.top, bottom: heroRect.bottom } : null,
                titleVisible: visiblySized(titleRect),
                tabsVisible: visiblySized(tabsRect),
                addMemberVisible: visiblySized(actionRect),
                addMemberBounds: actionRect ? { left: actionRect.left, right: actionRect.right } : null,
                pageScrollWidth: document.documentElement.scrollWidth,
                pageClientWidth: document.documentElement.clientWidth,
              };
            })()`);
            assertMeasurement(ctx, measurement, "At 375x480 the hero should be in view with visible, horizontally contained title, tabs, and Add member action and no page overflow");
          },
          screenshot: {
            name: "members-trim-header-mobile",
            requireText: ["Members", "Teams", "Roles", "Add member"],
            rejectText: SCREENSHOT_REJECT_TEXT,
          },
        });
      },
    },
  ],
});
