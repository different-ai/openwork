"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Copy, Lock, Plus, X } from "lucide-react";
import {
  SANDBOX_MAX_DAYS,
  SANDBOX_MAX_MEMBERS,
  sandboxCreatedSchema,
  sandboxJoinRoleSchema,
  sandboxListSchema,
  type Sandbox,
  type SandboxJoinRole,
  type SandboxCreateInput,
  type SandboxList,
} from "@openwork/types/den/sandbox-organizations";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenInput } from "../../../app/(den)/_components/ui/input";
import { DenSelect } from "../../../app/(den)/_components/ui/select";
import { AdminAccessScreen } from "../admin-access-screen";
import { requestAdmin, sendAdmin, type AdminAccess } from "../admin-request";

const base = "/v1/admin/sandbox-orgs";
const parseList = (value: unknown) => { const result = sandboxListSchema.safeParse(value); return result.success ? result.data : null; };
const date = (value: string) => new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
const stateLabel = { open: "Open", expired: "Ended", closed: "Closed" } as const;

type Draft = { name: string; connectorBaseUrl: string; days: string; memberLimit: string; domains: string; joinRole: SandboxJoinRole };
const freshDraft = (workplaceUrl: string | null | undefined): Draft => ({ name: "", connectorBaseUrl: workplaceUrl ?? "", days: "14", memberLimit: "50", domains: "", joinRole: "admin" });
const roleLabel: Record<SandboxJoinRole, string> = { member: "Members", admin: "Admins" };

