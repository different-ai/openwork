import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  CLOUD_DESKTOP_DISTRIBUTION,
  ENTERPRISE_DESKTOP_DISTRIBUTION,
  PUBLIC_DESKTOP_DISTRIBUTION,
  resolveDesktopDistribution,
} from "../../apps/desktop/electron/desktop-distribution.mjs";

const workspaceStorePath = fileURLToPath(
  new URL("../../apps/desktop/electron/workspace-store.mjs", import.meta.url),
);
const mainPath = fileURLToPath(new URL("../../apps/desktop/electron/main.mjs", import.meta.url));

test("the three desktop builds own sign-in policy; no installer bundle rewrites it", async ({ evidence }) => {
  // Build contract: public is open, cloud forces sign-in, enterprise forces
  // sign-in plus activation against a self-hosted control plane.
  expect(PUBLIC_DESKTOP_DISTRIBUTION).toMatchObject({ flavor: "public", requireSignin: false, requireActivation: false });
  expect(CLOUD_DESKTOP_DISTRIBUTION).toMatchObject({ flavor: "cloud", requireSignin: true, requireActivation: false });
  expect(ENTERPRISE_DESKTOP_DISTRIBUTION).toMatchObject({ flavor: "enterprise", requireSignin: true, requireActivation: true });

  // Packaged builds trust only immutable package metadata, never the environment.
  expect(resolveDesktopDistribution({ isPackaged: true, packageFlavor: "cloud", environmentFlavor: "public" }).flavor).toBe("cloud");
  expect(resolveDesktopDistribution({ isPackaged: true, packageFlavor: undefined, environmentFlavor: "enterprise" }).flavor).toBe("public");
  expect(resolveDesktopDistribution({ isPackaged: false, packageFlavor: undefined, environmentFlavor: "enterprise" }).flavor).toBe("enterprise");

  evidence.recordAssertionEvidence(
    "Sign-in policy is fixed per build flavor",
    "public !requireSignin; cloud requireSignin; enterprise requireSignin+requireActivation; packaged builds ignore the environment flavor override",
    true,
  );

  // The organization installer-bundle import is gone: nothing scans Downloads
  // or Desktop for a desktop-bootstrap.json beside an installer, and boot does
  // not rewrite the persisted bootstrap from any bundle.
  const workspaceStore = readFileSync(workspaceStorePath, "utf8");
  const main = readFileSync(mainPath, "utf8");
  for (const marker of [
    "importBundledDesktopBootstrapConfigIfPreferred",
    "OPENWORK_BOOTSTRAP_BUNDLE_DIR",
    "STANDARD_DESKTOP_INSTALLER_PATTERN",
    "bundleSearchRoots",
  ]) {
    expect(workspaceStore).not.toContain(marker);
    expect(main).not.toContain(marker);
  }
  expect(workspaceStore).not.toContain('app.getPath("downloads")');

  evidence.recordAssertionEvidence(
    "No installer bundle can rewrite the desktop bootstrap",
    "workspace-store.mjs and main.mjs no longer scan Downloads/Desktop for bundled desktop-bootstrap.json files; org context arrives through the welcome join field (install link, invite, server URL, sign-in code) or the build flavor",
    true,
  );
});
