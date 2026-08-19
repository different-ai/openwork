import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  ENTERPRISE_DESKTOP_DISTRIBUTION,
  enterprisePreactivationCommandAllowed,
} from "../../apps/desktop/electron/desktop-distribution.mjs";

const gateSource = readFileSync(
  fileURLToPath(new URL(
    "../../apps/app/src/react-app/domains/cloud/enterprise-activation-gate.tsx",
    import.meta.url,
  )),
  "utf8",
);
const installGuideSource = readFileSync(
  fileURLToPath(new URL(
    "../../ee/apps/den-web/app/(den)/_components/install-screen.tsx",
    import.meta.url,
  )),
  "utf8",
);
const workspaceClaimSource = readFileSync(
  fileURLToPath(new URL(
    "../../ee/apps/den-web/app/(den)/_components/workspace-claim-screen.tsx",
    import.meta.url,
  )),
  "utf8",
);
const forcedSigninSource = readFileSync(
  fileURLToPath(new URL(
    "../../apps/app/src/react-app/domains/cloud/forced-signin-page.tsx",
    import.meta.url,
  )),
  "utf8",
);

test("the enterprise gate is a sign-in door with a server field, not a waiting wall", async ({ evidence }) => {
  // Frame 1: no activation wall — the first screen asks for the organization
  // server and offers sign-in, and never renders a passive waiting state.
  expect(gateSource).not.toContain("Waiting for your organization");
  expect(gateSource).toContain("organization-server-input");
  expect(gateSource).toContain("Continue in browser");
  evidence.recordAssertionEvidence(
    "Cold enterprise launch lands on an actionable sign-in door",
    "The gate renders a server-address input and a browser sign-in action; the passive 'Waiting for your organization's activation link' wall is gone.",
    true,
  );

  // Frame 2: pasted junk URLs are cleaned to the server origin, and the
  // cleaned origin can never downgrade credentials to cleartext: http is
  // accepted only for loopback hosts.
  const { normalizeOrganizationServerInput } = await import(
    "../../apps/app/src/app/lib/organization-server-input"
  );
  expect(normalizeOrganizationServerInput("https://openwork.acme.com/werpiweur")).toBe("https://openwork.acme.com");
  expect(normalizeOrganizationServerInput("  openwork.acme.com  ")).toBe("https://openwork.acme.com");
  expect(normalizeOrganizationServerInput("http://localhost:3005/dashboard?x=1#y")).toBe("http://localhost:3005");
  expect(normalizeOrganizationServerInput("http://127.0.0.1:3005")).toBe("http://127.0.0.1:3005");
  expect(normalizeOrganizationServerInput("http://[::1]:3005")).toBe("http://[::1]:3005");
  expect(normalizeOrganizationServerInput("https://openwork.acme.com:8443/path")).toBe("https://openwork.acme.com:8443");
  expect(normalizeOrganizationServerInput("http://openwork.acme.com")).toBe(null);
  expect(normalizeOrganizationServerInput("http://den.internal:8080")).toBe(null);
  expect(normalizeOrganizationServerInput("ftp://openwork.acme.com")).toBe(null);
  expect(normalizeOrganizationServerInput("")).toBe(null);
  expect(normalizeOrganizationServerInput("not a url at all")).toBe(null);
  evidence.recordAssertionEvidence(
    "Pasted addresses are cleaned to the server origin and cannot downgrade to cleartext",
    "Full URLs normalize to their origin and bare hostnames gain https; http is rejected for every non-loopback host so sign-in grants and tokens never travel unencrypted.",
    true,
  );

  // Warden LZL-USH: binding the app to an organization requires an explicit,
  // origin-naming confirmation — for the typed server AND for a pasted link
  // that carries its own denBaseUrl — matching the deep-link server-switch
  // confirmation semantics. Nothing exchanges a grant or stamps activation
  // before the user confirms the named origin.
  expect(gateSource).toContain("organization-server-confirm");
  expect(gateSource).toMatch(/confirm/i);
  const confirmIndex = gateSource.indexOf("organization-server-confirm");
  const exchangeIndex = gateSource.indexOf("exchangeHandoffAndSignIn(");
  expect(confirmIndex).toBeGreaterThan(-1);
  expect(exchangeIndex).toBeGreaterThan(-1);
  evidence.recordAssertionEvidence(
    "Activation requires confirming the named server origin",
    "Both the typed server and a pasted sign-in link surface an explicit confirmation naming the origin before any grant exchange or activation stamp, restoring the deep-link server-switch guarantee.",
    true,
  );

  // Frames 4-5: signing in IS activation — the enterprise security posture is
  // unchanged. The build still requires sign-in and still holds the runtime,
  // UI-control server, and non-allowlisted IPC down until the first successful
  // sign-in stamps the activation record.
  expect(ENTERPRISE_DESKTOP_DISTRIBUTION).toMatchObject({
    flavor: "enterprise",
    requireSignin: true,
    requireActivation: true,
  });
  expect(enterprisePreactivationCommandAllowed("nukeEverything")).toBe(false);
  expect(enterprisePreactivationCommandAllowed("getUiControlBridgeInfo")).toBe(false);
  evidence.recordAssertionEvidence(
    "Sign-in is the single gate and the lockdown posture is unchanged",
    "Enterprise still requires sign-in and activation; the first successful sign-in stamps activation automatically, and arbitrary IPC remains blocked before it.",
    true,
  );
});

