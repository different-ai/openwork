import assert from "node:assert/strict";

const { selectOpenworkWorkspace } = await import("../src/app/workspace/openwork-selection.ts");

const workspace = (id: string, directory?: string) => ({
  id,
  name: id,
  path: directory ?? "",
  preset: "remote",
  workspaceType: "remote" as const,
  remoteType: "openwork" as const,
  baseUrl: `https://example.com/w/${id}/opencode`,
  directory: directory ?? null,
  opencode: directory ? { directory } : undefined,
});

const results = {
  ok: true,
  steps: [] as Array<Record<string, unknown>>,
};

async function step(name: string, fn: () => void | Promise<void>) {
  results.steps.push({ name, status: "running" });
  const index = results.steps.length - 1;

  try {
    await fn();
    results.steps[index] = { name, status: "ok" };
  } catch (error) {
    results.ok = false;
    results.steps[index] = {
      name,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

try {
  await step("explicit workspace id wins", () => {
    const result = selectOpenworkWorkspace({
      items: [workspace("ws_alpha", "/repo/a"), workspace("ws_beta", "/repo/b")],
      workspaceId: "ws_beta",
    });

    assert.deepEqual(result, { ok: true, workspace: workspace("ws_beta", "/repo/b") });
  });

  await step("directory hint resolves normalized matches", () => {
    const result = selectOpenworkWorkspace({
      items: [workspace("ws_alpha", "/repo/a"), workspace("ws_beta", "/repo/b")],
      directoryHint: "/repo/b/",
    });

    assert.deepEqual(result, { ok: true, workspace: workspace("ws_beta", "/repo/b") });
  });

  await step("single-workspace hosts still connect without extra selectors", () => {
    const result = selectOpenworkWorkspace({
      items: [workspace("ws_only", "/repo/a")],
    });

    assert.deepEqual(result, { ok: true, workspace: workspace("ws_only", "/repo/a") });
  });

  await step("multi-workspace hosts reject ambiguous host-only connects", () => {
    const result = selectOpenworkWorkspace({
      items: [workspace("ws_alpha", "/repo/a"), workspace("ws_beta", "/repo/b")],
    });

    assert.deepEqual(result, {
      ok: false,
      reason: "ambiguous",
      message:
        "OpenWork host returned multiple workspaces. Use a workspace-scoped URL (/w/ws_*) or reconnect from the specific workspace.",
    });
  });

  await step("stale directory hints no longer silently fall back to the first workspace", () => {
    const result = selectOpenworkWorkspace({
      items: [workspace("ws_alpha", "/repo/a"), workspace("ws_beta", "/repo/b")],
      directoryHint: "/repo/missing",
    });

    assert.deepEqual(result, {
      ok: false,
      reason: "not-found",
      message: "OpenWork worker directory not found on that host.",
    });
  });

  console.log(JSON.stringify(results));
} catch {
  console.log(JSON.stringify(results));
  process.exitCode = 1;
}
