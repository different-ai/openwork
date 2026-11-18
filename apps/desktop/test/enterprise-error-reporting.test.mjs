import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOUD_DESKTOP_DISTRIBUTION,
  ENTERPRISE_DESKTOP_DISTRIBUTION,
  PUBLIC_DESKTOP_DISTRIBUTION,
  desktopErrorReportingAllowed,
} from "../electron/desktop-distribution.mjs";
import { initOpenworkSentry, setOpenworkSentrySession } from "../electron/sentry.mjs";

test("only OpenWork Enterprise is barred from error reporting", () => {
  assert.equal(desktopErrorReportingAllowed(PUBLIC_DESKTOP_DISTRIBUTION), true);
  assert.equal(desktopErrorReportingAllowed(CLOUD_DESKTOP_DISTRIBUTION), true);
  assert.equal(desktopErrorReportingAllowed(ENTERPRISE_DESKTOP_DISTRIBUTION), false);
});

test("OpenWork Enterprise never starts error reporting, so a signed-in session cannot switch it on", async () => {
  const app = {
    get isPackaged() { throw new Error("build configuration must not be read"); },
  };
  const started = await initOpenworkSentry({
    app,
    distribution: ENTERPRISE_DESKTOP_DISTRIBUTION,
    packageMetadata: {},
  });
  assert.equal(started, false);
  assert.equal(setOpenworkSentrySession({ userId: "user_1", orgId: "org_1" }), false);
});
