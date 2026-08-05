/**
 * Product analytics instrumentation fires for app open and task creation.
 *
 * Every analytics capture is mirrored into the local app inspector
 * (window.__micx.record("analytics.<event>")), so this flow asserts
 * instrumentation without any analytics backend or network access.
 *
 * Requires an onboarded profile with at least one workspace (so the
 * session.create_task control action is available). On fresh profiles the
 * app sits on the welcome screen and the flow skips instead of failing.
 */
export default {
  id: "analytics-task-events",
  title: "Analytics events fire for app open and task creation",
  spec: "evals/react-session-flows.md",
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__micxControl)", {
      timeoutMs: 60_000,
      label: "control API",
    });
    const state = await ctx.waitFor(
      `(() => {
        const control = window.__micxControl;
        if (control.snapshot().route.startsWith("/welcome")) return "welcome";
        const action = control.listActions().find((a) => a.id === "session.create_task");
        if (action && !action.disabled) return "ready";
        return null;
      })()`,
      { timeoutMs: 30_000, label: "session.create_task enabled (or welcome screen)" },
    );
    return state === "welcome"
      ? "Profile is not onboarded (welcome screen, no workspace); session.create_task is unavailable."
      : null;
  },
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__micxControl) && Boolean(window.__micx)", {
          timeoutMs: 60_000,
          label: "control + inspector APIs",
        });
      },
    },
    {
      name: "app_opened captured",
      run: async (ctx) => {
        await ctx.waitFor(
          "window.__micx.events(200).some((e) => e.name === 'analytics.app_opened')",
          { timeoutMs: 15_000, label: "analytics.app_opened in inspector" },
        );
      },
    },
    {
      name: "Create a task via control action",
      run: async (ctx) => {
        await ctx.waitFor(
          "window.__micxControl.listActions().some((a) => a.id === 'session.create_task')",
          { timeoutMs: 30_000, label: "session.create_task action available" },
        );
        await ctx.control("session.create_task");
      },
    },
    {
      name: "task_created captured",
      run: async (ctx) => {
        await ctx.waitFor(
          "window.__micx.events(200).some((e) => e.name === 'analytics.task_created')",
          { timeoutMs: 30_000, label: "analytics.task_created in inspector" },
        );
        const events = await ctx.eval(
          "window.__micx.events(200).filter((e) => e.name.startsWith('analytics.')).map((e) => e.name)",
        );
        ctx.log(`analytics events: ${JSON.stringify(events)}`);
        await ctx.screenshot("task-created", {
          claim: "The app remains visibly usable after task creation analytics are captured.",
          rejectText: ["Something went wrong"],
        });
      },
    },
  ],
};
