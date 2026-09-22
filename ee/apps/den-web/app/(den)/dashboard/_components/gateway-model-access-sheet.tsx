"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ShieldCheck, Users } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSwitch } from "../../_components/ui/switch";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useModelAccessPolicy, type ModelAccessValue } from "./model-access-policy";

/** Short state for the "Who can use models" row: pill + one line. */
export function describeModelAccess(value: ModelAccessValue) {
  if (value.mode === "open") {
    return { pill: "Any model", line: "Members can add their own keys" };
  }
  const zen = value.zenAllowed ? "" : " · no free model";
  return {
    pill: "Only models you provide",
    line: value.adminException ? `Members can’t add their own keys · admins can${zen}` : `Nobody can add their own keys${zen}`,
  };
}

function RadioOption({
  checked,
  title,
  description,
  onSelect,
  disabled,
  testId,
  children,
}: {
  checked: boolean;
  title: string;
  description: string;
  onSelect: () => void;
  disabled: boolean;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <div className={`rounded-2xl border px-4 py-3.5 transition-colors ${checked ? "border-transparent bg-gray-100" : "border-gray-200 bg-white hover:bg-gray-50"}`}>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="radio"
          name="gateway-model-access"
          data-testid={testId}
          className="mt-0.5 h-4 w-4 accent-gray-900"
          checked={checked}
          disabled={disabled}
          onChange={onSelect}
        />
        <span className="min-w-0">
          <span className="block text-[14px] font-medium text-gray-950">{title}</span>
          <span className="mt-0.5 block text-[12.5px] leading-5 text-gray-500">{description}</span>
        </span>
      </label>
      {children}
    </div>
  );
}

/** The "Who can use models" row plus the sheet it opens. */
export function GatewayModelAccessRow() {
  const { orgId, runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const { saved, defaultPolicy, busy, error, save } = useModelAccessPolicy(orgId);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ModelAccessValue>(saved);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setDraft(saved);
  }, [open, saved]);

  const summary = describeModelAccess(saved);
  const disabled = busy || saving || !defaultPolicy;

  async function submit() {
    setSaveError(null);
    setSaving(true);
    try {
      await runReauthableAction("save-model-access", () => save(draft));
      setOpen(false);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not save who can use models.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div data-testid="gateway-model-access-row" className="flex flex-wrap items-center gap-4 rounded-2xl border border-gray-100 bg-white px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-gray-50 text-gray-500">
          <Users className="h-4 w-4" aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-[14px] font-medium text-gray-950">Who can use models</p>
        {busy && !defaultPolicy ? (
          <span className="h-4 w-48 animate-pulse rounded bg-gray-100" aria-hidden />
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11.5px] font-medium text-gray-900">{summary.pill}</span>
            <span className="text-[13px] text-gray-500">{summary.line}</span>
          </div>
        )}
        <DenButton size="sm" variant="secondary" disabled={!defaultPolicy} onClick={() => setOpen(true)} data-testid="gateway-model-access-change">
          Change
        </DenButton>
      </div>
      {error ? <DenNotice className="mt-3" tone="error" message={error} /> : null}

      <Dialog.Root open={open && !reauthDialogOpen} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/30" />
          <Dialog.Popup
            aria-busy={saving}
            data-testid="gateway-model-access-sheet"
            className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[24px] bg-white shadow-[0_24px_80px_-20px_rgba(15,23,42,0.45)] outline-none"
          >
            <div className="flex items-start gap-3 px-6 pb-4 pt-6">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-gray-100 text-gray-500">
                <Users className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <Dialog.Title className="text-[16px] font-semibold text-gray-950">Who can use models</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-[13px] text-gray-500">Applies to every member, on Desktop and the web.</Dialog.Description>
              </div>
            </div>
            <fieldset disabled={disabled} className="grid gap-3 px-6 pb-5">
              <RadioOption
                testId="gateway-model-access-managed"
                checked={draft.mode === "managed"}
                title="Only models you provide"
                description="Members see what you set up in AI Gateway and OpenWork Models. They cannot add their own provider keys."
                disabled={disabled}
                onSelect={() => setDraft({ ...draft, mode: "managed" })}
              >
                {draft.mode === "managed" ? (
                  <label className="mt-3 flex cursor-pointer items-center gap-2.5 rounded-xl bg-white px-3 py-2.5 text-[13px] text-gray-800">
                    <input
                      type="checkbox"
                      data-testid="gateway-model-access-admin-exception"
                      className="h-4 w-4 accent-gray-900"
                      checked={draft.adminException}
                      onChange={(event) => setDraft({ ...draft, adminException: event.target.checked })}
                    />
                    Admins may still add their own keys on their device
                  </label>
                ) : null}
              </RadioOption>
              <RadioOption
                testId="gateway-model-access-open"
                checked={draft.mode === "open"}
                title="Any model"
                description="Members can also add their own provider keys on their device. Your AI Gateway models still show up."
                disabled={disabled}
                onSelect={() => setDraft({ ...draft, mode: "open", adminException: true })}
              />
              <div className="flex items-center gap-3 rounded-2xl border border-gray-200 px-4 py-3.5">
                <ShieldCheck className="h-4 w-4 shrink-0 text-gray-500" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-gray-950">Free starter model (Auto)</p>
                  <p className="mt-0.5 text-[12.5px] leading-5 text-gray-500">Members can fall back to OpenWork’s free model. Rate-limited.</p>
                </div>
                <DenSwitch
                  checked={draft.zenAllowed}
                  onChange={(zenAllowed) => setDraft({ ...draft, zenAllowed })}
                  aria-label="Free starter model"
                  testId="gateway-model-access-zen"
                  disabled={disabled}
                />
              </div>
              {saveError ? <DenNotice tone="error" message={saveError} /> : null}
            </fieldset>
            <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 bg-gray-50/60 px-6 py-4">
              <p className="min-w-0 flex-1 text-[12.5px] text-gray-500">Takes effect next time members open OpenWork</p>
              <DenButton variant="secondary" disabled={saving} onClick={() => setOpen(false)}>Cancel</DenButton>
              <DenButton loading={saving} disabled={disabled} onClick={() => void submit()} data-testid="gateway-model-access-save">Save</DenButton>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
