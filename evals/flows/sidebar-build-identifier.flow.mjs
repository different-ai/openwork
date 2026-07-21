import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IDENTIFIER_SELECTOR = '[data-testid="sidebar-build-identifier"]';
const WORKSPACE_PATH = join(tmpdir(), "openwork-sidebar-build-identifier");

async function ensureSidebarReady(ctx) {
  await mkdir(WORKSPACE_PATH, { recursive: true });
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 30_000,
    label: "window.__openworkControl",
  });
  await ctx.waitFor("document.body.innerText.trim().length > 40", {
    label: "rendered OpenWork shell",
  });

  const onWelcome = await ctx.eval("location.hash.includes('/welcome')");
  if (onWelcome) {
    await ctx.fill("input", WORKSPACE_PATH);
    await ctx.clickText("Use this folder", { timeoutMs: 15_000 });
    await ctx.waitFor("location.hash.includes('/workspace/') || document.body.innerText.includes('Skip and use the free model')", {
      timeoutMs: 30_000,
      label: "workspace route or first-task onboarding",
    });
  }

  if (await ctx.hasText("Skip and use the free model")) {
    await ctx.clickText("Skip and use the free model", { timeoutMs: 15_000 });
  }

  await ctx.waitFor("location.hash.includes('/workspace/') || document.body.innerText.includes('How did you hear about OpenWork?')", {
    timeoutMs: 30_000,
    label: "workspace route or attribution onboarding",
  });

  if (await ctx.hasText("How did you hear about OpenWork?")) {
    await ctx.clickText("Skip", { selector: "button", timeoutMs: 15_000 });
  }

  await ctx.waitFor("location.hash.includes('/workspace/')", {
    timeoutMs: 30_000,
    label: "workspace route after onboarding",
  });

  await ctx.waitFor("Boolean(document.querySelector('[data-slot=\"sidebar\"]'))", {
    timeoutMs: 30_000,
    label: "app sidebar",
  });

  const collapsed = await ctx.eval("Boolean(document.querySelector('[data-slot=\"sidebar\"][data-state=\"collapsed\"]'))").catch(() => false);
  if (collapsed) {
    await ctx.eval("document.querySelector('[data-sidebar=\"rail\"]')?.click(); true");
    await ctx.waitFor("!document.querySelector('[data-slot=\"sidebar\"][data-state=\"collapsed\"]')", {
      label: "expanded sidebar",
    });
  }
}

export default {
  id: "sidebar-build-identifier",
  title: "Sidebar footer does not display the OpenWork build identifier",
  kind: "user-facing",
  steps: [
    {
      name: "App boots with no build identifier in the sidebar footer",
      run: async (ctx) => {
        await ensureSidebarReady(ctx);

        const result = await ctx.eval(`(() => {
          const sidebar = document.querySelector('[data-slot="sidebar"]');
          const footer = sidebar?.querySelector('[data-sidebar="footer"]') ?? null;
          const identifier = document.querySelector(${JSON.stringify(IDENTIFIER_SELECTOR)});
          const footerText = (footer?.textContent ?? '').replace(/\\s+/g, ' ').trim();

          return {
            sidebarFound: Boolean(sidebar),
            footerFound: Boolean(footer),
            identifierFound: Boolean(identifier),
            footerText,
          };
        })()`);

        ctx.assert(result.sidebarFound, "The app sidebar was not rendered.");
        ctx.assert(result.footerFound, "The app sidebar footer was not rendered.");
        ctx.assert(!result.identifierFound, "The sidebar build identifier is still rendered.");
        ctx.assert(!/OpenWork\\s+(?:v?\\d+\\.\\d+\\.\\d+|[0-9a-f]{7})/i.test(result.footerText), `The sidebar footer still contains an OpenWork build identifier: "${result.footerText}".`);
        ctx.log(`Sidebar footer text: ${result.footerText || "(empty)"}`);
      },
    },
  ],
};
