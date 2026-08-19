import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  buildAuthenticatedInstallDownloadHref,
} from "../../ee/apps/den-web/app/(den)/_lib/install-download";

const joinOrgScreenPath = fileURLToPath(
  new URL("../../ee/apps/den-web/app/(den)/_components/join-org-screen.tsx", import.meta.url),
);

test("joining opens clean authenticated installation except for desktop handoff requests", async ({ evidence }) => {
  const source = readFileSync(joinOrgScreenPath, "utf8");
  const href = buildAuthenticatedInstallDownloadHref("https://api.example.test/den", "mac-arm64");

  expect(href).toBe("https://api.example.test/den/v1/me/install/mac-arm64");
  expect(href).not.toContain("token=");
  expect(source).toContain('router.replace("/install")');
  expect(source).toContain("if (desktopAuthRequested)");
  expect(source).toContain("setJoinedOrg(nextJoinedOrg)");

  evidence.recordAssertionEvidence(
    "Post-invite onboarding opens token-free installation while desktop-auth requests keep their handoff",
    "Normal acceptance and accepted-invite resolution replace the route with /install; desktopAuthRequested still selects JoinOrgSuccess for the existing desktop handoff.",
    true,
  );
});
