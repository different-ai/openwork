"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, LoaderCircle, Plus, X } from "lucide-react";
import { z } from "zod";
import { SetupFrame } from "../../_components/setup-frame";
import {
  getRequestError,
  requestJson,
  WORKSPACE_REAUTH_SECURITY_MESSAGE,
} from "../../_lib/den-flow";
import { getOnboardingToolsRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type InvitationRow = {
  id: number;
  email: string;
  status: "draft" | "sending" | "sent" | "error";
  error: string | null;
};

const emailSchema = z.string().email();
const buttonClass = "inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl px-5 text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-4 disabled:cursor-not-allowed disabled:opacity-40";
const description = "Invite a few teammates to share tools and get work done together. This part is optional — you can always invite people later.";

export function OnboardingTeammatesScreen() {
  const { orgId, orgSlug, orgContext, orgError } = useOrgDashboard();
  const { user } = useDenFlow();
  if (!orgId || !orgContext || orgContext.organization.id !== orgId || !user) {
    return <SetupFrame step="people" title="Bring your people." description={description}>
      <p role={orgError ? "alert" : "status"} className="text-sm text-neutral-500">{orgError ?? "Getting your workspace ready…"}</p>
    </SetupFrame>;
  }
  return <TeammatesForm key={`${orgId}:${user.id}`} orgId={orgId} orgSlug={orgSlug}
    organizationName={orgContext.organization.name} selfEmail={user.email} selfName={user.name}
    canInvite={getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner).canInviteMembers} />;
}

