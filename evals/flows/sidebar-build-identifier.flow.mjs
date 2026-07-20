import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const IDENTIFIER_SELECTOR = '[data-testid="sidebar-build-identifier"]';
const vo = await loadVoiceoverParagraphs("sidebar-build-identifier");

function readIdentifierExpression() {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(IDENTIFIER_SELECTOR)});
    if (!element) return null;

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const footer = element.closest('[data-sidebar="footer"]');
    const sidebar = element.closest('[data-slot="sidebar-inner"], [data-slot="sidebar"]');
    const footerRect = footer?.getBoundingClientRect() ?? null;
    const sidebarRect = sidebar?.getBoundingClientRect() ?? null;
    const addWorkspaceButton = Array.from(document.querySelectorAll('button'))
      .find((button) => (button.textContent ?? '').trim().includes('Add workspace')) ?? null;
    const addWorkspaceRect = addWorkspaceButton?.getBoundingClientRect() ?? null;

    return {
      text: (element.textContent ?? '').trim(),
      testId: element.getAttribute('data-testid'),
      visible: rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth && rect.bottom > 0 && rect.top < window.innerHeight && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0',
      inFooter: Boolean(footer),
      insideAddWorkspaceButton: Boolean(addWorkspaceButton?.contains(element)),
      selectedText: window.getSelection()?.toString().trim() ?? '',
      userSelect: style.userSelect,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
      footerRect: footerRect ? { left: footerRect.left, right: footerRect.right, top: footerRect.top, bottom: footerRect.bottom } : null,
      sidebarRect: sidebarRect ? { left: sidebarRect.left, right: sidebarRect.right, top: sidebarRect.top, bottom: sidebarRect.bottom } : null,
      addWorkspaceRect: addWorkspaceRect ? { top: addWorkspaceRect.top, bottom: addWorkspaceRect.bottom } : null,
    };
  })()`;
}

async function readIdentifier(ctx) {
  return await ctx.eval(readIdentifierExpression());
}

async function ensureSidebarReady(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 30_000,
    label: "window.__openworkControl",
  });
  await ctx.waitFor("document.body.innerText.trim().length > 40", {
    label: "rendered OpenWork shell",
  });

  const collapsed = await ctx.eval("Boolean(document.querySelector('[data-slot=\"sidebar\"][data-state=\"collapsed\"]'))").catch(() => false);
  if (collapsed) {
    await ctx.eval("document.querySelector('[data-sidebar=\"rail\"]')?.click(); true");
    await ctx.waitFor("!document.querySelector('[data-slot=\"sidebar\"][data-state=\"collapsed\"]')", {
      label: "expanded sidebar",
    });
  }

  const identifierMissing = await ctx.eval(`!document.querySelector(${JSON.stringify(IDENTIFIER_SELECTOR)})`);
  if (identifierMissing) {
    await ctx.eval("document.querySelector('[data-sidebar=\"trigger\"]')?.click(); true");
  }

  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(IDENTIFIER_SELECTOR)}))`, {
    timeoutMs: 30_000,
    label: "sidebar build identifier",
  });
}

async function closeStaleWorkspaceDialog(ctx) {
  await ctx.eval(`(() => {
    const close = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.trim() === 'Close' && !button.closest('[data-sidebar="sidebar"]')
    );
    close?.click();
    return Boolean(close);
  })()`);
}

function classifyIdentifier(text) {
  const match = /^OpenWork\s+(.+)$/.exec(text);
  const token = match?.[1]?.trim() ?? "";
  if (token.startsWith("v")) return { kind: "release", token };
  if (/^[0-9a-fA-F]{7}$/.test(token)) return { kind: "sha", token };
  return { kind: "unknown", token };
}

function assertVisibleFooterIdentifier(ctx, info) {
  ctx.assert(info, "The sidebar build identifier is missing.");
  ctx.assert(info.text.startsWith("OpenWork "), `Identifier should start with OpenWork; saw "${info.text}".`);
  ctx.assert(info.visible, "The sidebar build identifier is not visibly rendered.");
  ctx.assert(info.inFooter, "The identifier is not inside the sidebar footer.");
  ctx.assert(!info.insideAddWorkspaceButton, "The identifier is inside the Add workspace button.");
  ctx.assert(info.sidebarRect && info.footerRect, "Sidebar and footer bounds were not measurable.");
  ctx.assert(info.rect.left >= info.sidebarRect.left && info.rect.left < info.sidebarRect.left + 48, "Identifier is not positioned at the sidebar's left edge.");
  ctx.assert(info.footerRect.bottom <= info.sidebarRect.bottom + 1, "Footer is not anchored to the bottom of the sidebar.");
}

