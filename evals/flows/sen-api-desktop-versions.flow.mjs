import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
  applyDesktopViewport,
  clickExactText,
  navigateTo,
} from "./den-reauth-pending-action.flow.mjs";

const vo = await loadVoiceoverParagraphs("sen-api-desktop-versions");
const DEMO_EMAIL = "alex@acme.test";
const DEMO_PASSWORD = "OpenWorkDemo123!";

function recordAssertion(ctx, assertion, passed, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

async function openDesktopVersionSettings(ctx) {
  await applyDesktopViewport(ctx);
  await navigateTo(ctx, "/");
  await ctx.eval(`fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => {
    localStorage.removeItem('openwork:web:auth-token');
    sessionStorage.clear();
    location.reload();
    return true;
  }).catch(() => true)`, { awaitPromise: true });
  await ctx.waitFor(`document.body.innerText.includes('Start using OpenWork') && Boolean(document.querySelector('input[type="email"]'))`, {
    timeoutMs: 30_000,
    label: "email-first sign-in",
  });
  await ctx.fill('input[type="email"]', DEMO_EMAIL);
  await clickExactText(ctx, "Next", "button");
  await ctx.waitFor(`Boolean(document.querySelector('input[type="password"]'))`, {
    timeoutMs: 30_000,
    label: "password sign-in step",
  });
  await ctx.fill('input[type="password"]', DEMO_PASSWORD);
  await clickExactText(ctx, "Sign in", "button");
  await ctx.waitFor(`location.pathname.startsWith('/dashboard')`, {
    timeoutMs: 45_000,
    label: "signed-in dashboard",
  });
  await navigateTo(ctx, "/dashboard/org-settings");
  await ctx.waitFor(`(() => {
    const list = document.querySelector('[data-testid="desktop-version-list"]');
    return Boolean(list && list.querySelector('[data-desktop-version="0.17.0"]'));
  })()`, { timeoutMs: 45_000, label: "published desktop version list" });
}

async function scrollVersionIntoView(ctx, selector) {
  await ctx.eval(`(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    row?.scrollIntoView({ block: 'center', behavior: 'instant' });
    return Boolean(row);
  })()`);
  await ctx.waitFor(`(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    if (!row) return false;
    const rect = row.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  })()`, { timeoutMs: 10_000, label: `visible version row ${selector}` });
}

export default {
  id: "sen-api-desktop-versions",
  title: "Organization owners see every published desktop version and clear server compatibility guidance",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Minimum supported version is v0.17.0",
      run: async (ctx) => {
        await ctx.prove("Allowed Desktop Versions starts at v0.17.0", {
          voiceover: vo[0],
          action: async () => {
            await openDesktopVersionSettings(ctx);
            await scrollVersionIntoView(ctx, '[data-desktop-version="0.17.0"]');
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => ({
              supportText: [...document.querySelectorAll('p')].map((node) => node.textContent?.trim() ?? '').find((text) => text.startsWith('This server currently supports desktop')) ?? '',
              minimumVisible: Boolean(document.querySelector('[data-desktop-version="0.17.0"]')),
            }))()`);
            recordAssertion(ctx, "The server range begins at v0.17.0", actual.minimumVisible && actual.supportText.includes("v0.17.0"), actual);
          },
          screenshot: {
            name: "desktop-versions-minimum",
            requireText: ["Allowed Desktop Versions", "v0.17.0"],
          },
        });
      },
    },
    {
      name: "Published versions are complete and newest-first",
      run: async (ctx) => {
        await ctx.prove("Every published version in the server range is listed newest-first", {
          voiceover: vo[1],
          action: async () => {
            await ctx.eval(`(() => {
              const rows = [...document.querySelectorAll('[data-desktop-version]')];
              rows[Math.floor(rows.length / 2)]?.scrollIntoView({ block: 'center', behavior: 'instant' });
              return rows.length;
            })()`);
            await ctx.waitFor(`(() => {
              const list = document.querySelector('[data-testid="desktop-version-list"]');
              return Boolean(list && list.scrollTop > 0 && list.scrollTop < list.scrollHeight - list.clientHeight);
            })()`, { timeoutMs: 10_000, label: "middle of newest-first version list" });
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const rows = [...document.querySelectorAll('[data-desktop-version]')];
              const versions = rows.map((row) => row.getAttribute('data-desktop-version') ?? '');
              const supported = rows.filter((row) => row.getAttribute('data-supported') === 'true').map((row) => row.getAttribute('data-desktop-version') ?? '');
              const numeric = (version) => version.split('.').map(Number);
              const descending = versions.every((version, index) => {
                if (index === 0) return true;
                const left = numeric(versions[index - 1]);
                const right = numeric(version);
                return left[0] > right[0] || (left[0] === right[0] && (left[1] > right[1] || (left[1] === right[1] && left[2] >= right[2])));
              });
              return { versions, supported, descending };
            })()`);
            recordAssertion(ctx, "The full list is sorted newest-first", actual.descending && actual.versions.length > actual.supported.length, actual);
            recordAssertion(ctx, "All published versions from v0.17.0 through the server maximum are present", actual.supported.at(-1) === "0.17.0" && actual.supported.length >= 2, actual);
          },
          screenshot: {
            name: "desktop-versions-supported-range",
            requireText: ["Allowed Desktop Versions"],
          },
        });
      },
    },
    {
      name: "Newer versions explain the server upgrade requirement",
      run: async (ctx) => {
        await ctx.prove("Versions newer than the server maximum are visible but disabled", {
          voiceover: vo[2],
          action: async () => {
            await scrollVersionIntoView(ctx, '[data-supported="false"]');
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const row = document.querySelector('[data-supported="false"]');
              return {
                version: row?.getAttribute('data-desktop-version') ?? '',
                disabled: row?.querySelector('input[type="checkbox"]')?.disabled === true,
                note: row?.textContent?.includes('Upgrade server to allow this version') === true,
              };
            })()`);
            recordAssertion(ctx, "A version above the maximum is disabled with upgrade guidance", actual.version.length > 0 && actual.disabled && actual.note, actual);
          },
          screenshot: {
            name: "desktop-versions-upgrade-required",
            requireText: ["Upgrade server to allow this version"],
          },
        });
      },
    },
    {
      name: "Long version lists stay inside a scrolling region",
      run: async (ctx) => {
        await ctx.prove("The version list is capped at 400 pixels and scrolls", {
          voiceover: vo[3],
          action: async () => {
            await ctx.eval(`(() => {
              const list = document.querySelector('[data-testid="desktop-version-list"]');
              if (list) list.scrollTop = Math.floor(list.scrollHeight / 2);
              return true;
            })()`);
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const list = document.querySelector('[data-testid="desktop-version-list"]');
              if (!list) return null;
              const style = getComputedStyle(list);
              return {
                clientHeight: list.clientHeight,
                scrollHeight: list.scrollHeight,
                scrollTop: list.scrollTop,
                overflowY: style.overflowY,
              };
            })()`);
            recordAssertion(ctx, "The list is no taller than 400 pixels and has scrollable overflow", actual !== null && actual.clientHeight <= 400 && actual.scrollHeight > actual.clientHeight && actual.scrollTop > 0 && actual.overflowY === "auto", actual);
          },
          screenshot: {
            name: "desktop-versions-scroll-region",
            requireText: ["Allowed Desktop Versions"],
          },
        });
      },
    },
  ],
};