export function SandboxOrgsPage() {
  const [data, setData] = useState<SandboxList | null>(null);
  const [access, setAccess] = useState<{ access: Exclude<AdminAccess, "ready">; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await requestAdmin(base, parseList, signal);
      if (signal?.aborted) return;
      if (result.access === "ready") { setData(result.data); setError(null); setAccess(null); }
      else if (result.access === "signed-out" || result.access === "forbidden") setAccess({ access: result.access, message: result.message });
      else setError(result.message);
    } catch (failure: unknown) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "Could not load sandboxes.");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);

  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function mutate(path: string, body: unknown, success: string) {
    if (savingRef.current) return false;
    savingRef.current = true; setSaving(true); setError(null); setNotice("");
    try {
      const result = await sendAdmin(path, "POST", body);
      if (!result.ok) {
        if (result.status === 401 || result.status === 403) { setAccess({ access: result.status === 401 ? "signed-out" : "forbidden", message: result.message }); return false; }
        setError(result.message);
        return false;
      }
      if (!sandboxCreatedSchema.safeParse(result.payload).success) { setError("Saved, but the response was unexpected. Refresh to check."); return false; }
      setNotice(success);
      await load();
      return true;
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : "Could not confirm the change. Refresh to check.");
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const body: SandboxCreateInput = {
      name: draft.name.trim(),
      connectorBaseUrl: draft.connectorBaseUrl.trim() || null,
      days: Number(draft.days),
      memberLimit: Number(draft.memberLimit),
      allowedEmailDomains: draft.domains.split(/[\s,]+/).map(value => value.trim().toLowerCase()).filter(Boolean),
      joinRole: draft.joinRole,
    };
    if (await mutate(base, body, `Created ${body.name}. Copy its join link below.`)) setDraft(null);
  }

  if (access) return <AdminAccessScreen state={access.access} message={access.message} onRetry={() => void load()} />;

  if (!data) return <section aria-busy={loading} aria-label="Sandbox organizations">
    {error ? <div role="alert" className="grid gap-3"><p className="text-sm text-[color:var(--ow-danger)]">{error}</p><DenButton variant="secondary" size="sm" className="justify-self-start" onClick={() => void load()}>Retry</DenButton></div>
      : <div className="grid gap-3"><div className="h-10 rounded-md bg-[var(--dls-hover)]" /><div className="h-32 rounded-md bg-[var(--dls-hover)]" /></div>}
  </section>;

  if (!data.enabled) return <section className="py-5" data-testid="admin-sandbox-orgs-off">
    <h1 className="flex items-center gap-2 text-base font-medium text-[color:var(--dls-text-primary)]"><Lock size={16} aria-hidden="true" />Sandbox organizations are off</h1>
    <p className="mt-2 text-sm text-[color:var(--dls-text-secondary)]">Turn on Sandbox organizations for everyone in Feature rollouts to create try-it-out organizations here.</p>
    <Link href="/admin/features" prefetch={false} className="mt-3 inline-block text-sm text-[color:var(--dls-text-secondary)] underline underline-offset-2">Open Feature rollouts</Link>
  </section>;

  const busy = saving || loading;
  return <section className="min-w-0 text-[color:var(--dls-text-primary)]" data-testid="admin-sandbox-orgs" aria-busy={busy}>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-base font-medium">Sandbox organizations</h1>
      <DenButton size="sm" icon={Plus} disabled={busy || draft !== null} onClick={() => { setDraft(freshDraft(data.defaults?.workplaceUrl)); setError(null); setNotice(""); }} data-testid="admin-sandbox-new">New sandbox</DenButton>
    </div>
    <p className="mb-5 max-w-2xl text-sm text-[color:var(--dls-text-secondary)]">Try-it-out organizations on this deployment. People join with the link as members, use included models, and connect their own copy of the sample work apps. Separate from Daytona demos.</p>
    {error ? <p role="alert" className="mb-4 text-sm text-[color:var(--ow-danger)]">{error}</p> : null}
    <p role="status" aria-live="polite" data-testid="admin-sandbox-status" className="mb-4 text-sm text-[color:var(--dls-text-secondary)] empty:hidden">{notice}</p>

    <div className={draft ? "grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]" : "min-w-0"}>
      <div className="min-w-0">
        {data.sandboxes.length === 0 ? <p className="border-t border-[var(--dls-border)] py-6 text-sm text-[color:var(--dls-text-secondary)]">No sandboxes yet. Create one to get a join link.</p>
          : data.sandboxes.map(sandbox => <SandboxRow key={sandbox.id} sandbox={sandbox} busy={busy}
            onRotate={() => void mutate(`${base}/${encodeURIComponent(sandbox.id)}/rotate-link`, undefined, "New link ready. The old link no longer works.")}
            onJoinRole={(joinRole) => void mutate(`${base}/${encodeURIComponent(sandbox.id)}/join-role`, { joinRole }, `People who join ${sandbox.name} now become ${joinRole === "admin" ? "admins" : "members"}. People who already joined keep their role.`)}
            onExtend={() => void mutate(`${base}/${encodeURIComponent(sandbox.id)}/extend`, { days: 7 }, `${sandbox.name} is open for 7 more days.`)}
            onClose={() => void mutate(`${base}/${encodeURIComponent(sandbox.id)}/close`, undefined, `${sandbox.name} is closed. Members and data are kept.`)} />)}
      </div>

      {draft ? <section className="min-w-0 border-t border-[var(--dls-border)] pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0" aria-labelledby="admin-sandbox-create-title">
        <div className="mb-4 flex items-center justify-between gap-2"><h2 id="admin-sandbox-create-title" className="text-sm font-medium">New sandbox</h2><DenButton variant="ghost" size="sm" aria-label="Close new sandbox" disabled={saving} onClick={() => setDraft(null)}><X size={16} aria-hidden="true" /></DenButton></div>
        <form onSubmit={create} className="grid gap-4" data-testid="admin-sandbox-form">
          <label className="grid gap-2 text-xs">Name<DenInput aria-label="Sandbox name" required minLength={2} maxLength={120} placeholder="OpenWork Sandbox" value={draft.name} disabled={saving} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label className="grid gap-2 text-xs">Sample work apps address<DenInput aria-label="Sample work apps address" type="url" placeholder="https://workplace.example.com" value={draft.connectorBaseUrl} disabled={saving} onChange={event => setDraft({ ...draft, connectorBaseUrl: event.target.value })} />
            <span className="text-[color:var(--dls-text-secondary)]">Adds Outlook, Calendar, Drive, Jira and Confluence. Each person signs in to their own copy. Leave empty for no connectors.</span></label>
          <div className="grid gap-1 text-xs" data-testid="admin-sandbox-models">
            <span>Models</span>
            <span className="text-[color:var(--dls-text-secondary)]">{data.defaults?.gatewayModels.length
              ? `Included models, plus ${data.defaults.gatewayModels.join(", ")} through AI Gateway (${data.defaults.gatewayProviderId ?? "provider"}) for everyone.`
              : "Included models only. Add DEN_SANDBOX_GATEWAY_API_KEY on this deployment to give every sandbox an AI Gateway provider."}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-2 text-xs">Open for (days)<DenInput aria-label="Days open" type="number" required min={1} max={SANDBOX_MAX_DAYS} step={1} value={draft.days} disabled={saving} onChange={event => setDraft({ ...draft, days: event.target.value })} /></label>
            <label className="grid gap-2 text-xs">Seats<DenInput aria-label="Seats" type="number" required min={1} max={SANDBOX_MAX_MEMBERS} step={1} value={draft.memberLimit} disabled={saving} onChange={event => setDraft({ ...draft, memberLimit: event.target.value })} /></label>
          </div>
          <label className="grid gap-2 text-xs">People who join become<DenSelect aria-label="People who join become" value={draft.joinRole} disabled={saving} onChange={event => { const parsed = sandboxJoinRoleSchema.safeParse(event.target.value); if (parsed.success) setDraft({ ...draft, joinRole: parsed.data }); }}><option value="admin">Admins</option><option value="member">Members</option></DenSelect>
            <span className="text-[color:var(--dls-text-secondary)]">Admins can try everything: connectors, members and settings.</span></label>
          <label className="grid gap-2 text-xs">Who can join<DenInput aria-label="Allowed email domains" placeholder="Anyone with the link" value={draft.domains} disabled={saving} onChange={event => setDraft({ ...draft, domains: event.target.value })} />
            <span className="text-[color:var(--dls-text-secondary)]">Optional. Email domains separated by commas, such as example.com.</span></label>
          <div className="grid gap-1 rounded-md bg-[var(--dls-hover)] p-3 text-xs"><span className="font-medium">You become the owner.</span><span className="text-[color:var(--dls-text-secondary)]">People who join become {draft.joinRole === "admin" ? "admins" : "members"}, never owners. When the sandbox ends, the link and Free Auto stop; members and data stay.</span></div>
          <div className="flex flex-wrap justify-end gap-2"><DenButton type="button" variant="secondary" size="sm" disabled={saving} onClick={() => setDraft(null)}>Cancel</DenButton><DenButton type="submit" size="sm" disabled={busy} loading={saving} data-testid="admin-sandbox-create-submit">Create sandbox</DenButton></div>
        </form>
      </section> : null}
    </div>
  </section>;
}

