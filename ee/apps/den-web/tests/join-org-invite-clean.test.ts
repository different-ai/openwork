import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const joinOrgScreenPath = fileURLToPath(
  new URL("../app/(den)/_components/join-org-screen.tsx", import.meta.url),
);

function readJoinOrgScreenSource() {
  return readFileSync(joinOrgScreenPath, "utf8");
}

describe("join organization invite clean layout contract", () => {
  test("uses one light Dithering layer and no mesh gradient", () => {
    const source = readJoinOrgScreenSource();
    const ditheringImports = source.match(/import \{ Dithering \} from "@paper-design\/shaders-react"/g) ?? [];
    const ditheringUses = source.match(/<Dithering\b/g) ?? [];

    expect(ditheringImports).toHaveLength(1);
    expect(ditheringUses).toHaveLength(1);
    expect(source).not.toContain("PaperMeshGradient");
    expect(source).toContain("colorBack=\"#F8FBFF\"");
    expect(source).toContain("colorFront=\"#8FB7E8\"");
    expect(source).toContain('style={{ backgroundColor: "#F8FBFF", width: "100%", height: "100%" }}');
  });

  test("keeps the decorative background separate, restrained, and reduced-motion aware", () => {
    const source = readJoinOrgScreenSource();

    expect(source).toContain("min-h-dvh overflow-y-auto bg-[#f8fbff]");
    expect(source).toContain("pointer-events-none fixed inset-0 z-0 overflow-hidden bg-[#f8fbff] opacity-[0.09]");
    expect(source).toContain('aria-hidden="true"');
    expect(source).toContain('data-testid="join-org-background"');
    expect(source).toContain('data-testid="join-org-foreground"');
    expect(source).toContain("relative z-10");
    expect(source).toContain("useSyncExternalStore");
    expect(source).toContain('const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";');
    expect(source).toContain("function getReducedMotionServerSnapshot()");
    expect(source).toContain("const shaderSpeed = reducedMotion ? 0 : 0.012;");
    expect(source).toContain("speed={shaderSpeed}");
    expect(source).toContain('data-shader-speed={shaderSpeed}');
  });

  test("removes stacked frames while keeping a compact centered hierarchy", () => {
    const source = readJoinOrgScreenSource();

    expect(source).not.toContain("den-frame");
    expect(source).not.toContain("den-frame-inset");
    expect(source).toContain("w-full max-w-md");
    expect(source).toContain('data-testid="join-org-root"');
    expect(source).toContain('data-testid="join-org-invitation-details"');
    expect(source).toContain('data-testid="join-org-actions"');
    expect(source).toContain('data-testid="join-org-auth"');
    expect(source).toContain("Organization");
    expect(source).toContain("Invited email");
    expect(source).toContain("Role");
    expect(source).toContain("Account");
    expect(source).not.toMatch(/\binviter\b/i);
  });

  test("uses bare invite auth and a non-destructive Not now dismissal", () => {
    const source = readJoinOrgScreenSource();

    expect(source).toMatch(/<AuthPanel[\s\S]*?\bbare\b/);
    expect(source).toMatch(/<AuthPanel[\s\S]*?\blockEmail\b/);
    expect(source).toMatch(/<AuthPanel[\s\S]*?\bhideEmailField\b/);
    expect(source).toMatch(/<AuthPanel[\s\S]*?\bhideLockedEmailSummary\b/);
    expect(source).toContain('title: "Create your account."');
    expect(source).toContain('title: "Sign in to continue."');
    expect(source).not.toContain("title: `Join ${preview.organization.name}.`");
    expect(source).toContain("Not now");
    expect(source).toContain("function handleNotNow()");
    expect(source).toContain("window.sessionStorage.removeItem(PENDING_ORG_INVITATION_STORAGE_KEY);");
    expect(source).toContain('router.replace("/");');
    expect(source).not.toContain("Decline invitation");
    expect(source).not.toContain("Cancel invitation");
  });

  test("preserves invitation preview, account switching, status, and accept behavior", () => {
    const source = readJoinOrgScreenSource();

    expect(source).toContain("/v1/orgs/invitations/preview?id=");
    expect(source).toContain("/v1/orgs/invitations/accept");
    expect(source).toContain("parseInvitationPreviewPayload(payload)");
    expect(source).toContain("isEmailAllowedForOrganization");
    expect(source).toContain("statusMessage(preview)");
    expect(source).toContain("handleSwitchAccount");
    expect(source).toContain("window.sessionStorage.setItem(PENDING_ORG_INVITATION_STORAGE_KEY, invitationId);");
    expect(source).toContain("This invite needs a different email domain.");
    expect(source).toContain("This invite is for");
    expect(source).toContain("Use a different account");
    expect(source).toContain("Log out");
    expect(source).toContain("Join ${preview.organization.name}");
  });
});
