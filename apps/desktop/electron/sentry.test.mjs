import assert from "node:assert/strict";
import test from "node:test";

import {
  createGpuAbnormalExitSuppressor,
  isNoisyGpuAbnormalExitEvent,
  resolveOpenworkSentryAppVersion,
  resolveOpenworkSentryRelease,
} from "./sentry.mjs";

test("only the known GPU abnormal-exit message is treated as Sentry noise", () => {
  assert.equal(isNoisyGpuAbnormalExitEvent({
    level: "warning",
    message: "'GPU' process exited with 'abnormal-exit'",
    tags: { "event.process": "GPU" },
  }), true);

  assert.equal(isNoisyGpuAbnormalExitEvent({
    level: "warning",
    message: "'Utility' process exited with 'abnormal-exit'",
    tags: { "event.process": "Utility" },
  }), false);
  assert.equal(isNoisyGpuAbnormalExitEvent({
    level: "warning",
    message: "'GPU' process exited with 'abnormal-exit'",
    tags: { "event.process": "Utility" },
  }), false);
  assert.equal(isNoisyGpuAbnormalExitEvent({
    level: "warning",
    message: "GPU initialization failed with abnormal-exit",
    tags: { "event.process": "GPU" },
  }), false);
});

test("actionable GPU process failures remain reportable", () => {
  for (const reason of ["crashed", "oom", "launch-failed", "integrity-failure"]) {
    assert.equal(isNoisyGpuAbnormalExitEvent({
      level: "error",
      message: `'GPU' process exited with '${reason}'`,
      tags: { "event.process": "GPU" },
    }), false, reason);
  }

  assert.equal(isNoisyGpuAbnormalExitEvent({
    level: "error",
    message: "'GPU' process exited with 'abnormal-exit'",
    tags: { "event.process": "GPU" },
  }), false);
});

test("only the first recoverable GPU warning is suppressed in a bounded interval", () => {
  let now = 1_000;
  const shouldSuppress = createGpuAbnormalExitSuppressor({
    now: () => now,
    windowMs: 60_000,
  });
  const warning = {
    level: "warning",
    message: "'GPU' process exited with 'abnormal-exit'",
    tags: { "event.process": "GPU" },
  };

  assert.equal(shouldSuppress(warning), true);
  now += 1_000;
  assert.equal(shouldSuppress(warning), false);
  now += 59_000;
  assert.equal(shouldSuppress(warning), true);
});

test("unpackaged Sentry release uses the desktop package version", () => {
  const appVersion = resolveOpenworkSentryAppVersion({
    app: { isPackaged: false, getVersion: () => "43.2.0" },
    packageMetadata: { version: "0.18.7" },
  });

  assert.equal(appVersion, "0.18.7");
  assert.equal(
    resolveOpenworkSentryRelease({ appVersion, environmentRelease: "" }),
    "openwork-desktop@0.18.7",
  );
});

test("packaged Sentry release uses Electron's stamped app version", () => {
  const appVersion = resolveOpenworkSentryAppVersion({
    app: { isPackaged: true, getVersion: () => "0.18.8" },
    packageMetadata: { version: "0.18.7" },
  });

  assert.equal(appVersion, "0.18.8");
  assert.equal(
    resolveOpenworkSentryRelease({ appVersion, environmentRelease: "" }),
    "openwork-desktop@0.18.8",
  );
});

test("Sentry release still honors an explicit build override", () => {
  assert.equal(
    resolveOpenworkSentryRelease({
      appVersion: "0.18.8",
      environmentRelease: "desktop-main@abcdef",
    }),
    "desktop-main@abcdef",
  );
});