function SandboxRow({ sandbox, busy, onRotate, onExtend, onClose, onJoinRole }: { sandbox: Sandbox; busy: boolean; onRotate: () => void; onExtend: () => void; onClose: () => void; onJoinRole: (joinRole: SandboxJoinRole) => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(sandbox.joinLink);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }
  return <article className="grid min-w-0 gap-3 border-t border-[var(--dls-border)] py-4" data-testid={`admin-sandbox-${sandbox.id}`}>
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <Link href={`/admin/organizations/${encodeURIComponent(sandbox.organizationId)}`} prefetch={false} className="text-sm font-medium hover:underline">{sandbox.name}</Link>
        <p className="mt-1 text-xs text-[color:var(--dls-text-secondary)]">
          <span data-testid="admin-sandbox-state">{stateLabel[sandbox.state]}</span>
          {" · "}{sandbox.state === "open" ? `Ends ${date(sandbox.expiresAt)}` : sandbox.closedAt ? `Closed ${date(sandbox.closedAt)}` : `Ended ${date(sandbox.expiresAt)}`}
          {" · "}<span className="tabular-nums">{sandbox.memberCount} / {sandbox.memberLimit} seats</span>
          {" · "}{sandbox.connectorCount ? `${sandbox.connectorCount} sample apps` : "No connectors"}
          {sandbox.modelProviderCount ? ` · ${sandbox.modelProviderCount} AI Gateway provider${sandbox.modelProviderCount === 1 ? "" : "s"}` : ""}
          {" · "}<span data-testid="admin-sandbox-join-role">Joins as {roleLabel[sandbox.joinRole].toLowerCase()}</span>
          {sandbox.allowedEmailDomains.length ? ` · ${sandbox.allowedEmailDomains.join(", ")} only` : ""}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <DenSelect aria-label={`${sandbox.name}: people who join become`} value={sandbox.joinRole} disabled={busy} onChange={event => { const parsed = sandboxJoinRoleSchema.safeParse(event.target.value); if (parsed.success && parsed.data !== sandbox.joinRole) onJoinRole(parsed.data); }}><option value="member">Join as members</option><option value="admin">Join as admins</option></DenSelect>
        <DenButton variant="secondary" size="sm" disabled={busy} onClick={onExtend}>{sandbox.state === "open" ? "Add 7 days" : "Reopen for 7 days"}</DenButton>
        {sandbox.state === "open" ? <DenButton variant="secondary" size="sm" disabled={busy} onClick={onClose}>Close</DenButton> : null}
      </div>
    </div>
    {sandbox.state === "open" ? <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
      <DenInput aria-label={`${sandbox.name} join link`} className="min-w-0 flex-1 font-mono text-xs" value={sandbox.joinLink} readOnly onFocus={event => event.currentTarget.select()} />
      <div className="flex gap-2">
        <DenButton size="sm" variant="secondary" icon={copied ? Check : Copy} onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</DenButton>
        <DenButton size="sm" variant="ghost" disabled={busy} onClick={onRotate}>New link</DenButton>
      </div>
    </div> : null}
  </article>;
}