function TeammatesForm({ orgId, orgSlug, organizationName, selfEmail, selfName, canInvite }: {
  orgId: string;
  orgSlug: string | null;
  organizationName: string;
  selfEmail: string;
  selfName: string | null;
  canInvite: boolean;
}) {
  const router = useRouter();
  const { runReauthableAction, refreshOrgData } = useOrgDashboard();
  const [rows, setRows] = useState<InvitationRow[]>([
    { id: 1, email: "", status: "draft", error: null },
    { id: 2, email: "", status: "draft", error: null },
  ]);
  const [sending, setSending] = useState(false);
  const [focusId, setFocusId] = useState<number | null>(null);
  const nextId = useRef(3);
  const sendingRef = useRef(false);
  const alive = useRef(true);
  const inputRefs = useRef(new Map<number, HTMLInputElement>());
  const sentCount = rows.filter((row) => row.status === "sent").length;
  const pendingRows = rows.filter((row) => row.status !== "sent" && row.email.trim());

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (focusId === null) return;
    inputRefs.current.get(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);

  useEffect(() => {
    if (!sending) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const preventLinkNavigation = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a[href]")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", preventLinkNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", preventLinkNavigation, true);
    };
  }, [sending]);

  function updateRow(id: number, patch: Partial<InvitationRow>) {
    if (alive.current) setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  }

  async function sendInvitations() {
    if (sendingRef.current || !canInvite || pendingRows.length === 0) return;
    const normalized = rows.map((row) => ({ ...row, email: row.email.trim().toLowerCase() }));
    const errors = new Map<number, string>();
    for (const row of normalized) {
      if (!row.email || row.status === "sent") continue;
      if (!emailSchema.safeParse(row.email).success) errors.set(row.id, "Enter a valid email address.");
      else if (row.email === selfEmail.trim().toLowerCase()) errors.set(row.id, "You’re already in this workspace.");
      else if (normalized.some((other) => other.id !== row.id && other.email === row.email)) errors.set(row.id, "Use a different email address for each person.");
    }
    if (errors.size) {
      setRows((current) => current.map((row) => errors.has(row.id)
        ? { ...row, status: "error", error: errors.get(row.id) ?? null }
        : row.status === "error" ? { ...row, status: "draft", error: null } : row));
      setFocusId(errors.keys().next().value ?? null);
      return;
    }
    sendingRef.current = true;
    setSending(true);
    try {
      for (const row of normalized.filter((entry) => entry.email && entry.status !== "sent")) {
        if (!alive.current) break;
        updateRow(row.id, { status: "sending", error: null });
        try {
          await runReauthableAction(`onboarding-invite-${row.id}`, async () => {
            if (!alive.current) throw new Error("Your workspace changed. Review the remaining invitations before sending again.");
            // Pin the organization even if a background account refresh changes
            // the ambient scope while a fresh sign-in is being confirmed.
            const { response, payload } = await requestJson("/v1/invitations", {
              method: "POST",
              headers: { [ORG_SCOPE_HEADER]: orgId },
              body: JSON.stringify({ email: row.email, role: "member" }),
            }, 12000);
            if (!response.ok) throw getRequestError(payload, response, "Could not send this invitation. Try again.");
          });
          updateRow(row.id, { email: row.email, status: "sent", error: null });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not send this invitation. Try again.";
          updateRow(row.id, { status: "error", error: message });
          if (message === WORKSPACE_REAUTH_SECURITY_MESSAGE) break;
        }
      }

    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
    }
  }

  function continueSetup() {
    if (sendingRef.current) return;
    router.push(getOnboardingToolsRoute(orgSlug));
    // The admin layout unmounts its children during a full organization refresh.
    // Refresh only after leaving this form, so sent and failed rows survive retries.
    void refreshOrgData();
  }

  const preview = <div className="rounded-[28px] border border-neutral-200 bg-white p-6 sm:p-7">
    <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-neutral-400">Your workspace</p>
    <h2 className="mt-2 text-xl font-semibold tracking-[-0.03em] text-neutral-950">{organizationName}</h2>
    <div className="mt-6 flex items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-sm font-medium text-white" aria-hidden>{(selfName || selfEmail).slice(0, 1).toUpperCase()}</span>
      <div className="min-w-0"><p className="truncate text-sm font-medium text-neutral-900">{selfName || selfEmail}</p><p className="text-xs text-neutral-500">You · Already here</p></div>
    </div>
    {rows.filter((row) => row.email.trim()).map((row) => <div key={row.id} className="mt-4 flex items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-neutral-200 bg-neutral-50 text-sm font-medium text-neutral-500" aria-hidden>{row.email.trim().slice(0, 1).toUpperCase()}</span>
      <div className="min-w-0"><p className="truncate text-sm text-neutral-800">{row.email.trim()}</p><p className="text-xs text-neutral-500">{row.status === "sent" ? "Invited · Member" : "Not sent yet"}</p></div>
    </div>)}
    <div className="mt-7 border-t border-neutral-100 pt-5 text-sm leading-6 text-neutral-500">A shared place for tools, connections, and the way your team works.</div>
  </div>;

  return <SetupFrame step="people" title="Bring your people." description={description} aside={preview}>
    <div data-testid="onboarding-teammates" aria-busy={sending}>
      {canInvite ? <form noValidate onSubmit={(event) => { event.preventDefault(); void sendInvitations(); }}>
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-neutral-900">Who would you like to invite?</h2>
          <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-medium text-neutral-500">Optional</span>
        </div>
        <div className="space-y-3">
          {rows.map((row, index) => <div key={row.id} data-testid={`onboarding-invite-row-${index + 1}`}>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <label htmlFor={`teammate-email-${row.id}`} className="sr-only">Teammate email {index + 1}</label>
                <input id={`teammate-email-${row.id}`} aria-label={`Teammate email ${index + 1}`} type="email" autoComplete="off" autoCapitalize="none" spellCheck={false}
                  placeholder={index === 0 ? "teammate@company.com" : "another@company.com"} value={row.email}
                  ref={(element) => { if (element) inputRefs.current.set(row.id, element); else inputRefs.current.delete(row.id); }}
                  disabled={sending || row.status === "sent"} aria-invalid={row.status === "error"} aria-describedby={row.error ? `teammate-error-${row.id}` : undefined}
                  onChange={(event) => updateRow(row.id, { email: event.target.value, status: "draft", error: null })}
                  className={`min-h-14 w-full rounded-2xl border bg-white px-4 py-3 pr-11 text-sm text-neutral-900 outline-hidden transition focus:border-neutral-900 focus:ring-4 focus:ring-neutral-900/5 disabled:bg-neutral-50 disabled:text-neutral-500 ${row.status === "error" ? "border-red-400" : "border-neutral-200"}`} />
                {row.status === "sending" ? <LoaderCircle aria-hidden className="absolute right-4 top-5 h-4 w-4 animate-spin text-neutral-500 motion-reduce:animate-none" /> : null}
                {row.status === "sent" ? <Check aria-hidden className="absolute right-4 top-5 h-4 w-4 text-neutral-700" /> : null}
              </div>
              {rows.length > 1 && row.status !== "sent" ? <button type="button" disabled={sending} aria-label={`Remove teammate ${index + 1}`} onClick={() => { setRows((current) => current.filter((entry) => entry.id !== row.id)); setFocusId(rows.find((entry) => entry.id !== row.id && entry.status !== "sent")?.id ?? null); }} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-900 disabled:opacity-40"><X className="h-4 w-4" /></button> : <span className="w-10 shrink-0" />}
            </div>
            {row.error ? <p id={`teammate-error-${row.id}`} role="alert" className="mt-2 text-xs leading-5 text-red-700">{row.error}</p> : null}
            {row.status === "sending" || row.status === "sent" ? <p role="status" className="mt-2 text-xs text-neutral-500">{row.status === "sent" ? "Invitation sent" : "Sending invitation…"}</p> : null}
          </div>)}
        </div>
        <button type="button" disabled={sending || rows.length >= 5} onClick={() => { const id = nextId.current++; setRows((current) => [...current, { id, email: "", status: "draft", error: null }]); setFocusId(id); }} className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl text-sm text-neutral-500 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-900 disabled:opacity-40"><Plus className="h-4 w-4" />Add another person</button>
        <p className="mt-5 max-w-md text-xs leading-5 text-neutral-500">Invite up to five people now. Everyone joins as a member. An owner can change roles later.</p>
        {sentCount > 0 ? <p role="status" className="mt-5 text-sm font-medium text-neutral-900">{sentCount} {sentCount === 1 ? "invitation sent." : "invitations sent."}</p> : null}
        <div className="mt-8 flex flex-wrap items-center gap-3">
          {pendingRows.length > 0 || sentCount === 0 ? <button type="submit" disabled={sending || pendingRows.length === 0} className={`${buttonClass} bg-neutral-950 text-white hover:bg-neutral-800`}>{sending ? "Sending invitations…" : "Send invitations"}<ArrowRight className="h-4 w-4" /></button> : null}
          <button type="button" disabled={sending} onClick={continueSetup} className={`${buttonClass} ${sentCount > 0 && pendingRows.length === 0 ? "bg-neutral-950 text-white hover:bg-neutral-800" : sentCount > 0 ? "border border-neutral-200 bg-white text-neutral-900 hover:bg-neutral-50" : "text-neutral-500 hover:text-neutral-900"}`}>{sentCount > 0 ? "Continue" : "Do this later"}</button>
        </div>
      </form> : <div className="space-y-6"><p className="text-sm leading-6 text-neutral-600">An owner or admin can invite teammates. You can continue setting up your own app.</p><button type="button" onClick={continueSetup} className={`${buttonClass} bg-neutral-950 text-white hover:bg-neutral-800`}>Do this later<ArrowRight className="h-4 w-4" /></button></div>}
    </div>
  </SetupFrame>;
}
