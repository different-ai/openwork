/**
 * Artifact pane tab overflow: many artifact tabs overflow horizontally, stay
 * reachable, and the newly selected tab is scrolled into view.
 */
export default {
  id: "artifact-tab-overflow",
  title: "Artifact pane tabs overflow horizontally and selected tabs remain visible",
  spec: "evals/react-session-flows.md",
  steps: [
    {
      name: "App is ready and Electron-backed",
      run: async (ctx) => {
        const userAgent = await ctx.eval("navigator.userAgent");
        ctx.assert(userAgent.includes("Electron/"), `Expected Electron userAgent, got ${userAgent}`);
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 60_000,
          label: "control API",
        });
      },
    },
    {
      name: "Create or select a task and mount the side panel",
      run: async (ctx) => {
        const hasSelectedSession = await ctx.eval(`window.__openworkControl.snapshot().route.includes("/session/")`);
        if (!hasSelectedSession) {
          await ctx.control("session.create_task");
          await ctx.waitFor(
            `window.__openworkControl.snapshot().route.includes("/session/")`,
            { timeoutMs: 60_000, label: "session route after task creation" },
          );
        }

        await ctx.eval(`(() => {
          const button = Array.from(document.querySelectorAll("button"))
            .find((item) => item.getAttribute("aria-label") === "Browser" && !item.disabled);
          button?.click();
          return Boolean(button);
        })()`);
        await ctx.waitFor(
          `window.__openworkControl.listActions().some((a) => a.id === "eval.artifact_tabs.seed_overflow" && !a.disabled)`,
          { timeoutMs: 30_000, label: "artifact overflow eval seed action" },
        );
      },
    },
    {
      name: "Seed many artifact tabs and assert horizontal overflow",
      run: async (ctx) => {
        await ctx.control("eval.artifact_tabs.seed_overflow", { count: 18 });
        const metrics = await ctx.waitFor(
          `(() => {
            const buttons = Array.from(document.querySelectorAll('button[aria-label^="Select tab: overflow-tab"]'));
            const scroller = Array.from(document.querySelectorAll("div"))
              .find((item) => item.className && String(item.className).includes("overflow-x-auto") && buttons.some((button) => item.contains(button)));
            if (!scroller || buttons.length < 18) return null;
            const last = buttons[buttons.length - 1];
            const scrollerRect = scroller.getBoundingClientRect();
            const lastRect = last.getBoundingClientRect();
            const heading = document.querySelector("h3")?.textContent?.trim() || "";
            return {
              buttonCount: buttons.length,
              clientWidth: scroller.clientWidth,
              scrollWidth: scroller.scrollWidth,
              scrollLeft: scroller.scrollLeft,
              lastVisible: lastRect.left >= scrollerRect.left - 1 && lastRect.right <= scrollerRect.right + 1,
              heading,
            };
          })()`,
          { timeoutMs: 30_000, label: "artifact tabs and overflow metrics" },
        );

        ctx.assert(metrics.buttonCount >= 18, `Expected at least 18 artifact tabs, got ${metrics.buttonCount}`);
        ctx.assert(metrics.scrollWidth > metrics.clientWidth + 100, `Expected horizontal overflow, got scrollWidth=${metrics.scrollWidth}, clientWidth=${metrics.clientWidth}`);
        ctx.assert(metrics.lastVisible, "Newly opened active artifact tab was not scrolled into view.");
        ctx.assert(metrics.heading.includes("overflow-tab-18.md"), `Expected active artifact heading for tab 18, got ${metrics.heading}`);
        await ctx.screenshot("overflow-last-tab-visible");
      },
    },
    {
      name: "Overflowed artifact tabs remain accessible after horizontal scrolling",
      run: async (ctx) => {
        await ctx.control("eval.artifact_tabs.seed_overflow", { count: 18 });
        await ctx.waitFor(
          `document.querySelectorAll('button[aria-label^="Select tab: overflow-tab"]').length >= 18`,
          { timeoutMs: 10_000, label: "reseeded overflow artifact tabs" },
        );
        const firstResult = await ctx.eval(`(() => {
          const buttons = Array.from(document.querySelectorAll('button[aria-label^="Select tab: overflow-tab"]'));
          const scroller = Array.from(document.querySelectorAll("div"))
            .find((item) => item.className && String(item.className).includes("overflow-x-auto") && buttons.some((button) => item.contains(button)));
          if (!scroller || buttons.length < 18) return { ok: false, reason: "missing tabs" };
          buttons[0].scrollIntoView({ block: "nearest", inline: "nearest" });
          buttons[0].click();
          const scrollerRect = scroller.getBoundingClientRect();
          const rect = buttons[0].getBoundingClientRect();
          return {
            ok: true,
            firstVisible: rect.left >= scrollerRect.left - 1 && rect.right <= scrollerRect.right + 1,
          };
        })()`);
        ctx.assert(firstResult.ok, firstResult.reason || "Could not select first overflow tab.");
        await ctx.waitFor(`(document.querySelector("h3")?.textContent || "").includes("overflow-tab-01.md")`, {
          timeoutMs: 10_000,
          label: "first artifact selected",
        });
        ctx.assert(firstResult.firstVisible, "First artifact tab was not visible after scrolling back.");

        const lastResult = await ctx.eval(`(() => {
          const buttons = Array.from(document.querySelectorAll('button[aria-label^="Select tab: overflow-tab"]'));
          const scroller = Array.from(document.querySelectorAll("div"))
            .find((item) => item.className && String(item.className).includes("overflow-x-auto") && buttons.some((button) => item.contains(button)));
          if (!scroller || buttons.length < 18) return { ok: false, reason: "missing tabs" };
          const last = buttons[buttons.length - 1];
          last.scrollIntoView({ block: "nearest", inline: "nearest" });
          last.click();
          const scrollerRect = scroller.getBoundingClientRect();
          const rect = last.getBoundingClientRect();
          return {
            ok: true,
            lastVisible: rect.left >= scrollerRect.left - 1 && rect.right <= scrollerRect.right + 1,
            scrollLeft: scroller.scrollLeft,
          };
        })()`);
        ctx.assert(lastResult.ok, lastResult.reason || "Could not select last overflow tab.");
        await ctx.waitFor(`(document.querySelector("h3")?.textContent || "").includes("overflow-tab-18.md")`, {
          timeoutMs: 10_000,
          label: "last artifact selected again",
        });
        ctx.assert(lastResult.lastVisible, "Last artifact tab was not visible after reselection.");
        ctx.assert(lastResult.scrollLeft > 0, `Expected horizontal scroll position > 0, got ${lastResult.scrollLeft}`);
        await ctx.screenshot("overflow-tabs-accessible-after-scroll");
      },
    },
  ],
};
