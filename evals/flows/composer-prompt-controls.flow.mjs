import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "composer-prompt-controls";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function recordAssertion(ctx, assertion, passed, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

async function ensureSession(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API",
  });
  await ctx.eval(`document.querySelector('[data-slot="dialog-close"]')?.click()`);
  await ctx.waitFor(`!document.querySelector('[role="dialog"]')`, {
    timeoutMs: 10_000,
    label: "closed setup dialog",
  });
  const route = await ctx.eval(`window.__openworkControl.snapshot().route`);
  if (!route.includes("/session/") || route.endsWith("/session/new")) {
    const sessions = await ctx.control("session.list_sessions");
    const sessionId = sessions.find((session) => session?.sessionId)?.sessionId;
    if (!sessionId) throw new Error("Prompt control QA requires one persisted session.");
    await ctx.control("session.open", { sessionId });
  }
  await ctx.waitFor(`Boolean(document.querySelector('[data-composer-tools-trigger]'))`, {
    timeoutMs: 45_000,
    label: "prompt controls",
  });
}

async function readTokenEvidence(ctx, selector) {
  return ctx.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const style = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    return {
      fontFamily: style.fontFamily,
      appFontFamily: root.fontFamily,
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      color: style.color,
    };
  })()`);
}

export default {
  id: FLOW_ID,
  title: "Prompt controls share accessible shadcn surfaces and design tokens",
  kind: "user-facing",
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 60_000,
      label: "control API",
    });
    const route = await ctx.eval(`window.__openworkControl.snapshot().route || ""`);
    return route.startsWith("/welcome") || route.startsWith("/signin")
      ? "Profile is not onboarded; this flow requires an available workspace."
      : null;
  },
  steps: [
    {
      name: "Frame 1 — Agent select",
      run: async (ctx) => {
        await ctx.prove("The prompt agent control is a keyboard-ready select", {
          voiceover: vo[0],
          action: async () => {
            await ensureSession(ctx);
            await ctx.eval(`document.querySelector('[data-composer-agent-trigger]')?.click()`);
            await ctx.waitFor(`Boolean(document.querySelector('[data-composer-agent-content]'))`, {
              timeoutMs: 10_000,
              label: "agent select content",
            });
          },
          assert: async () => {
            const evidence = await ctx.eval(`(() => {
              const trigger = document.querySelector('[data-composer-agent-trigger]');
              const content = document.querySelector('[data-composer-agent-content]');
              return {
                triggerRole: trigger?.getAttribute("role"),
                expanded: trigger?.getAttribute("aria-expanded"),
                content: Boolean(content),
                optionCount: content?.querySelectorAll('[role="option"]').length ?? 0,
                defaultAgent: content?.textContent?.includes("Default agent") ?? false,
              };
            })()`);
            recordAssertion(
              ctx,
              "The agent trigger exposes an expanded select and its option surface",
              evidence?.triggerRole === "combobox"
                && evidence?.expanded === "true"
                && evidence?.content === true
                && evidence?.optionCount >= 1
                && evidence?.defaultAgent === true,
              evidence,
            );
          },
          screenshot: {
            name: "agent-select",
            requireText: ["Default agent"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2 — Tools browser",
      run: async (ctx) => {
        await ctx.prove("The tools browser docks at full composer width with vertical tabs and a scrollable panel", {
          voiceover: vo[1],
          action: async () => {
            await ctx.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
            await ctx.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
            await ctx.eval(`document.querySelector('[data-composer-tools-trigger]')?.click()`);
            await ctx.waitFor(`Boolean(document.querySelector('[data-composer-tools-content]'))`, {
              timeoutMs: 10_000,
              label: "docked tools browser",
            });
            await ctx.waitFor(
              `!document.querySelector('[data-composer-tools-content]')?.textContent?.includes("Loading commands")`,
              { timeoutMs: 15_000, label: "settled tools content" },
            );
            await ctx.waitFor(
              `(() => {
                const content = document.querySelector('[data-composer-tools-content]');
                const tabs = content?.querySelector('[data-slot="tabs"]')?.getBoundingClientRect();
                const list = content?.querySelector('[data-slot="tabs-list"]')?.getBoundingClientRect();
                return Boolean(tabs && list) && Math.abs(tabs.height - list.height) <= 2;
              })()`,
              { timeoutMs: 10_000, label: "settled docked tools layout" },
            );
          },
          assert: async () => {
            const evidence = await ctx.eval(`(() => {
              const content = document.querySelector('[data-composer-tools-content]');
              const tabs = content?.querySelector('[data-slot="tabs"]');
              const tabList = content?.querySelector('[data-slot="tabs-list"]');
              const firstTab = tabList?.querySelector('[data-slot="tabs-trigger"]');
              const viewport = content?.querySelector('[data-slot="scroll-area-viewport"]');
              const separator = content?.querySelector('[data-slot="composer-tools-separator"]');
              const composerPanel = content?.closest('[data-slot="composer-panel"]');
              const composerBody = composerPanel?.querySelector('[data-slot="composer-body"]');
              const contentRect = content?.getBoundingClientRect();
              const tabsRect = tabs?.getBoundingClientRect();
              const tabListRect = tabList?.getBoundingClientRect();
              const composerRect = composerPanel?.getBoundingClientRect();
              return {
                content: Boolean(content),
                insideComposer: Boolean(composerPanel),
                beforeEditor: Boolean(content && composerBody)
                  && Boolean(content.compareDocumentPosition(composerBody) & Node.DOCUMENT_POSITION_FOLLOWING),
                fillsComposerWidth: Boolean(contentRect && composerRect)
                  && Math.abs(contentRect.width - composerRect.width) <= 2,
                orientation: tabs?.getAttribute("data-orientation"),
                tabListRole: tabList?.getAttribute("role"),
                tabListFillsHeight: Boolean(tabsRect && tabListRect)
                  && Math.abs(tabsRect.height - tabListRect.height) <= 2,
                tabListRadius: tabList ? getComputedStyle(tabList).borderRadius : null,
                tabListAlignment: tabList ? getComputedStyle(tabList).justifyContent : null,
                compactTabRows: Boolean(firstTab)
                  && firstTab.getBoundingClientRect().height <= 64,
                separatorHeight: separator?.getBoundingClientRect().height ?? 0,
                viewport: Boolean(viewport),
                labels: content?.textContent ?? "",
              };
            })()`);
            recordAssertion(
              ctx,
              "The tools surface has vertical tabs, a tablist, and a shadcn scroll viewport",
              evidence?.content === true
                && evidence?.insideComposer === true
                && evidence?.beforeEditor === true
                && evidence?.fillsComposerWidth === true
                && evidence?.orientation === "vertical"
                && evidence?.tabListRole === "tablist"
                && evidence?.tabListFillsHeight === true
                && evidence?.tabListRadius === "0px"
                && evidence?.tabListAlignment === "flex-start"
                && evidence?.compactTabRows === true
                && evidence?.separatorHeight >= 8
                && evidence?.viewport === true
                && evidence?.labels.includes("Commands")
                && evidence?.labels.includes("Skills"),
              evidence,
            );
          },
          screenshot: {
            name: "tools-browser",
            requireText: ["Commands", "Skills", "Extensions", "Configure"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3 — Unified model settings",
      run: async (ctx) => {
        await ctx.prove("Model and effort live in one settings menu", {
          voiceover: vo[2],
          action: async () => {
            await ctx.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
            await ctx.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
            await ctx.eval(`document.querySelector('[data-model-settings-trigger]')?.click()`);
            await ctx.waitFor(`Boolean(document.querySelector('[data-model-settings-content]'))`, {
              timeoutMs: 10_000,
              label: "model settings menu",
            });
          },
          assert: async () => {
            const evidence = await ctx.eval(`(() => {
              const trigger = document.querySelector('[data-model-settings-trigger]');
              const content = document.querySelector('[data-model-settings-content]');
              const model = content?.querySelector('[data-model-settings-model-trigger]');
              const effort = content?.querySelector('[data-model-settings-effort-trigger]');
              return {
                expanded: trigger?.getAttribute("aria-expanded"),
                content: Boolean(content),
                model: model?.textContent ?? "",
                effort: effort?.textContent ?? "",
              };
            })()`);
            recordAssertion(
              ctx,
              "One expanded menu exposes both the model and its supported effort setting",
              evidence?.expanded === "true"
                && evidence?.content === true
                && evidence?.model.includes("Model")
                && Boolean(evidence?.effort),
              evidence,
            );
          },
          screenshot: {
            name: "unified-model-settings",
            requireText: ["Model"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4 — Native effort submenu",
      run: async (ctx) => {
        await ctx.prove("Effort options use the native menu scale and selection semantics", {
          voiceover: vo[3],
          action: async () => {
            await ctx.eval(`document.querySelector('[data-model-settings-effort-trigger]')?.click()`);
            await ctx.waitFor(`Boolean(document.querySelector('[data-model-settings-effort-content]'))`, {
              timeoutMs: 10_000,
              label: "effort submenu",
            });
          },
          assert: async () => {
            const evidence = await ctx.eval(`(() => {
              const model = document.querySelector('[data-model-settings-model-trigger]');
              const content = document.querySelector('[data-model-settings-effort-content]');
              const options = [...(content?.querySelectorAll('[data-model-settings-effort-option]') ?? [])];
              const checked = options.filter((option) => option.getAttribute("aria-checked") === "true");
              return {
                optionCount: options.length,
                checkedCount: checked.length,
                modelFontSize: model ? getComputedStyle(model).fontSize : null,
                optionFontSizes: options.map((option) => getComputedStyle(option).fontSize),
              };
            })()`);
            recordAssertion(
              ctx,
              "Effort has multiple radio choices, one selection, and the same font size as the root menu",
              evidence?.optionCount >= 2
                && evidence?.checkedCount === 1
                && Boolean(evidence?.modelFontSize)
                && evidence?.optionFontSizes.every((fontSize) => fontSize === evidence.modelFontSize),
              evidence,
            );
          },
          screenshot: {
            name: "native-effort-submenu",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5 — Searchable model submenu",
      run: async (ctx) => {
        await ctx.prove("The unified menu preserves searchable grouped models", {
          voiceover: vo[4],
          action: async () => {
            await ctx.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
            await ctx.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
            await ctx.eval(`document.querySelector('[data-model-settings-model-trigger]')?.click()`);
            await ctx.waitFor(`Boolean(document.querySelector('[data-model-settings-model-content] input[placeholder="Search models..."]'))`, {
              timeoutMs: 10_000,
              label: "model search submenu",
            });
            await ctx.eval(`document.querySelector('[data-model-settings-model-content] input[placeholder="Search models..."]')?.focus()`);
            for (const key of "Sonnet") {
              await ctx.client.send("Input.dispatchKeyEvent", {
                type: "keyDown",
                key,
                code: `Key${key.toUpperCase()}`,
                text: key,
                unmodifiedText: key,
              });
              await ctx.client.send("Input.dispatchKeyEvent", {
                type: "keyUp",
                key,
                code: `Key${key.toUpperCase()}`,
              });
            }
            await ctx.waitFor(
              `document.querySelector('[data-model-settings-model-content] input[placeholder="Search models..."]')?.value === "Sonnet"`,
              { timeoutMs: 10_000, label: "typed model search query" },
            );
          },
          assert: async () => {
            const tokens = await readTokenEvidence(ctx, "[data-model-settings-model-content]");
            const evidence = await ctx.eval(`(() => {
              const content = document.querySelector('[data-model-settings-model-content]');
              const rect = content?.getBoundingClientRect();
              const input = content?.querySelector('input[placeholder="Search models..."]');
              return {
                search: Boolean(input),
                searchValue: input?.value ?? "",
                groups: content?.querySelectorAll('[data-slot="command-group"]').length ?? 0,
                allModels: content?.textContent?.includes("All models") ?? false,
                inViewport: Boolean(rect)
                  && rect.left >= 0
                  && rect.top >= 0
                  && rect.right <= window.innerWidth
                  && rect.bottom <= window.innerHeight,
              };
            })()`);
            recordAssertion(
              ctx,
              "The searchable provider-grouped model submenu uses app tokens and stays inside the viewport",
              evidence?.search === true
                && evidence?.searchValue === "Sonnet"
                && evidence?.groups >= 1
                && evidence?.allModels === true
                && evidence?.inViewport === true
                && tokens !== null
                && tokens.fontFamily === tokens.appFontFamily
                && tokens.backgroundColor !== "rgba(0, 0, 0, 0)"
                && tokens.borderRadius !== "0px",
              { evidence, tokens },
            );
          },
          screenshot: {
            name: "searchable-model-submenu",
            requireText: ["All models"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
