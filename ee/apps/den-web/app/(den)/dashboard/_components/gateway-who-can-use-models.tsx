"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Laptop, Lock, Sparkles, Users } from "lucide-react";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { AUTOMATION_CARD_CLASS } from "../../_components/ui/dashboard-styles";
import { DenNotice } from "../../_components/ui/notice";
import { DenSwitch } from "../../_components/ui/switch";
import { getOrgAccessFlags, orgFeatureEnabled, permissionLockReason } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useOrgDesktopPolicies } from "./desktop-policy-data";
import { readModelAccessState, saveModelAccess, type ModelAccessMode } from "./model-access-policy";

function Option({ testId, checked, title, description, onSelect, children }: {
  testId: string; checked: boolean; title: string; description: string; onSelect: () => void; children?: ReactNode;
}) {
  return (
    <label className={`block rounded-[12px] border px-4 py-3 ${checked ? "border-gray-200 bg-gray-50" : "border-gray-200 bg-white"}`}>
      <span className="flex items-start gap-3">
        <input type="radio" name="gateway-model-access-mode" data-testid={testId} checked={checked} onChange={onSelect} className="mt-0.5 h-4 w-4 accent-gray-900" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-gray-900">{title}</span>
          <span className="mt-0.5 block text-[12px] leading-4 text-gray-500">{description}</span>
        </span>
      </span>
      {children}
    </label>
  );
}

export function GatewayWhoCanUseModels() {
  const { orgId, orgContext, runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const localSwitch = orgContext ? orgFeatureEnabled(orgContext, "localModelsPolicy") : false;
  // Model access is a desktop policy: owners by default. Others see it, locked with why (DESIGN P4).
  const canChange = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canManageDesktopPolicies
    : false;
  const { desktopPolicies, busy, error: policiesError, reloadPolicies } = useOrgDesktopPolicies(orgId);
  const state = readModelAccessState(desktopPolicies);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ModelAccessMode>(state.mode);
  const [adminException, setAdminException] = useState(state.adminException);
  const [zenAllowed, setZenAllowed] = useState(state.zenAllowed);
  const [localAllowed, setLocalAllowed] = useState(state.localAllowed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMode(state.mode);
    setAdminException(state.adminException);
    setZenAllowed(state.zenAllowed);
    setLocalAllowed(state.localAllowed);
  }, [state.mode, state.adminException, state.zenAllowed, state.localAllowed]);

  const managed = state.mode === "managed";
  const keys = managed
    ? `Members can't add their own keys${state.adminException ? ", admins can" : ""}`
    : "Members can also add their own keys on their device";
  const consequence = localSwitch ? `${keys}. Local models ${state.localAllowed ? "on" : "off"}` : keys;

  async function save() {
    setError(null);
    setSaving(true);
    try {
      await runReauthableAction("save-model-access", async () => {
        await saveModelAccess(state, { mode, adminException, zenAllowed, ...(localSwitch ? { localAllowed } : {}) });
        await reloadPolicies();
      });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save who can use models.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className={`${AUTOMATION_CARD_CLASS} flex min-h-12 items-center gap-3 px-4 py-1.5`} data-testid="gateway-model-policy-row">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--dls-hover)] text-[color:var(--dls-text-secondary)]"><Users size={16} strokeWidth={1.5} aria-hidden="true" /></span>
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-[color:var(--dls-text-primary)]">Who can use models</p>
        {busy ? <span className="text-[12px] text-[color:var(--dls-text-secondary)]">Loading…</span> : (
          <>
            <DenChip size="xs" data-testid="gateway-model-policy-state">{managed ? "Only models you provide" : "Any model"}</DenChip>
            <span className="hidden text-[12px] text-[color:var(--dls-text-secondary)] md:inline">{consequence}</span>
          </>
        )}
        {canChange ? (
          <DenButton size="sm" variant="secondary" data-testid="gateway-model-policy-open" disabled={busy} onClick={() => setOpen(true)}>Change</DenButton>
        ) : (
          <span className="flex items-center gap-1.5 text-[12px] text-[color:var(--dls-text-secondary)]" data-testid="gateway-model-policy-locked" title={permissionLockReason("desktop_policies.manage")}>
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />Locked
          </span>
        )}
      </div>
      {!canChange && !busy ? <p className="mt-2 px-1 text-[12px] text-[color:var(--dls-text-secondary)]">{permissionLockReason("desktop_policies.manage")}</p> : null}

      <Dialog.Root open={open && canChange && !reauthDialogOpen} onOpenChange={(next) => { if (saving) return; setOpen(next); setError(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-gray-200 bg-white p-4 outline-none">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 text-gray-500"><Users className="h-4 w-4" aria-hidden="true" /></span>
              <div>
                <Dialog.Title className="text-[14px] font-medium text-gray-900">Who can use models</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-[12px] text-gray-500">Applies to every member, on Desktop and the web.</Dialog.Description>
              </div>
            </div>
            {policiesError ? <DenNotice className="mt-3" tone="error" message={policiesError} /> : null}
            {error ? <DenNotice className="mt-3" tone="error" message={error} /> : null}
            <div className="mt-4 grid gap-2">
              <Option testId="gateway-model-access-managed" checked={mode === "managed"} title="Only models you provide"
                description="Members see what you set up in AI Gateway and OpenWork Models. They cannot add their own provider keys." onSelect={() => setMode("managed")}>
                {mode === "managed" ? (
                  <label className="mt-3 flex items-center gap-2 rounded-[8px] border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-700">
                    <input type="checkbox" data-testid="gateway-model-access-admin-exception" checked={adminException} onChange={(event) => setAdminException(event.target.checked)} className="h-3.5 w-3.5 accent-gray-900" />
                    Admins may still add their own keys on their device
                  </label>
                ) : null}
              </Option>
              <Option testId="gateway-model-access-open" checked={mode === "open"} title="Any model"
                description="Members can also add their own provider keys on their device. Your AI Gateway models still show up." onSelect={() => setMode("open")} />
              <div className="flex items-center gap-3 rounded-[12px] border border-gray-200 bg-white px-4 py-3">
                <Sparkles className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-gray-900">Free starter model (Auto)</span>
                  <span className="block text-[12px] text-gray-500">Members can fall back to OpenWork's free model. Rate-limited.</span>
                </span>
                <DenSwitch checked={zenAllowed} onChange={setZenAllowed} aria-label="Free starter model" />
              </div>
              {localSwitch ? (
                <div className="flex items-center gap-3 rounded-[12px] border border-gray-200 bg-white px-4 py-3" data-testid="gateway-model-access-local">
                  <Laptop className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-gray-900">Local models</span>
                    <span className="block text-[12px] text-gray-500">Ollama and LM Studio on each person's own computer.</span>
                  </span>
                  <DenSwitch checked={localAllowed} onChange={setLocalAllowed} aria-label="Local models" />
                </div>
              ) : null}
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-[11px] text-gray-400">Takes effect next time members open OpenWork</span>
              <span className="flex items-center gap-2">
                <Dialog.Close disabled={saving} className={buttonVariants({ variant: "secondary", size: "sm" })}>Cancel</Dialog.Close>
                <DenButton size="sm" data-testid="gateway-model-policy-save" loading={saving} disabled={busy || !state.defaultPolicy} onClick={() => void save()}>Save</DenButton>
              </span>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