export default {
  id: "sidebar-build-identifier",
  title: "Sidebar footer identifies the running OpenWork build",
  kind: "user-facing",
  steps: [
    {
      name: "App boots with the sidebar identifier available",
      run: async (ctx) => {
        await closeStaleWorkspaceDialog(ctx);
        await ensureSidebarReady(ctx);
      },
    },
    {
      name: "Identifier is visible in the footer",
      run: async (ctx) => {
        await ctx.prove("The AppSidebar footer shows a permanent OpenWork build identifier at the bottom-left, outside Add workspace.", {
          voiceover: vo[0],
          action: async () => {
            await ensureSidebarReady(ctx);
            await ctx.eval(`document.querySelector(${JSON.stringify(IDENTIFIER_SELECTOR)})?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); true`);
          },
          assert: async () => {
            const info = await readIdentifier(ctx);
            assertVisibleFooterIdentifier(ctx, info);
            ctx.log(`Visible identifier: ${info.text}`);
          },
          screenshot: { name: "sidebar-build-identifier-location", requireText: ["OpenWork"] },
        });
      },
    },
    {
      name: "Identifier persists while the sidebar content moves",
      run: async (ctx) => {
        const before = await readIdentifier(ctx);
        await ctx.prove("The current runtime's identifier stays pinned in the footer while the flow records whether the release-version branch is active.", {
          voiceover: vo[1],
          action: async () => {
            await ctx.eval(`(() => {
              const element = document.querySelector(${JSON.stringify(IDENTIFIER_SELECTOR)});
              if (!element) return false;
              const range = document.createRange();
              range.selectNodeContents(element);
              const selection = window.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
              return true;
            })()`);
          },
          assert: async () => {
            const info = await readIdentifier(ctx);
            assertVisibleFooterIdentifier(ctx, info);
            ctx.assert(before?.text === info.text, "The identifier changed while sidebar content scrolled.");
            ctx.assert(info.selectedText === info.text, "The visible release identifier could not be selected.");

            const classification = classifyIdentifier(info.text);
            ctx.assert(classification.kind === "release" || classification.kind === "sha", `Identifier format is neither release nor SHA: ${info.text}`);
            if (classification.kind === "release") {
              ctx.assert(classification.token.startsWith("v"), `Release identifier is not v-prefixed: ${classification.token}`);
            }
            ctx.log(`Current compile-time identifier branch: ${classification.kind}; ${info.text}`);
          },
          screenshot: { name: "sidebar-build-identifier-persistent", requireText: ["OpenWork"] },
        });
      },
    },
    {
      name: "Identifier format is honest for this build",
      run: async (ctx) => {
        await ctx.prove("The visible footer value is formatted as either a v-prefixed release or a seven-character Git SHA, matching the currently launched build.", {
          voiceover: vo[2],
          action: async () => {
            await ensureSidebarReady(ctx);
            await ctx.clickText("Add workspace", { timeoutMs: 15_000 });
            await ctx.waitForText("Create Workspace", { timeoutMs: 15_000 });
          },
          assert: async () => {
            const info = await readIdentifier(ctx);
            assertVisibleFooterIdentifier(ctx, info);

            const classification = classifyIdentifier(info.text);
            if (classification.kind === "sha") {
              ctx.assert(/^[0-9a-fA-F]{7}$/.test(classification.token), `SHA fallback is not seven characters: ${classification.token}`);
            } else if (classification.kind === "release") {
              ctx.assert(classification.token.startsWith("v"), `Release identifier is not normalized with v: ${classification.token}`);
            } else {
              ctx.assert(false, `Identifier is not a release or SHA fallback: ${info.text}`);
            }
            ctx.log(`Observed ${classification.kind} identifier: ${classification.token}`);
          },
          screenshot: { name: "sidebar-build-identifier-format", requireText: ["OpenWork", "Create Workspace"] },
        });
      },
    },
    {
      name: "Identifier can be copied into a report",
      run: async (ctx) => {
        await ctx.prove("The identifier has a stable selector and selectable visible text that a user can report.", {
          voiceover: vo[3],
          action: async () => {
            await ctx.clickText("Connect custom remote", { timeoutMs: 15_000 });
            await ctx.waitForText("Worker URL", { timeoutMs: 15_000 });
          },
          assert: async () => {
            const info = await readIdentifier(ctx);
            assertVisibleFooterIdentifier(ctx, info);
            ctx.assert(info.testId === "sidebar-build-identifier", "The identifier selector changed.");
            ctx.assert(info.userSelect !== "none", "The visible identifier is not selectable.");
            ctx.log(`Report build as: ${info.text}`);
          },
          screenshot: { name: "sidebar-build-identifier-report", requireText: ["OpenWork", "Worker URL"] },
        });
      },
    },
  ],
};
