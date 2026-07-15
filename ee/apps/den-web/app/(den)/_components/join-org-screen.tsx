"use client";

import type { AdmissionDecision } from "@openwork/types/den/organization-admission";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
import { DenInput } from "./ui/input";

type JoinedOrg = {
  name: string;
  slug: string;
};

function LoadingCard({ title, body }: { title: string; body: string }) {
  return (
    <section className="den-page py-4 lg:py-6">
      <div className="den-frame grid max-w-[44rem] gap-4 p-6 md:p-7">
        <p className="den-eyebrow">OpenWork Cloud</p>
        <div className="grid gap-2">
          <h1 className="den-title-lg">{title}</h1>
          <p className="den-copy">{body}</p>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--dls-hover)]">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--dls-accent)]" />
        </div>
      </div>
    </section>
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

function parseAdmissionDecision(value: unknown): AdmissionDecision | null {
  if (!isRecord(value) || typeof value.decision !== "string") return null;
  if (["allow", "require_invitation", "require_email_verification", "require_sso", "require_scim_provisioning", "deny"].includes(value.decision)) {
    return value as AdmissionDecision;
  }
  return null;
}

function AdmissionNextStep({ decision, organizationSlug, invitationToken }: { decision: AdmissionDecision; organizationSlug: string; invitationToken?: string }) {
  if (decision.decision === "require_sso") {
    return <div className="grid gap-3"><p className="den-copy">This organization requires its own single sign-on session.</p><button type="button" className="den-button-primary w-full sm:w-auto" onClick={() => {
      const nextUrl = new URL(decision.signInUrl, window.location.origin);
      const callbackUrl = new URL("/join-org", window.location.origin);
      if (invitationToken) callbackUrl.searchParams.set("invite", invitationToken);
      else callbackUrl.searchParams.set("slug", organizationSlug);
      nextUrl.searchParams.set("callbackURL", callbackUrl.toString());
      window.location.assign(nextUrl.toString());
    }}>Continue with organization SSO</button></div>;
  }
  if (decision.decision === "require_email_verification") return <p className="den-copy">Verify your account email, then return here to join.</p>;
  if (decision.decision === "require_invitation") return <p className="den-copy">This organization requires an invitation. Ask an owner or admin to invite your verified email address.</p>;
  if (decision.decision === "require_scim_provisioning") return <p className="den-copy">Membership is managed by your organization. Ask your identity administrator to provision you through SCIM.</p>;
  if (decision.decision === "deny") return <p className="den-copy">Access was denied by this organization&apos;s policy ({decision.reason.replaceAll("_", " ")}).</p>;
  return null;
}

