"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Lock, Trash2 } from "lucide-react";
import {
  workspaceLimitRuleScopeSchema,
  workspaceLimitSettingsSchema,
  type WorkspaceLimitRule,
  type WorkspaceLimitRuleScope,
  type WorkspaceLimitSettings,
} from "@openwork/types/den/admin-limits";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenCheckbox } from "../../../app/(den)/_components/ui/checkbox";
import { DenInput } from "../../../app/(den)/_components/ui/input";
import { DenSelect } from "../../../app/(den)/_components/ui/select";
import { AdminAccessScreen } from "../admin-access-screen";
import { requestAdmin, sendAdmin, type AdminAccess } from "../admin-request";

const base = "/v1/admin/limits/workspace-creation";
const parseSettings = (value: unknown) => { const result = workspaceLimitSettingsSchema.safeParse(value); return result.success ? result.data : null; };
const limitLabel = (limit: number | null) => limit === null ? "No limit" : String(limit);
const scopeLabel: Record<WorkspaceLimitRuleScope, string> = { email: "Email", domain: "Domain" };

type Draft = { scope: WorkspaceLimitRuleScope; value: string; limit: string; unlimited: boolean };
const emptyDraft: Draft = { scope: "email", value: "", limit: "", unlimited: false };

export function WorkspaceCreationLimits() {
  const [data, setData] = useState<WorkspaceLimitSettings | null>(null);
  const [access, setAccess] = useState<{ access: Exclude<AdminAccess, "ready">; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await requestAdmin(base, parseSettings, signal);
    if (signal?.aborted) return;
    if (result.access === "ready") { setData(result.data); setError(null); setAccess(null); }
    else if (result.access === "signed-out" || result.access === "forbidden") setAccess({ access: result.access, message: result.message });
    else setError(result.message);
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function apply(request: Promise<Awaited<ReturnType<typeof sendAdmin>>>, done: string) {
    setSaving(true);
    setError(null);
    setNotice("");
    const result = await request;
    setSaving(false);
    if (!result.ok) { setError(result.message); return false; }
    const next = parseSettings(result.payload);
    if (next) setData(next);
    setNotice(done);
    return true;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const limit = draft.unlimited ? null : Number(draft.limit);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) { setError("Enter a whole number of workspaces, or choose No limit."); return; }
    const saved = await apply(sendAdmin(`${base}/rules`, "PUT", { scope: draft.scope, value: draft.value, limit }), `Saved the limit for ${draft.value.trim()}.`);
    if (saved) setDraft({ ...emptyDraft, scope: draft.scope });
  }

  function edit(rule: WorkspaceLimitRule) {
    setDraft({ scope: rule.scope, value: rule.value, limit: rule.limit === null ? "" : String(rule.limit), unlimited: rule.limit === null });
  }

  if (access) return <AdminAccessScreen state={access.access} message={access.message} />;
  if (!data) return <div aria-busy="true">{error
    ? <div role="alert" className="grid gap-3"><p className="text-sm text-[color:var(--ow-danger)]">{error}</p><DenButton variant="secondary" size="sm" className="justify-self-start" onClick={() => void load()}>Retry</DenButton></div>
    : <div className="grid gap-3"><div className="h-10 rounded-md bg-[var(--dls-hover)]" /><div className="h-32 rounded-md bg-[var(--dls-hover)]" /></div>}</div>;

  return <div className="grid gap-6" data-testid="admin-limits-workspace-creation" aria-busy={saving}>
    {!data.enforcementEnabled ? <p className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--dls-text-secondary)]" data-testid="admin-limits-off">
      <Lock size={16} aria-hidden="true" />Not enforced yet. Turn on Limit workspaces per person in
      <Link href="/admin/features" prefetch={false} className="underline underline-offset-2">Feature rollouts</Link>.
    </p> : null}
    <dl className="grid max-w-md grid-cols-2 gap-y-2 text-sm">
      <dt className="text-[color:var(--dls-text-secondary)]">Default per person</dt><dd>{data.defaultLimit > 0 ? data.defaultLimit : "No limit"}</dd>
    </dl>
    {error ? <p role="alert" className="text-sm text-[color:var(--ow-danger)]">{error}</p> : null}
    <p role="status" aria-live="polite" className="text-sm text-[color:var(--dls-text-secondary)] empty:hidden">{notice}</p>
    <div className="min-w-0 overflow-x-auto">
      {data.rules.length === 0 ? <p className="border-t border-[var(--dls-border)] py-6 text-sm text-[color:var(--dls-text-secondary)]">Everyone uses the default. Add an email or domain to give them a different limit.</p>
        : <table className="w-full text-left text-sm">
          <thead className="text-xs text-[color:var(--dls-text-secondary)]"><tr><th className="py-2 font-medium">Applies to</th><th className="py-2 font-medium">Matches</th><th className="py-2 font-medium">Workspaces per person</th><th className="py-2"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{data.rules.map(rule => <tr key={rule.id} className="border-t border-[var(--dls-border)]">
            <td className="py-2">{scopeLabel[rule.scope]}</td>
            <td className="py-2 [overflow-wrap:anywhere]">{rule.scope === "domain" ? `@${rule.value}` : rule.value}</td>
            <td className="py-2">{limitLabel(rule.limit)}</td>
            <td className="py-2 text-right">
              <DenButton variant="ghost" size="sm" disabled={saving} onClick={() => edit(rule)}>Edit</DenButton>
              <DenButton variant="ghost" size="sm" aria-label={`Remove the limit for ${rule.value}`} disabled={saving}
                onClick={() => void apply(sendAdmin(`${base}/rules/${rule.scope}/${encodeURIComponent(rule.value)}`, "DELETE"), `Removed the limit for ${rule.value}.`)}><Trash2 size={16} aria-hidden="true" /></DenButton>
            </td>
          </tr>)}</tbody>
        </table>}
    </div>
    <form onSubmit={save} className="grid max-w-xl gap-4 border-t border-[var(--dls-border)] pt-4" data-testid="admin-limits-form">
      <h2 className="text-sm font-medium">Set a limit</h2>
      <label className="grid gap-2 text-xs">Applies to<DenSelect aria-label="Applies to" value={draft.scope} disabled={saving}
        onChange={event => { const parsed = workspaceLimitRuleScopeSchema.safeParse(event.target.value); if (parsed.success) setDraft({ ...draft, scope: parsed.data }); }}>
        <option value="email">One email address</option><option value="domain">Each person at a domain</option>
      </DenSelect></label>
      <label className="grid gap-2 text-xs">{draft.scope === "email" ? "Email address" : "Domain"}
        <DenInput aria-label={draft.scope === "email" ? "Email address" : "Domain"} required minLength={3} maxLength={320} disabled={saving}
          placeholder={draft.scope === "email" ? "alice@acme.com" : "acme.com"} value={draft.value} onChange={event => setDraft({ ...draft, value: event.target.value })} />
        <span className="text-[color:var(--dls-text-secondary)]">{draft.scope === "email" ? "Aliases such as alice+work@ and Gmail dot variants count as the same person." : "Each person at this domain gets this limit. An email limit wins over it."}</span>
      </label>
      <label className="grid gap-2 text-xs">Workspaces per person
        <DenInput aria-label="Workspaces per person" type="number" min={1} max={10000} required={!draft.unlimited} disabled={saving || draft.unlimited}
          value={draft.limit} onChange={event => setDraft({ ...draft, limit: event.target.value })} />
      </label>
      <label className="flex items-center gap-2 text-sm"><DenCheckbox checked={draft.unlimited} disabled={saving} onCheckedChange={checked => setDraft({ ...draft, unlimited: checked === true })} />No limit</label>
      <DenButton type="submit" loading={saving} disabled={draft.value.trim().length < 3} className="justify-self-start">Save limit</DenButton>
    </form>
  </div>;
}
