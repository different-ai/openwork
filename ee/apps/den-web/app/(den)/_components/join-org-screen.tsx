"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import {
  PENDING_ORG_INVITATION_STORAGE_KEY,
  formatRoleLabel,
  getJoinOrgRoute,
  getOrgDashboardRoute,
  isEmailAllowedForOrganization,
  parseInvitationPreviewPayload,
  type DenInvitationPreview,
} from "../_lib/den-org";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";
import { JoinOrgSuccess } from "./join-org-success";
import { JoinActions, JoinAlert, JoinFacts, JoinFrame, JoinHeading, JoinLoadingBar, JoinPrimaryButton, JoinQuietButton, JoinStrong, JoinText, JoinWorkspaceValue } from "./join-frame";
import type { OrganizationBrand } from "./organization-brand-identity";

type JoinedOrg = {
  id: string;
  name: string;
  slug: string;
  brand: OrganizationBrand;
};

type AccountSummary = {
  email: string;
} | null;

type AcceptedAutoResolveFailure = {
  id: string;
  reason: "membership_removed" | "unknown";
};

function InvitationDetails({
  preview,
  account,
  roleLabel,
}: {
  preview: DenInvitationPreview;
  account: AccountSummary;
  roleLabel: string;
}) {
  // The invited email is said once: the account row appears only when it
  // differs, which is the one case where it changes what to do.
  const rows = [
        { label: "Workspace", value: <JoinWorkspaceValue name={preview.organization.name} /> },
        { label: "Invited as", value: preview.invitation.email },
        { label: "Role", value: roleLabel },
        ...(account && account.email.trim().toLowerCase() !== preview.invitation.email.trim().toLowerCase()
          ? [{ label: "Signed in as", value: account.email }]
          : []),
  ];
  return <JoinFacts rows={rows} testId="join-org-invitation-details" />;
}

function InvitationSummary({ preview }: { preview: DenInvitationPreview }) {
  return (
    <span data-testid="join-org-invitation-summary">
      You&apos;ve been invited as <JoinStrong>{preview.invitation.email}</JoinStrong>
    </span>
  );
}

const InvitationHeading = JoinHeading;
const ActionGroup = JoinActions;
const InlineAlert = JoinAlert;

function NotNowButton({ onClick }: { onClick: () => void }) {
  return <JoinQuietButton onClick={onClick}>Not now</JoinQuietButton>;
}

function getCardOrganization(preview: DenInvitationPreview | null) {
  if (!preview) {
    return null;
  }

  return {
    name: preview.organization.name,
    brand: preview.organization.branding,
  };
}

function LoadingState({
  preview = null,
  title = "Loading invite.",
  copy = "Checking the invite details and your account state...",
}: {
  preview?: DenInvitationPreview | null;
  title?: string;
  copy?: string;
}) {
  return (
    <JoinFrame state="loading" organization={getCardOrganization(preview)}>
        <div className="grid gap-5" aria-busy="true">
          <InvitationHeading title={title} copy={copy} />
          <JoinLoadingBar />
        </div>
      </JoinFrame>
  );
}

function statusMessage(preview: DenInvitationPreview | null) {
  switch (preview?.invitation.status) {
    case "accepted":
      return "This invite has already been used.";
    case "canceled":
      return "This invite was canceled.";
    case "expired":
      return "This invite expired.";
    default:
      return "This invite is no longer available.";
  }
}

