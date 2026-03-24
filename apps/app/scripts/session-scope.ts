import assert from "node:assert/strict";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
  },
});

const {
  resolveScopedClientDirectory,
  scopedRootsMatch,
  shouldApplyScopedSessionLoad,
  shouldRedirectMissingSessionAfterScopedLoad,
} = await import("../src/app/lib/session-scope.ts");

const starterRoot = "/Users/test/OpenWork/starter";
const otherRoot = "/Users/test/OpenWork/second";

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
  await step("local connect prefers explicit target root", () => {
    assert.equal(
      resolveScopedClientDirectory({ workspaceType: "local", targetRoot: starterRoot }),
      starterRoot,
    );
    assert.equal(
      resolveScopedClientDirectory({
        workspaceType: "local",
        directory: otherRoot,
        targetRoot: starterRoot,
      }),
      otherRoot,
    );
  });

  await step("remote connect still waits for remote discovery", () => {
    assert.equal(resolveScopedClientDirectory({ workspaceType: "remote", targetRoot: starterRoot }), "");
  });

  await step("scope matching is stable on desktop-style paths", () => {
    assert.equal(scopedRootsMatch(`${starterRoot}/`, starterRoot.toUpperCase()), true);
    assert.equal(scopedRootsMatch(starterRoot, otherRoot), false);
  });

  await step("stale session loads cannot overwrite another workspace sidebar", () => {
    for (let index = 0; index < 50; index += 1) {
      assert.equal(
        shouldApplyScopedSessionLoad({
          loadedScopeRoot: otherRoot,
          workspaceRoot: starterRoot,
        }),
        false,
      );
    }
  });

  await step("same-scope session loads still update the active workspace", () => {
    assert.equal(
      shouldApplyScopedSessionLoad({
        loadedScopeRoot: `${starterRoot}/`,
        workspaceRoot: starterRoot,
      }),
      true,
    );
  });

  await step("route guard only redirects when the loaded scope matches", () => {
    assert.equal(
      shouldRedirectMissingSessionAfterScopedLoad({
        loadedScopeRoot: otherRoot,
        workspaceRoot: starterRoot,
        hasMatchingSession: false,
      }),
      false,
    );
    assert.equal(
      shouldRedirectMissingSessionAfterScopedLoad({
        loadedScopeRoot: starterRoot,
        workspaceRoot: starterRoot,
        hasMatchingSession: false,
      }),
      true,
    );
    assert.equal(
      shouldRedirectMissingSessionAfterScopedLoad({
        loadedScopeRoot: starterRoot,
        workspaceRoot: starterRoot,
        hasMatchingSession: true,
      }),
      false,
    );
  });

  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  results.ok = false;
  console.error(
    JSON.stringify(
      {
        ...results,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
