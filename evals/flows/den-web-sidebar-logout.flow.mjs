import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denWebUrl } from "./lib/den-web.mjs";

const vo = await loadVoiceoverParagraphs("den-web-sidebar-logout");

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";

const visibleSidebarFooter = `(() => {
  const sidebar = [...document.querySelectorAll('aside')].find((element) => getComputedStyle(element).display !== 'none');
  return sidebar?.querySelector(':scope > div > div.mt-auto') ?? null;
})()`;

async function enterDashboard(ctx) {
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(denWebUrl())}; return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000 });
  await ctx.eval(
    `fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true).catch(() => true)`,
    { awaitPromise: true },
  );
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(denWebUrl())}; return true; })()`);
  await ctx.waitFor(
    "Boolean(document.querySelector('input[type=\"email\"]')) && Boolean(document.querySelector('input[type=\"password\"]'))",
    { timeoutMs: 30_000, label: "sign-in form" },
  );
  await ctx.eval(`(() => {
    const tab = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === 'Sign in');
    tab?.click();
    return true;
  })()`);
  await ctx.fill('input[type="email"]', ADMIN_EMAIL);
  await ctx.fill('input[type="password"]', ADMIN_PASSWORD);
  const submitted = await ctx.eval(`(() => {
    const button = document.querySelector('button[type="submit"]');
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(submitted, "The sign-in form could not be submitted.");
  await ctx.waitFor(
    `(() => {
      const text = document.body?.innerText ?? '';
      if (document.querySelector('nav') && !text.includes('Choose an organization')) return true;
      if (!text.includes('Choose an organization')) return false;
      const org = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('member'));
      org?.click();
      return false;
    })()`,
    { timeoutMs: 60_000, label: "dashboard sidebar" },
  );
}

async function openAnalytics(ctx) {
  await ctx.clickText("Analytics", { timeoutMs: 15_000 });
  await ctx.waitFor("location.pathname.includes('/analytics')", { timeoutMs: 30_000, label: "analytics page" });
  await ctx.waitFor("document.querySelector('main.overflow-y-auto').scrollHeight > document.querySelector('main.overflow-y-auto').clientHeight", {
    timeoutMs: 30_000,
    label: "long dashboard page",
  });
}

async function sidebarPosition(ctx) {
  return ctx.eval(`(() => {
    const footer = ${visibleSidebarFooter};
    const main = document.querySelector('main.overflow-y-auto');
    const rect = footer?.getBoundingClientRect();
    return {
      footerTop: rect?.top ?? -1,
      footerBottom: rect?.bottom ?? -1,
      viewportHeight: window.innerHeight,
      mainScrollTop: main?.scrollTop ?? 0,
      mainScrollHeight: main?.scrollHeight ?? 0,
      mainClientHeight: main?.clientHeight ?? 0,
    };
  })()`);
}

function assertFooterAtViewportBottom(ctx, position) {
  ctx.assert(position.mainScrollTop > 0, `Dashboard content did not scroll: ${JSON.stringify(position)}`);
  ctx.assert(
    position.footerBottom <= position.viewportHeight && position.footerBottom >= position.viewportHeight - 24,
    `Sidebar footer is not at the viewport bottom: ${JSON.stringify(position)}`,
  );
  ctx.assert(position.footerTop >= 0, `Sidebar footer is above the viewport: ${JSON.stringify(position)}`);
}

export default {
  id: "den-web-sidebar-logout",
  title: "Den Web organization controls stay at the viewport bottom on long dashboard pages",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_MULTI_ORG"],
  steps: [
    {
      name: "Logged-in dashboard shows workspace navigation",
      run: async (ctx) => {
        await ctx.prove("A logged-in admin sees the Den Web dashboard sidebar", {
          voiceover: vo[0],
          action: async () => {
            await enterDashboard(ctx);
          },
          assert: async () => {
            await ctx.expectText("Dashboard", { timeoutMs: 30_000 });
            ctx.assert(
              await ctx.eval(`Boolean(${visibleSidebarFooter})`),
              "The visible sidebar footer was not rendered.",
            );
          },
          screenshot: {
            name: "dashboard-sidebar",
            claim: "The logged-in dashboard shows workspace navigation and organization controls.",
            requireText: ["Dashboard"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Organization controls remain at the viewport bottom after scrolling",
      run: async (ctx) => {
        await ctx.prove("The sidebar footer stays at the viewport bottom while long dashboard content scrolls", {
          voiceover: vo[1],
          action: async () => {
            await openAnalytics(ctx);
            await ctx.eval(`(() => {
              const main = document.querySelector('main.overflow-y-auto');
              main.scrollTop = Math.floor((main.scrollHeight - main.clientHeight) / 2);
              return true;
            })()`);
            await ctx.waitFor("document.querySelector('main.overflow-y-auto').scrollTop > 0", { timeoutMs: 10_000, label: "dashboard scrolled" });
          },
          assert: async () => {
            assertFooterAtViewportBottom(ctx, await sidebarPosition(ctx));
          },
          screenshot: {
            name: "sidebar-footer-after-scroll",
            claim: "After scrolling a long dashboard page, the organization controls remain on screen at the viewport bottom.",
            requireText: ["Analytics"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Organization menu opens without returning to the page bottom",
      run: async (ctx) => {
        await ctx.prove("The organization menu opens immediately from the scrolled dashboard", {
          voiceover: vo[2],
          action: async () => {
            const opened = await ctx.eval(`(() => {
              const footer = ${visibleSidebarFooter};
              const trigger = [...(footer?.querySelectorAll('button') ?? [])].find((button) => button.getAttribute('aria-label') !== 'Sign out');
              trigger?.click();
              return Boolean(trigger);
            })()`);
            ctx.assert(opened, "The organization switcher trigger was not available.");
            await ctx.waitForText("Switch workspace", { timeoutMs: 10_000 });
          },
          assert: async () => {
            assertFooterAtViewportBottom(ctx, await sidebarPosition(ctx));
            await ctx.expectText("Sign out");
          },
          screenshot: {
            name: "workspace-menu-from-scrolled-page",
            claim: "The workspace menu opens while the dashboard remains scrolled.",
            requireText: ["Switch workspace", "Sign out"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Workspace switching and sign out remain visible",
      run: async (ctx) => {
        await ctx.prove("Workspace switching and sign out are fully visible inside the viewport", {
          voiceover: vo[3],
          action: async () => {
            const targetOrg = await ctx.eval(`(() => {
              const footer = ${visibleSidebarFooter};
              const currentName = footer?.querySelector('p')?.textContent?.trim() ?? '';
              const choices = [...document.querySelectorAll('div.absolute button')].filter((button) => (button.textContent ?? '').includes('member'));
              const target = choices.find((button) => !(button.textContent ?? '').startsWith(currentName));
              const name = target?.querySelector('span.block')?.textContent?.trim() ?? '';
              target?.click();
              return name;
            })()`);
            ctx.assert(Boolean(targetOrg), "No second workspace was available to demonstrate switching.");
            await ctx.waitFor(
              `(() => {
                const footer = ${visibleSidebarFooter};
                return footer?.querySelector('p')?.textContent?.trim() === ${JSON.stringify(targetOrg)};
              })()`,
              { timeoutMs: 30_000, label: `workspace switched to ${targetOrg}` },
            );
            const reopened = await ctx.eval(`(() => {
              const footer = ${visibleSidebarFooter};
              const trigger = [...(footer?.querySelectorAll('button') ?? [])].find((button) => button.getAttribute('aria-label') !== 'Sign out');
              trigger?.click();
              return Boolean(trigger);
            })()`);
            ctx.assert(reopened, "The workspace menu could not be reopened after switching.");
            await ctx.waitForText("Switch workspace", { timeoutMs: 10_000 });
          },
          assert: async () => {
            const menu = await ctx.eval(`(() => {
              const signOut = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === 'Sign out');
              const panel = signOut?.closest('div.absolute');
              const rect = panel?.getBoundingClientRect();
              return { top: rect?.top ?? -1, bottom: rect?.bottom ?? -1, viewportHeight: window.innerHeight };
            })()`);
            ctx.assert(menu.top >= 0 && menu.bottom <= menu.viewportHeight, `The workspace menu is clipped outside the viewport: ${JSON.stringify(menu)}`);
            await ctx.expectText("Create or join workspace");
            await ctx.expectText("Sign out");
          },
          screenshot: {
            name: "workspace-actions-visible",
            claim: "Workspace switching and sign out are fully visible from anywhere on the dashboard.",
            requireText: ["Switch workspace", "Create or join workspace", "Sign out"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