function formatAllowedDomains(allowedEmailDomains: readonly string[] | null | undefined) {
  if (!allowedEmailDomains || allowedEmailDomains.length === 0) {
    return "any invited email address";
  }

  return allowedEmailDomains.length === 1
    ? allowedEmailDomains[0]
    : allowedEmailDomains.join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringProperty(value: unknown, key: string) {
  if (!isRecord(value)) {
    return null;
  }

  const property = value[key];
  return typeof property === "string" ? property : null;
}

function getJoinedOrgFromPayload(payload: unknown, preview: DenInvitationPreview): JoinedOrg {
  const organizationSlug = getStringProperty(payload, "organizationSlug")?.trim() || preview.organization.slug;
  const organizationId = getStringProperty(payload, "organizationId")?.trim() || preview.organization.id;

  return {
    id: organizationId,
    name: preview.organization.name,
    slug: organizationSlug,
    brand: preview.organization.branding,
  };
}

function InviteAuthPanel({
  preview,
  initialMode,
}: {
  preview: DenInvitationPreview;
  initialMode: "sign-in" | "sign-up";
}) {
  return (
    <div data-testid="join-org-auth">
      <AuthPanel
        bare
        hideIntro
        prefilledEmail={preview.invitation.email}
        prefillKey={preview.invitation.id}
        initialMode={initialMode}
        lockEmail
        hideEmailField
        hideLockedEmailSummary
        hideSocialAuth
        emailFirstFlow
        emailFirstInvitationId={preview.invitation.id}
        resolveEmailFirstOnPrefill
        signUpContent={{
          submitLabel: "Create account",
        }}
        signInContent={{
          title: "Sign in to continue.",
          copy: initialMode === "sign-in"
            ? `Sign in as ${preview.invitation.email} to open your workspace.`
            : "Use the invited account to accept this invite.",
          submitLabel: initialMode === "sign-in" ? "Sign in to open workspace" : "Sign in to join",
        }}
        verificationContent={{
          title: "Check your inbox.",
          copy: `Enter the six-digit code sent to ${preview.invitation.email}.`,
          submitLabel: "Verify and join",
        }}
      />
    </div>
  );
}


export function JoinOrgScreen({ invitationId }: { invitationId: string }) {
  const router = useRouter();
  const { user, sessionHydrated, signOut, revalidateSession, desktopAuthRequested, desktopAuthScheme } = useDenFlow();
  const [preview, setPreview] = useState<DenInvitationPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [joinedOrg, setJoinedOrg] = useState<JoinedOrg | null>(null);
  const [acceptedAutoResolveFailure, setAcceptedAutoResolveFailure] = useState<AcceptedAutoResolveFailure | null>(null);
  const acceptedInvitationResolutionRef = useRef<string | null>(null);

  const invitedEmailMatches = preview && user
    ? preview.invitation.email.trim().toLowerCase() === user.email.trim().toLowerCase()
    : false;
  const invitedEmailAllowed = preview
    ? isEmailAllowedForOrganization(preview.organization.allowedEmailDomains, preview.invitation.email)
    : true;
  const signedInEmailAllowed = preview && user
    ? isEmailAllowedForOrganization(preview.organization.allowedEmailDomains, user.email)
    : true;
  const roleLabel = preview ? formatRoleLabel(preview.invitation.role) : "";
  const allowedDomainsLabel = preview ? formatAllowedDomains(preview.organization.allowedEmailDomains) : "";

  const clearPendingInvitation = useCallback(() => {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(PENDING_ORG_INVITATION_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadPreview() {
      if (!invitationId) {
        setPreview(null);
        setPreviewError("Missing invitation link.");
        setPreviewBusy(false);
        return;
      }

      setPreviewBusy(true);
      setPreviewError(null);

      try {
        const { response, payload } = await requestJson(
          `/v1/orgs/invitations/preview?id=${encodeURIComponent(invitationId)}`,
          { method: "GET" },
          12000,
        );

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          if (typeof window !== "undefined" && response.status === 404) {
            window.sessionStorage.removeItem(PENDING_ORG_INVITATION_STORAGE_KEY);
          }

          setPreview(null);
          setPreviewError(getErrorMessage(payload, response.status === 404 ? "This invite is no longer available." : `Could not load the invite (${response.status}).`));
          return;
        }

        const nextPreview = parseInvitationPreviewPayload(payload);
        if (!nextPreview) {
          setPreview(null);
          setPreviewError("The invitation details were incomplete.");
          return;
        }

        setPreview(nextPreview);
      } catch (error) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(error instanceof Error ? error.message : "Could not load the invite.");
        }
      } finally {
        if (!cancelled) {
          setPreviewBusy(false);
        }
      }
    }

    void loadPreview();

    return () => {
      cancelled = true;
    };
  }, [invitationId]);

  useEffect(() => {
    if (
      !invitationId ||
      !sessionHydrated ||
      !preview ||
      preview.invitation.status !== "accepted" ||
      !user ||
      !invitedEmailMatches
    ) {
      return;
    }

    const acceptedPreview = preview;
    const acceptedInvitationId = acceptedPreview.invitation.id;

    if (acceptedInvitationResolutionRef.current === acceptedInvitationId) {
      return;
    }

    acceptedInvitationResolutionRef.current = acceptedInvitationId;

    // The ref above guarantees a single in-flight resolution per invitation,
    // so every outcome below is applied unconditionally. Sign-in rehydration
    // churns the user identity mid-flight; a cancellation guard here dropped
    // the outcome and stranded users on the loading card in two real eval
    // regressions (first the success redirect, then the 410 failure card).
    async function resolveAcceptedInvitation() {
      setAcceptedAutoResolveFailure(null);

      try {
        const { response, payload } = await requestJson(
          "/v1/orgs/invitations/accept",
          {
            method: "POST",
            body: JSON.stringify({ id: invitationId }),
          },
          12000,
        );

        if (!response.ok) {
          setAcceptedAutoResolveFailure({
            id: acceptedInvitationId,
            reason: getStringProperty(payload, "error") === "membership_removed" ? "membership_removed" : "unknown",
          });
          return;
        }

        clearPendingInvitation();
        const nextJoinedOrg = getJoinedOrgFromPayload(payload, acceptedPreview);

        if (desktopAuthRequested) {
          setJoinedOrg(nextJoinedOrg);
          return;
        }

        router.replace("/install");
      } catch {
        // Transient transport failure: allow a later effect run to retry.
        acceptedInvitationResolutionRef.current = null;
        setAcceptedAutoResolveFailure({ id: acceptedInvitationId, reason: "unknown" });
      }
    }

    void resolveAcceptedInvitation();
  }, [clearPendingInvitation, desktopAuthRequested, invitationId, invitedEmailMatches, preview, router, sessionHydrated, user]);

  function handleNotNow() {
    clearPendingInvitation();
    router.replace("/");
  }

  async function handleAcceptInvitation() {
    if (!invitationId) {
      setJoinError("Missing invitation link.");
      return;
    }
    if (!preview) {
      setJoinError("The invitation details are still loading.");
      return;
    }

    setJoinBusy(true);
    setJoinError(null);

    try {
      const { response, payload } = await requestJson(
        "/v1/orgs/invitations/accept",
        {
          method: "POST",
          body: JSON.stringify({ id: invitationId }),
        },
        12000,
      );

      if (response.status === 401) {
        // No live session: it expired, was revoked, or was never created.
        // Ask Den; a dead session drops the page back to the invite sign-in
        // form instead of showing the raw "unauthorized" code (ENG-550).
        if (!(await revalidateSession())) {
          setSessionEnded(true);
          return;
        }
        setJoinError("Could not join the organization. Try again.");
        return;
      }

      if (!response.ok) {
        setJoinError(getErrorMessage(payload, response.status === 404 ? "This invite could not be accepted." : `Could not join the organization (${response.status}).`));
        return;
      }

      clearPendingInvitation();
      const nextJoinedOrg = getJoinedOrgFromPayload(payload, preview);
      if (desktopAuthRequested) {
        setJoinedOrg(nextJoinedOrg);
      } else {
        router.replace("/install");
      }
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : "Could not join the organization.");
    } finally {
      setJoinBusy(false);
    }
  }

  async function handleSwitchAccount() {
    await signOut();
    if (typeof window !== "undefined" && invitationId) {
      window.sessionStorage.setItem(PENDING_ORG_INVITATION_STORAGE_KEY, invitationId);
    }
    router.replace(getJoinOrgRoute(invitationId));
  }

  if (!sessionHydrated || previewBusy) {
    return <LoadingState />;
  }

  if (joinedOrg) {
    return (
      <JoinOrgSuccess
        organizationName={joinedOrg.name}
        brand={joinedOrg.brand}
        desktopAuthRequested={desktopAuthRequested}
        desktopAuthScheme={desktopAuthScheme}
        onContinueInBrowser={() => router.replace(joinedOrg.slug ? getOrgDashboardRoute(joinedOrg.slug) : "/dashboard")}
      />
    );
  }

  if (!preview) {
    return (
      <JoinFrame state="invalid" organization={getCardOrganization(preview)}>
          <InvitationHeading title="This invite can't be opened." copy={previewError ?? "This invite could not be loaded."} />
          <ActionGroup>
            <JoinPrimaryButton onClick={handleNotNow}>
Back to OpenWork Cloud
</JoinPrimaryButton>
          </ActionGroup>
        </JoinFrame>
    );
  }

  const account = user ? { email: user.email } : null;
  const showAcceptAction = preview.invitation.status === "pending" && Boolean(user) && invitedEmailMatches;
  const acceptedAutoResolveFailureForPreview = acceptedAutoResolveFailure?.id === preview.invitation.id
    ? acceptedAutoResolveFailure
    : null;
  const acceptedAutoResolveFailed = Boolean(acceptedAutoResolveFailureForPreview);

  if (preview.invitation.status === "accepted" && user && invitedEmailMatches && !acceptedAutoResolveFailed) {
    return (
      <LoadingState
        preview={preview}
        title="Opening your workspace."
        copy={`Confirming your membership in ${preview.organization.name}...`}
      />
    );
  }

  if (preview.invitation.status === "accepted" && user && invitedEmailMatches && acceptedAutoResolveFailureForPreview?.reason === "membership_removed") {
    return (
      <JoinFrame state="membership-removed" organization={getCardOrganization(preview)}>
          <InvitationHeading
            title="Your access was removed."
            copy={`Your access to ${preview.organization.name} was removed. Ask a workspace admin for a new invite.`}
          />
          <ActionGroup>
            <JoinPrimaryButton onClick={handleNotNow}>
Back to OpenWork Cloud
</JoinPrimaryButton>
          </ActionGroup>
        </JoinFrame>
    );
  }

  if (preview.invitation.status === "accepted" && !user) {
    return (
      <JoinFrame state="accepted-signed-out" organization={getCardOrganization(preview)}>
          <div className="grid gap-4">
            <InvitationHeading
              title={`You've already joined ${preview.organization.name}.`}
              copy={`This invite was already accepted. Sign in as ${preview.invitation.email} to open your workspace.`}
            />
            <InvitationDetails preview={preview} account={account} roleLabel={roleLabel} />
          </div>

          <InviteAuthPanel preview={preview} initialMode="sign-in" />

          <ActionGroup>
            <NotNowButton onClick={handleNotNow} />
          </ActionGroup>
        </JoinFrame>
    );
  }

  if (preview.invitation.status === "accepted" && user && !invitedEmailMatches) {
    return (
      <JoinFrame state="accepted-wrong-account" organization={getCardOrganization(preview)}>
          <InvitationHeading
            title="Use the invited account."
            copy={`This invite belongs to ${preview.invitation.email}. You are signed in as ${user.email}, so switch accounts to open this workspace.`}
          />
          <InvitationDetails preview={preview} account={account} roleLabel={roleLabel} />
          <ActionGroup>
            <JoinPrimaryButton onClick={() => void handleSwitchAccount()} disabled={joinBusy}>
Use a different account
</JoinPrimaryButton>
            <NotNowButton onClick={handleNotNow} />
          </ActionGroup>
        </JoinFrame>
    );
  }

  if (preview.invitation.status !== "pending") {
    return (
      <JoinFrame state="unavailable" organization={getCardOrganization(preview)}>
          <InvitationHeading title="This invite can't be used." copy={statusMessage(preview)} />
          <InvitationDetails preview={preview} account={account} roleLabel={roleLabel} />
          <ActionGroup>
            <JoinPrimaryButton onClick={handleNotNow}>
Back to OpenWork Cloud
</JoinPrimaryButton>
          </ActionGroup>
        </JoinFrame>
    );
  }

  if (!invitedEmailAllowed) {
    return (
      <JoinFrame state="domain-blocked" organization={getCardOrganization(preview)}>
          <InvitationHeading
            title="This invite needs a different email domain."
            copy={`${preview.organization.name} now only accepts accounts from ${allowedDomainsLabel}. Ask a workspace owner to update the allowlist or send a new invite.`}
          />
          <InvitationDetails preview={preview} account={account} roleLabel={roleLabel} />
          <ActionGroup>
            <JoinPrimaryButton onClick={handleNotNow}>
Back to OpenWork Cloud
</JoinPrimaryButton>
          </ActionGroup>
        </JoinFrame>
    );
  }

  if (!user) {
    return (
      <JoinFrame state="signed-out" organization={getCardOrganization(preview)}>
          <div className="grid gap-4">
            <InvitationHeading
              title={`Join ${preview.organization.name}`}
              copy={<InvitationSummary preview={preview} />}
            />
            {preview.organization.allowedEmailDomains?.length ? (
              <JoinText>
                This workspace only accepts {allowedDomainsLabel} accounts.
              </JoinText>
            ) : null}
          </div>

          {sessionEnded ? <InlineAlert>Your session ended. Sign in again to join.</InlineAlert> : null}

          <InviteAuthPanel preview={preview} initialMode="sign-up" />

          <ActionGroup>
            <NotNowButton onClick={handleNotNow} />
          </ActionGroup>
        </JoinFrame>
    );
  }

  return (
    <JoinFrame state="signed-in" organization={getCardOrganization(preview)}>
        <InvitationHeading title={`Join ${preview.organization.name}.`} copy="Review the invitation and continue with the right account." />
        <InvitationDetails preview={preview} account={account} roleLabel={roleLabel} />

        {user && !signedInEmailAllowed ? (
          <div className="grid gap-4">
            <JoinText>
              {preview.organization.name} only accepts accounts from <JoinStrong>{allowedDomainsLabel}</JoinStrong>. You are signed in as <JoinStrong>{user.email}</JoinStrong>, so this account cannot join.
            </JoinText>
            <JoinText muted>
              Log out, then create a new account or sign in with an allowed email address.
            </JoinText>
            <ActionGroup>
              <JoinPrimaryButton onClick={() => void handleSwitchAccount()} disabled={joinBusy}>
Log out
</JoinPrimaryButton>
              <NotNowButton onClick={handleNotNow} />
            </ActionGroup>
          </div>
        ) : !invitedEmailMatches ? (
          <div className="grid gap-4">
            <JoinText>
              This invite is for <JoinStrong>{preview.invitation.email}</JoinStrong>. Switch accounts to continue.
            </JoinText>
            <ActionGroup>
              <JoinPrimaryButton onClick={() => void handleSwitchAccount()} disabled={joinBusy}>
Use a different account
</JoinPrimaryButton>
              <NotNowButton onClick={handleNotNow} />
            </ActionGroup>
          </div>
        ) : (
          <div className="grid gap-4">
            <JoinText>You're one click away from the team workspace.</JoinText>
            <ActionGroup>
              <JoinPrimaryButton onClick={() => void handleAcceptInvitation()} disabled={!showAcceptAction} loading={joinBusy}>
                {joinBusy ? "Joining..." : `Join ${preview.organization.name}`}
</JoinPrimaryButton>
              <NotNowButton onClick={handleNotNow} />
            </ActionGroup>
          </div>
        )}

        {joinError ? <InlineAlert>{joinError}</InlineAlert> : null}
        {previewError ? <InlineAlert>{previewError}</InlineAlert> : null}
      </JoinFrame>
  );
}
