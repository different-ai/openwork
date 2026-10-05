"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useState, type FormEvent } from "react";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { McpCredentialInput } from "./mcp-credential-input";
import { MEMBER_API_KEY_DIALOG_SUBTITLE, MEMBER_API_KEY_MAX_LENGTH, MEMBER_API_KEY_UNCERTAIN_MESSAGE, validateMemberApiKey } from "./member-api-key";
import { useSaveMyMcpCredential } from "./mcp-connections-data";

export type MemberApiKeyTarget = { id: string; name: string; replacing?: boolean };

export function MemberApiKeyDialog({ target, onClose, onSaved }: {
  target: MemberApiKeyTarget | null;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
}) {
  return (
    <Dialog.Root open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/20" />
        <Dialog.Popup
          data-testid="member-api-key-dialog"
          data-ph-no-capture
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-gray-100 bg-white p-5 outline-none"
        >
          {/* Keyed by connection: a new target always starts from an empty form. */}
          {target ? <MemberApiKeyForm key={target.id} target={target} onClose={onClose} onSaved={onSaved} /> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MemberApiKeyForm({ target, onClose, onSaved }: {
  target: MemberApiKeyTarget;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
}) {
  const { orgId } = useOrgDashboard();
  const [openedForOrgId] = useState(orgId);
  const save = useSaveMyMcpCredential();
  const { reset } = save;
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The connection belongs to the organization the dialog opened in.
  useEffect(() => {
    if (orgId !== openedForOrgId) onClose();
  }, [orgId, openedForOrgId, onClose]);
  // Drop the submitted key from mutation state when the form goes away.
  useEffect(() => reset, [reset]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = validateMemberApiKey(apiKey);
    if (validationError) {
      setError(validationError);
      return;
    }
    const submitted = apiKey;
    setApiKey("");
    setError(null);
    try {
      await save.mutateAsync({ connectionId: target.id, apiKey: submitted });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : MEMBER_API_KEY_UNCERTAIN_MESSAGE);
      return;
    } finally {
      reset();
    }
    setSaved(true);
    try {
      await onSaved?.();
    } catch {
      // The key is already stored. A failed refresh must not recast that save as a failure.
    }
  }

  return (
    <>
      <Dialog.Title className="text-[16px] font-semibold leading-6 text-gray-900">
        {saved ? `${target.name}: key saved` : `${target.replacing ? "Replace" : "Add"} key for ${target.name}`}
      </Dialog.Title>
      {!saved ? <Dialog.Description className="mt-1.5 text-[12px] leading-[18px] text-gray-500">{MEMBER_API_KEY_DIALOG_SUBTITLE}</Dialog.Description> : null}
      {saved ? (
        <div className="mt-5 flex justify-end">
          <DenButton size="sm" onClick={onClose}>Done</DenButton>
        </div>
      ) : (
        <form className="mt-5 flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-gray-700">Personal access token or API key</span>
            <McpCredentialInput
              kind="secret"
              name="member-mcp-api-key"
              aria-label={`${target.name} key`}
              autoComplete="off"
              data-ph-no-capture
              maxLength={MEMBER_API_KEY_MAX_LENGTH}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={save.isPending}
              autoFocus
            />
          </label>
          {error ? <p className="text-[12px] text-red-600" role="alert">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Dialog.Close disabled={save.isPending} className={buttonVariants({ variant: "secondary", size: "sm" })}>Cancel</Dialog.Close>
            <DenButton type="submit" size="sm" loading={save.isPending} disabled={!apiKey}>Save key</DenButton>
          </div>
        </form>
      )}
    </>
  );
}
