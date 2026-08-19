import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { buildAuthenticatedInstallDownloadHref } from "../../ee/apps/den-web/app/(den)/_lib/install-download";

const installScreenPath = fileURLToPath(
  new URL("../../ee/apps/den-web/app/(den)/_components/install-screen.tsx", import.meta.url),
);
const joinOrgScreenPath = fileURLToPath(
  new URL("../../ee/apps/den-web/app/(den)/_components/join-org-screen.tsx", import.meta.url),
);
const memberDashboardPath = fileURLToPath(
  new URL("../../ee/apps/den-web/app/(den)/dashboard/_components/member-dashboard-screen.tsx", import.meta.url),
);
const installRoutesPath = fileURLToPath(
  new URL("../../ee/apps/den-api/src/routes/org/install-links.ts", import.meta.url),
);

test("signed-in members use clean active-organization install routes without minting an install token", async ({ evidence }) => {
  const installScreen = readFileSync(installScreenPath, "utf8");
  const joinOrgScreen = readFileSync(joinOrgScreenPath, "utf8");
  const memberDashboard = readFileSync(memberDashboardPath, "utf8");
  const installRoutes = readFileSync(installRoutesPath, "utf8");

  expect(buildAuthenticatedInstallDownloadHref("https://api.example.test/den", "win-x64"))
    .toBe("https://api.example.test/den/v1/me/install/win-x64");

  expect(installScreen).toContain('fetchInstallConfig(token || null)');
  expect(installScreen).toContain('token ? `/v1/install-config?token=');
  expect(installScreen).toContain('"/v1/me/install-config"');
  expect(installScreen).toContain("buildAuthenticatedInstallDownloadHref");
  expect(installScreen).toContain('data-testid="install-workspace-address"');
  expect(installScreen).toContain("In the app, enter your workspace address:");

  expect(joinOrgScreen).toContain('router.replace("/install")');
  expect(joinOrgScreen).toContain("desktopAuthRequested");
  expect(memberDashboard).toContain('router.push("/install")');
  expect(memberDashboard).not.toContain("createOrganizationInstallLink");
  expect(memberDashboard).not.toContain("/v1/install-config?token=");

  expect(installRoutes).toContain('"/v1/me/install-config"');
  expect(installRoutes).toContain('"/v1/me/install/:platform"');
  expect(installRoutes).toContain("installerReleaseTagForMetadata(payload.organization.metadata)");
  expect(installRoutes).toContain("distribution: managedDesktopDistribution()");
  expect(installRoutes).toContain("orgMemberRoute()");

  evidence.recordAssertionEvidence(
    "Authenticated onboarding uses the active organization without install tokens",
    "Clean /install loads /v1/me/install-config, downloads through /v1/me/install/:platform, post-invite and member actions navigate to /install, and the clipboard OpenWork-link guide remains present.",
    true,
  );
});