export function JoinOrgScreen({ invitationId, organizationSlug }: { invitationId: string; organizationSlug: string }) {
  const router = useRouter();
  const { user, sessionHydrated, signOut } = useDenFlow();
  const [preview, setPreview] = useState<DenInvitationPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinedOrg, setJoinedOrg] = useState<JoinedOrg | null>(null);
  const [slugDraft, setSlugDraft] = useState(organizationSlug);
  const [admissionDecision, setAdmissionDecision] = useState<AdmissionDecision | null>(null);

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

  useEffect(() => {
    let cancelled = false;

    async function loadPreview() {
      if (!invitationId) {
        setPreview(null);
        setPreviewError(null);
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

  async function handleAcceptInvitation() {
    if (!invitationId) {
      setJoinError("Missing invitation link.");
      return;
    }

    setJoinBusy(true);
    setJoinError(null);
    setAdmissionDecision(null);

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
        const decision = isRecord(payload) ? parseAdmissionDecision(payload.admission) : null;
        if (decision) setAdmissionDecision(decision);
        setJoinError(getErrorMessage(payload, response.status === 404 ? "This invite could not be accepted." : `Could not join the organization (${response.status}).`));
        return;
      }

      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(PENDING_ORG_INVITATION_STORAGE_KEY);
      }

      const organizationSlug = getStringProperty(payload, "organizationSlug")?.trim() || preview?.organization.slug || "";
      setJoinedOrg({
        name: preview?.organization.name ?? "your team",
        slug: organizationSlug,
      });
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : "Could not join the organization.");
    } finally {
      setJoinBusy(false);
    }
  }

  async function handleJoinBySlug(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const slug = slugDraft.trim();
    if (!slug) return;
    setJoinBusy(true);
    setJoinError(null);
    setAdmissionDecision(null);
    try {
      const { response, payload } = await requestJson(`/v1/orgs/${encodeURIComponent(slug)}/admission/join`, {
        method: "POST",
        body: JSON.stringify({}),
      }, 12000);
      const decision = isRecord(payload) ? parseAdmissionDecision(payload.decision) : null;
      if (!response.ok || decision?.decision !== "allow") {
        if (decision) setAdmissionDecision(decision);
        setJoinError(decision ? null : getErrorMessage(payload, `Could not join the organization (${response.status}).`));
        return;
      }
      setJoinedOrg({ name: slug, slug });
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
    return <LoadingCard title="Loading invite." body="Checking the invite details and your account state..." />;
  }

  if (joinedOrg) {
    return (
      <JoinOrgSuccess
        organizationName={joinedOrg.name}
        onContinueInBrowser={() => router.replace(joinedOrg.slug ? getOrgDashboardRoute(joinedOrg.slug) : "/dashboard")}
      />
    );
  }

  if (!invitationId) {
    return (
      <section className="den-page py-4 lg:py-6">
        <div className="den-frame grid max-w-[44rem] gap-6 p-6 md:p-8">
          <div className="grid gap-2"><p className="den-eyebrow">OpenWork Cloud</p><h1 className="den-title-lg">Join an organization.</h1><p className="den-copy">Signing in identifies your global account. Joining is a separate policy decision made by the organization.</p></div>
          {!user ? (
            <AuthPanel eyebrow="Organization access" initialMode="sign-in" signInContent={{ title: "Sign in first.", copy: "Then enter the organization slug you want to join.", submitLabel: "Sign in" }} />
          ) : (
            <form className="grid gap-4" onSubmit={handleJoinBySlug}>
              <label className="grid gap-2"><span className="den-label">Organization slug</span><DenInput value={slugDraft} onChange={(event) => setSlugDraft(event.target.value)} placeholder="your-organization" required /></label>
              <div className="flex flex-wrap gap-3"><button type="submit" className="den-button-primary w-full sm:w-auto" disabled={joinBusy}>{joinBusy ? "Checking access..." : "Check and join"}</button><Link href="/dashboard" className="den-button-secondary w-full sm:w-auto">Back to dashboard</Link></div>
            </form>
          )}
          {admissionDecision ? <AdmissionNextStep decision={admissionDecision} organizationSlug={slugDraft.trim()} /> : null}
          {joinError ? <div className="den-notice is-error">{joinError}</div> : null}
        </div>
      </section>
    );
  }

  if (!preview) {
    return (
      <section className="den-page py-4 lg:py-6">
        <div className="den-frame grid max-w-[44rem] gap-6 p-6 md:p-8">
          <div className="grid gap-2">
            <p className="den-eyebrow">OpenWork Cloud</p>
            <h1 className="den-title-lg">This invite can't be opened.</h1>
            <p className="den-copy">{previewError ?? "This invite could not be loaded."}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/" className="den-button-primary w-full sm:w-auto">
              Back to OpenWork Cloud
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (preview.invitation.status === "pending" && !invitedEmailAllowed) {
    return (
      <section className="den-page py-4 lg:py-6">
        <div className="den-frame grid max-w-[44rem] gap-6 p-6 md:p-8">
          <div className="grid gap-2">
            <p className="den-eyebrow">OpenWork Cloud</p>
            <h1 className="den-title-lg">This invite needs a different email domain.</h1>
            <p className="den-copy">
              {preview.organization.name} now only accepts accounts from {allowedDomainsLabel}. Ask a workspace owner to update the allowlist or send a new invite.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/" className="den-button-primary w-full sm:w-auto">
              Back to OpenWork Cloud
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (preview.invitation.status === "pending" && !user) {
    return (
      <section className="den-page grid gap-6 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)] lg:py-6">
        <div className="den-frame grid gap-6 p-6 md:p-8">
          <div className="grid gap-3">
            <p className="den-eyebrow">OpenWork Cloud</p>
            <div className="grid gap-2">
              <p className="den-copy">You've been invited to</p>
              <h1 className="den-title-xl max-w-[12ch]">{preview.organization.name}</h1>
            </div>
          </div>

          <div className="den-meta-row">
            <span className="den-kicker">Role · {roleLabel}</span>
          </div>

          <div className="den-frame-inset grid gap-3 rounded-[1.5rem] p-5">
            <p className="m-0 text-base font-medium text-[var(--dls-text-primary)]">
              Your team is already set up and waiting.
            </p>
            <p className="den-copy">
              Member access is ready as soon as you join.
              {preview.organization.allowedEmailDomains?.length
                ? ` This workspace only accepts ${allowedDomainsLabel} accounts.`
                : ""}
            </p>
          </div>
        </div>

        <AuthPanel
          eyebrow="Invite"
          prefilledEmail={preview.invitation.email}
          prefillKey={preview.invitation.id}
          initialMode="sign-up"
          lockEmail
          hideSocialAuth
          hideEmailField
          signUpContent={{
            title: `Join ${preview.organization.name}.`,
            copy: "Pick a password and you're in.",
            submitLabel: `Join ${preview.organization.name}`,
          }}
          signInContent={{
            title: `Join ${preview.organization.name}.`,
            copy: `Sign in as ${preview.invitation.email} to accept this invite.`,
            submitLabel: "Sign in to join",
          }}
          verificationContent={{
            title: "Check your inbox.",
            copy: `Enter the six-digit code sent to ${preview.invitation.email}.`,
            submitLabel: "Verify and join",
          }}
        />
      </section>
    );
  }

  const showAcceptAction = preview.invitation.status === "pending" && Boolean(user) && invitedEmailMatches;

  return (
    <section className="den-page py-4 lg:py-6">
      <div className="den-frame grid max-w-[44rem] gap-6 p-6 md:p-8">
        <div className="grid gap-3">
          <p className="den-eyebrow">OpenWork Cloud</p>
          <div className="grid gap-2">
            <p className="den-copy">You've been invited to</p>
            <h1 className="den-title-xl max-w-[12ch]">{preview.organization.name}</h1>
          </div>
        </div>

        <div className="den-meta-row">
          <span className="den-kicker">Role · {roleLabel}</span>
          {user ? <span>{user.email}</span> : null}
        </div>

        {user ? (
          <div className="den-frame-inset grid gap-1 rounded-[1.5rem] px-4 py-3">
            <p className="den-label">Signed in as</p>
            <p className="m-0 text-sm font-medium text-[var(--dls-text-primary)]">{user.email}</p>
          </div>
        ) : null}

        {preview.invitation.status !== "pending" ? (
          <div className="grid gap-4">
            <p className="den-copy">{statusMessage(preview)}</p>
            <div className="flex flex-wrap gap-3">
              <Link
                href={user && invitedEmailMatches ? getOrgDashboardRoute(preview.organization.slug) : "/"}
                className="den-button-primary w-full sm:w-auto"
              >
                {user && invitedEmailMatches ? "Open team" : "Back to OpenWork Cloud"}
              </Link>
            </div>
          </div>
        ) : user && !signedInEmailAllowed ? (
          <div className="grid gap-4">
            <p className="den-copy">
              {preview.organization.name} only accepts accounts from <span className="font-medium text-[var(--dls-text-primary)]">{allowedDomainsLabel}</span>. You are signed in as <span className="font-medium text-[var(--dls-text-primary)]">{user.email}</span>, so this account cannot join.
            </p>
            <p className="text-sm text-gray-500">
              Log out, then create a new account or sign in with an allowed email address.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="den-button-primary w-full sm:w-auto"
                onClick={() => void handleSwitchAccount()}
                disabled={joinBusy}
              >
                Log out
              </button>
            </div>
          </div>
        ) : !invitedEmailMatches ? (
          <div className="grid gap-4">
            <p className="den-copy">
              This invite is for <span className="font-medium text-[var(--dls-text-primary)]">{preview.invitation.email}</span>. Switch accounts to continue.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="den-button-primary w-full sm:w-auto"
                onClick={() => void handleSwitchAccount()}
                disabled={joinBusy}
              >
                Use a different account
              </button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            <p className="den-copy">You're one click away from the team workspace.</p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="den-button-primary w-full sm:w-auto"
                onClick={() => void handleAcceptInvitation()}
                disabled={!showAcceptAction || joinBusy}
              >
                {joinBusy ? "Joining..." : `Join ${preview.organization.name}`}
              </button>
            </div>
          </div>
        )}

        {admissionDecision ? <AdmissionNextStep decision={admissionDecision} organizationSlug={preview.organization.slug} invitationToken={invitationId} /> : null}
        {joinError ? <div className="den-notice is-error">{joinError}</div> : null}
        {previewError ? <div className="den-notice is-error">{previewError}</div> : null}
      </div>
    </section>
  );
}
