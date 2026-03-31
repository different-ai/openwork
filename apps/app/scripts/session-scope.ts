import assert from "node:assert/strict";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
  },
});

const {
  describeDirectoryScope,
  resolveScopedClientDirectory,
  scopedRootsMatch,
  shouldApplyScopedSessionLoad,
  shouldRedirectMissingSessionAfterScopedLoad,
  toSessionTransportDirectory,
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

  await step("windows create and list use the same transport directory", () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        platform: "Win32",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    });

    const winRoot = String.raw`C:\Users\Test\OpenWork\starter`;
    const transport = toSessionTransportDirectory(winRoot);

    assert.equal(transport, winRoot);
    assert.equal(resolveScopedClientDirectory({ workspaceType: "local", targetRoot: winRoot }), transport);
    assert.equal(resolveScopedClientDirectory({ workspaceType: "local", directory: winRoot }), transport);

    const uncRoot = String.raw`\\?\UNC\server\share\starter`;
    assert.equal(toSessionTransportDirectory(uncRoot), String.raw`\\server\share\starter`);
    assert.equal(describeDirectoryScope(uncRoot).normalized, "//server/share/starter");

    const verbatimDriveRoot = String.raw`\\?\C:\Users\Test\OpenWork\starter`;
    assert.equal(toSessionTransportDirectory(verbatimDriveRoot), String.raw`C:\Users\Test\OpenWork\starter`);
    assert.equal(describeDirectoryScope(verbatimDriveRoot).normalized, "c:/users/test/openwork/starter");
  });

  await step("round-trip invariant: every query path equals the create path (unix)", () => {
    // Restore macOS navigator for this step.
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      },
    });

    const unixPaths = [
      "/Users/test/OpenWork/starter",
      "/Users/test/OpenWork/starter/",
      "/home/user/projects/my-app",
      "/tmp/sandbox",
      "/private/tmp/sandbox",
    ];

    for (const raw of unixPaths) {
      const createDir = toSessionTransportDirectory(raw);
      const listDir = toSessionTransportDirectory(raw);
      const resolvedDir = resolveScopedClientDirectory({ workspaceType: "local", targetRoot: raw });
      assert.equal(createDir, listDir, `create vs list mismatch for: ${raw}`);
      assert.equal(createDir, resolvedDir, `create vs resolved mismatch for: ${raw}`);
    }
  });

  await step("round-trip invariant: every query path equals the create path (windows)", () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        platform: "Win32",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    });

    // Use escaped strings — Bun's parser chokes on String.raw inside array literals.
    const windowsPaths = [
      "C:\\Users\\Test\\OpenWork\\starter",
      "C:\\Users\\Test\\OpenWork\\starter\\",
      "D:\\projects\\my-app",
      "\\\\server\\share\\starter",
      "\\\\?\\C:\\Users\\Test\\OpenWork\\starter",
      "\\\\?\\UNC\\server\\share\\starter",
    ];

    for (const raw of windowsPaths) {
      const createDir = toSessionTransportDirectory(raw);
      const listDir = toSessionTransportDirectory(raw);
      const resolvedDir = resolveScopedClientDirectory({ workspaceType: "local", targetRoot: raw });
      assert.equal(createDir, listDir, `create vs list mismatch for: ${raw}`);
      assert.equal(createDir, resolvedDir, `create vs resolved mismatch for: ${raw}`);
    }
  });

  await step("idempotency: double-converting a transport directory is stable", () => {
    // Restore macOS for Unix paths.
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      },
    });

    const samples = [
      "/Users/test/OpenWork/starter",
      "/home/user/projects/my-app",
    ];
    for (const raw of samples) {
      const once = toSessionTransportDirectory(raw);
      const twice = toSessionTransportDirectory(once);
      assert.equal(once, twice, `not idempotent for unix path: ${raw}`);
    }

    // Switch to Windows.
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        platform: "Win32",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    });

    const winSamples = [
      "C:\\Users\\Test\\OpenWork\\starter",
      "\\\\server\\share\\starter",
    ];
    for (const raw of winSamples) {
      const once = toSessionTransportDirectory(raw);
      const twice = toSessionTransportDirectory(once);
      assert.equal(once, twice, `not idempotent for win path: ${raw}`);
    }
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