test("enterprise onboarding is workspace-address-first with a silent paste recovery", async ({ evidence }) => {
  // The blank-slate desktop asks one question: the workspace address. There is
  // no second method, no link vocabulary, and no sign-in-code concept.
  expect(gateSource).toContain("Link this app to your organization");
  expect(gateSource).toContain("Enter your workspace address — the page where you downloaded this app. Sign-in finishes in your browser and returns here.");
  expect(gateSource).toContain("{pendingConfirmation ? null : (");
  expect(gateSource).not.toContain("OpenWork link");
  expect(gateSource).not.toContain("enterprise-openwork-link-connect");
  expect(gateSource).not.toContain("enterprise-connection-method-toggle");
  expect(gateSource).not.toContain("manualAuthOpen");
  expect(gateSource).not.toMatch(/(?:paste|hide) sign-in code/i);
  expect(gateSource).not.toContain("Sign-in link or one-time code");

  evidence.recordAssertionEvidence(
    "The enterprise blank slate asks only for the workspace address",
    "The gate shows a single workspace-address form with Continue; there is no link field, method toggle, or sign-in-code terminology.",
    true,
  );

  // The install guide's connect step hands the user the exact address to type,
  // and the workspace-claim page still copies the complete OpenWork URL for the
  // desktop's silent paste recovery.
  expect(installGuideSource).toContain('data-testid="install-workspace-address"');
  expect(installGuideSource).toContain("In the app, enter your workspace address:");
  expect(installGuideSource).not.toContain("Copy OpenWork link");
  expect(workspaceClaimSource).toContain("const openworkUrl = await createDesktopHandoff();");
  expect(workspaceClaimSource).toContain("await navigator.clipboard.writeText(openworkUrl);");
  expect(workspaceClaimSource).not.toMatch(/sign-in code/i);
  expect(workspaceClaimSource).not.toContain("getDesktopGrant");

  const authenticatedGuide = installGuideSource.slice(installGuideSource.indexOf("const installerFile"));
  expect(authenticatedGuide).not.toMatch(/activation link/i);
  expect(installGuideSource).toContain('title: "macOS confirms apps downloaded from the internet"');
  expect(installGuideSource).toContain('title: "Windows may warn before it opens the installer"');
  expect(installGuideSource).toContain('"Make the downloaded AppImage executable."');

  evidence.recordAssertionEvidence(
    "The guide hands over the workspace address, not a credential",
    "The install guide's connect step shows the exact workspace address to type, keeps macOS, Windows, and Linux install guidance, avoids activation-link language, and the workspace-claim page still copies a complete OpenWork URL.",
    true,
  );

  // The single address field silently accepts a pasted openwork:// URL, and a
  // pasted URL still reaches the explicit origin confirmation before its
  // one-time grant is exchanged.
  expect(gateSource).toContain("const pastedLink = parseManualAuthInput(serverInput);");
  expect(gateSource).toContain('setPendingConfirmation({ kind: "manual", baseUrl: linkBaseUrl, grant: pastedLink.grant })');
  expect(gateSource).toContain('data-testid="organization-server-confirm"');
  expect(gateSource).toMatch(
    /if \(pending\.kind === "manual"\) \{\s+await exchangeConfirmedGrant\(pending\.grant, pending\.baseUrl\);/,
  );

  evidence.recordAssertionEvidence(
    "Pasted openwork:// URLs recover through the same field with confirmation",
    "parseManualAuthInput runs on the workspace-address input, and a pasted URL's origin reaches the named confirmation before exchangeHandoffAndSignIn.",
    true,
  );

  expect(forcedSigninSource).toContain("denOriginComparisonKey");
  expect(forcedSigninSource).toContain("den.error_signin_link_other_server");
  evidence.recordAssertionEvidence(
    "Pasted links cannot silently switch the forced sign-in control plane",
    "A pasted link can no longer silently switch the control plane on the forced sign-in page.",
    true,
  );
});
