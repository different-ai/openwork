"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import {
  PENDING_ORG_INVITATION_STORAGE_KEY,
  formatRoleLabel,
  getJoinOrgRoute,
  getOrgDashboardRoute,
  parseInvitationPreviewPayload,
  type DenInvitationPreview,
} from "../_lib/den-org";
import { useDenFlow } from "../_providers/den-flow-provider";

function LoadingCard({ title, body }: { title: string; body: string }) {
  return (
    <section className="mx-auto grid w-full max-w-[40rem] gap-4 rounded-[32px] border border-gray-100 bg-white p-6 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.22)] md:p-8">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">OpenWork Cloud</p>
      <div className="grid gap-2">
        <h1 className="text-[2rem] font-semibold tracking-[-0.05em] text-gray-900">{title}</h1>
        <p className="text-[14px] leading-relaxed text-gray-500">{body}</p>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-gray-100">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-gray-900/80" />
      </div>
    </section>
  );
}

function statusMessage(preview: DenInvitationPreview | null) {
  switch (preview?.invitation.status) {
    case "accepted":
      return "This invitation has already been accepted.";
    case "canceled":
      return "This invitation has been canceled.";
    case "expired":
      return "This invitation has expired.";
    default:
      return "This invitation is no longer available.";
  }
}

export function JoinOrgScreen({ invitationId }: { invitationId: string }) {
  const router = useRouter();
  const { user, sessionHydrated, signOut } = useDenFlow();
  const [preview, setPreview] = useState<DenInvitationPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const signUpHref = useMemo(() => {
    if (!invitationId) {
      return "/?mode=sign-up";
    }

    return `/?mode=sign-up&invite=${encodeURIComponent(invitationId)}`;
  }, [invitationId]);

  const signInHref = useMemo(() => {
    if (!invitationId) {
      return "/?mode=sign-in";
    }

    return `/?mode=sign-in&invite=${encodeURIComponent(invitationId)}`;
  }, [invitationId]);

  const invitedEmailMatches = preview && user
    ? preview.invitation.email.trim().toLowerCase() === user.email.trim().toLowerCase()
    : false;

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
          setPreviewError(getErrorMessage(payload, response.status === 404 ? "This invitation is no longer available." : `Could not load the invitation (${response.status}).`));
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
          setPreviewError(error instanceof Error ? error.message : "Could not load the invitation.");
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
        setJoinError(getErrorMessage(payload, response.status === 404 ? "This invitation could not be accepted." : `Could not join the organization (${response.status}).`));
        return;
      }

      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(PENDING_ORG_INVITATION_STORAGE_KEY);
      }

      const acceptedPayload = typeof payload === "object" && payload ? payload as { organizationSlug?: unknown } : null;
      const organizationSlug = typeof acceptedPayload?.organizationSlug === "string" ? acceptedPayload.organizationSlug.trim() : "";
      router.replace(organizationSlug ? getOrgDashboardRoute(organizationSlug) : "/dashboard");
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : "Could not join the organization.");
    } finally {
      setJoinBusy(false);
    }
  }

  async function handleSwitchAccount() {
    await signOut();
    router.replace(getJoinOrgRoute(invitationId));
  }

  if (!sessionHydrated || previewBusy) {
    return <LoadingCard title="Loading invitation." body="Checking the invitation details and your account state..." />;
  }

  if (!preview) {
    return (
      <section className="mx-auto grid w-full max-w-[40rem] gap-6 rounded-[32px] border border-gray-100 bg-white p-6 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.22)] md:p-8">
        <div className="grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">OpenWork Cloud</p>
          <h1 className="text-[2rem] font-semibold tracking-[-0.05em] text-gray-900">Invitation unavailable.</h1>
          <p className="text-[14px] leading-relaxed text-gray-500">{previewError ?? "This invitation could not be loaded."}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/" className="inline-flex items-center rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800">
            Back to OpenWork Cloud
          </Link>
        </div>
      </section>
    );
  }

  const showAcceptAction = preview.invitation.status === "pending" && Boolean(user) && invitedEmailMatches;

  return (
    <section className="mx-auto grid w-full max-w-[40rem] gap-6 rounded-[32px] border border-gray-100 bg-white p-6 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.22)] md:p-8">
      <div className="grid gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">OpenWork Cloud</p>
        <div className="grid gap-2">
          <p className="text-[15px] font-medium text-gray-500">You've been invited to</p>
          <h1 className="text-[2.5rem] font-semibold tracking-[-0.06em] text-gray-900">{preview.organization.name}</h1>
        </div>
        <p className="text-[14px] leading-relaxed text-gray-500">Role: {formatRoleLabel(preview.invitation.role)}</p>
      </div>

      {user ? (
        <div className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3 text-[13px] text-gray-700">
          Signed in as <span className="font-medium text-gray-900">{user.email}</span>
        </div>
      ) : null}

      {preview.invitation.status !== "pending" ? (
        <div className="grid gap-4">
          <p className="text-[15px] leading-relaxed text-gray-600">{statusMessage(preview)}</p>
          <div className="flex flex-wrap gap-3">
            <Link
              href={user && invitedEmailMatches ? getOrgDashboardRoute(preview.organization.slug) : "/"}
              className="inline-flex items-center rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800"
            >
              {user && invitedEmailMatches ? "Open organization" : "Back to OpenWork Cloud"}
            </Link>
          </div>
        </div>
      ) : !user ? (
        <div className="grid gap-4">
          <p className="text-[15px] leading-relaxed text-gray-600">Create an account or sign in first, then come back here to confirm the invitation.</p>
          <div className="flex flex-wrap gap-3">
            <Link href={signUpHref} className="inline-flex items-center rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800">
              Create account to continue
            </Link>
            <Link href={signInHref} className="inline-flex items-center rounded-full border border-gray-200 bg-white px-5 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50">
              Sign in instead
            </Link>
          </div>
        </div>
      ) : !invitedEmailMatches ? (
        <div className="grid gap-4">
          <p className="text-[15px] leading-relaxed text-gray-600">
            This invite was sent to <span className="font-medium text-gray-900">{preview.invitation.email}</span>. Sign in with that email to join the organization.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="inline-flex items-center rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void handleSwitchAccount()}
              disabled={joinBusy}
            >
              Use a different account
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4">
          <p className="text-[15px] leading-relaxed text-gray-600">Click to join</p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="inline-flex items-center rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void handleAcceptInvitation()}
              disabled={!showAcceptAction || joinBusy}
            >
              {joinBusy ? "Joining..." : "Join org"}
            </button>
          </div>
        </div>
      )}

      {joinError ? <p className="text-[13px] text-rose-600">{joinError}</p> : null}
      {previewError ? <p className="text-[13px] text-rose-600">{previewError}</p> : null}
    </section>
  );
}
