import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export async function ensureSessionWorkspace(ctx, flowId) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API",
  });
  const canCreateTask = await ctx.eval(
    "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
  );
  if (!canCreateTask) {
    const artifactsDir = process.env.OPENWORK_EVAL_ARTIFACTS_DIR?.trim();
    const workspacePath = artifactsDir
      ? resolve(artifactsDir, "..", `${flowId}-workspace`)
      : resolve(tmpdir(), `openwork-eval-${flowId}-workspace`);
    await mkdir(workspacePath, { recursive: true });
    const welcomeInput = 'input[placeholder="/workspace/my-project"]';
    const onWelcome = await ctx.eval(
      `Boolean(document.querySelector(${JSON.stringify(welcomeInput)}))`,
    );
    if (onWelcome) {
      await ctx.fill(welcomeInput, workspacePath);
      await ctx.clickText("Use this folder", {
        selector: "button",
        timeoutMs: 10_000,
      });
      await ctx
        .clickText("Skip and use the free model", {
          selector: "button",
          timeoutMs: 30_000,
        })
        .catch(() => {});
      await ctx
        .clickText("Skip", { selector: "button", timeoutMs: 10_000 })
        .catch(() => {});
    } else {
      await ctx.waitFor(
        "window.__openworkControl.listActions().some((action) => action.id === 'workspace.create' && !action.disabled)",
        { timeoutMs: 30_000, label: "workspace.create enabled" },
      );
      await ctx.control("workspace.create", { path: workspacePath });
    }
  }
  await ctx.waitFor(
    "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
    { timeoutMs: 90_000, label: "session.create_task enabled" },
  );
}

export async function sessionIds(ctx) {
  return ctx.eval(`(() => {
    const route = window.__openwork?.slice?.("route");
    return Object.values(route?.sessionsByWorkspaceId || {})
      .flatMap((sessions) => Array.isArray(sessions) ? sessions : [])
      .map((session) => typeof session?.id === "string" ? session.id.trim() : "")
      .filter(Boolean);
  })()`);
}

export async function waitForCreatedSession(ctx, previousSessionIds, label = "created session") {
  const sessionId = await ctx.waitFor(`(() => {
    const previous = new Set(${JSON.stringify(previousSessionIds ?? [])});
    const route = window.__openwork?.slice?.("route");
    const sessions = Object.values(route?.sessionsByWorkspaceId || {})
      .flatMap((items) => Array.isArray(items) ? items : []);
    const created = sessions.find((session) => {
      const id = typeof session?.id === "string" ? session.id.trim() : "";
      return id && !previous.has(id);
    });
    return typeof created?.id === "string" ? created.id.trim() : null;
  })()`, { timeoutMs: 45_000, label });
  await ctx.control("session.open", { sessionId });
  await ctx.waitFor(`(() => {
    const expected = ${JSON.stringify(sessionId)};
    const selected = window.__openwork?.slice?.("route")?.selectedSessionId;
    const controlRoute = window.__openworkControl?.snapshot?.().route || "";
    return selected === expected || controlRoute.includes(expected);
  })()`, { timeoutMs: 30_000, label: `${label} route` });
  return sessionId;
}

export async function createSession(ctx, label = "created session") {
  const previousSessionIds = await sessionIds(ctx);
  await ctx.control("session.create_task");
  return waitForCreatedSession(ctx, previousSessionIds, label);
}
