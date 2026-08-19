import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  parseInviteLinkInput,
  parseServerUrlInput,
} from "../../apps/app/src/react-app/domains/cloud/join-organization-input";

const welcomePagePath = fileURLToPath(
  new URL("../../apps/app/src/react-app/domains/onboarding/welcome-page.tsx", import.meta.url),
);
const dialogPath = fileURLToPath(
  new URL("../../apps/app/src/react-app/domains/cloud/join-organization-dialog.tsx", import.meta.url),
);
const enLocalePath = fileURLToPath(
  new URL("../../apps/app/src/i18n/locales/en.ts", import.meta.url),
);

test("the welcome screen folds the server-URL door into the join-organization field", async ({ evidence }) => {
  const welcomeSource = readFileSync(welcomePagePath, "utf8");
  const dialogSource = readFileSync(dialogPath, "utf8");
  const enLocale = readFileSync(enLocalePath, "utf8");

  const invite = parseInviteLinkInput("https://den.acme.test/join-org?invite=inv_123");
  expect(invite).toEqual({
    url: "https://den.acme.test/join-org?invite=inv_123",
    origin: "https://den.acme.test",
    host: "den.acme.test",
  });
  expect(parseInviteLinkInput("https://den.acme.test/install?token=abc")).toBeNull();
  expect(parseServerUrlInput("https://openwork.acme.test/")).toEqual({
    url: "https://openwork.acme.test",
    host: "openwork.acme.test",
  });
  expect(parseServerUrlInput("openwork://den-auth?grant=abcdefghijkl")).toBeNull();
  expect(parseServerUrlInput("raw-sign-in-grant-value")).toBeNull();

  expect(welcomeSource).not.toContain("OrganizationServerAffordance");
  expect(welcomeSource).toContain('data-testid="welcome-join-org"');
  expect(enLocale).toContain('"welcome.join_org_subtitle": "Paste your invite link, install link, or server URL"');

  expect(dialogSource).toContain("if (await submitInstallLink(trimmedInput)) return;");
  expect(dialogSource).toContain("if (await submitInviteLink(trimmedInput)) return;");
  expect(dialogSource).toContain("if (await submitServerUrl(trimmedInput)) return;");
  expect(dialogSource).toContain("if (await submitManualAuth(trimmedInput)) return;");
  expect(dialogSource).toContain("setPendingInvite(parsed)");
  expect(dialogSource).toContain('data-testid="join-invite-confirm-dialog"');
  expect(dialogSource).toContain("saveControlPlaneUrl(invite.origin)");
  expect(dialogSource).toContain("platform.openLink(invite.url)");

  evidence.recordAssertionEvidence(
    "The welcome screen has one paste field for invite links, install links, server URLs, and sign-in codes",
    "The separate Using OpenWork on-premises affordance is gone from Welcome; the join dialog classifies install link, then invite link, then server URL, then sign-in code, and requires explicit host confirmation before opening web invites.",
    true,
  );
});
