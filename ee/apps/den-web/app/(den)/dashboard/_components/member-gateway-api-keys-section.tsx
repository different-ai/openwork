"use client";

import { Dialog } from "@base-ui/react/dialog";
import {
  DEFAULT_GATEWAY_API_KEY_EXPIRY,
  GATEWAY_API_KEY_EXPIRY_CHOICES,
  GATEWAY_API_KEY_NAME_MAX_LENGTH,
  gatewayApiKeyExpired,
  type CreatedGatewayApiKey,
} from "@openwork/types/den/gateway-api-keys";
import { Check, Copy, KeyRound, Lock, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { ItemMenu } from "./item-list";
import { LibraryCompactSurface } from "./library-compact";
import {
  expiryChoiceLabel,
  expiryFromDays,
  formatCreated,
  formatExpiry,
  formatLastUsed,
  GATEWAY_API_KEYS_DOCS_URL,
  useCreateGatewayApiKey,
  useMyGatewayApiKeys,
  useRevokeGatewayApiKey,
} from "./gateway-api-keys-data";

/**
 * Library › Models (feature `gatewayMemberApiKeys`): the viewer's own AI Gateway API keys for 3rd party
 * tools, a way to create one, and the docs on setting a tool up. Shown while the organization allows
 * member keys, or while the viewer still holds keys after it stopped, so they can revoke them.
 */
export function MemberGatewayApiKeysSection() {
  const keys = useMyGatewayApiKeys(true);
  const revoke = useRevokeGatewayApiKey("mine");
  const [creating, setCreating] = useState(false);

  if (!keys.data) return null;
  const { enabled, baseUrl, apiKeys } = keys.data;
  if (!enabled && apiKeys.length === 0) return null;

  return (
    <LibraryCompactSurface testId="library-gateway-api-keys">
      <section className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2 px-2">
          <h2 className="flex items-center gap-2 text-[12px] font-medium leading-5 text-[var(--dls-text-secondary)]">
            API keys for 3rd party tools
            <span className="tabular-nums">{apiKeys.length}</span>
          </h2>
          <div className="flex items-center gap-1">
            <a href={GATEWAY_API_KEYS_DOCS_URL} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })} data-testid="gateway-api-keys-docs">
              How to use
            </a>
            {enabled ? (
              <DenButton size="sm" variant="secondary" icon={Plus} onClick={() => setCreating(true)} data-testid="gateway-api-keys-create">
                Create key
              </DenButton>
            ) : null}
          </div>
        </div>

        {!enabled ? (
          <p className="flex items-center gap-1.5 px-2 py-2 text-[13px] text-gray-500" data-testid="gateway-api-keys-disabled">
            <Lock size={12} aria-hidden="true" />
            Turned off by your organization. Your keys don&apos;t work until an admin turns 3rd party tools back on in Settings.
          </p>
        ) : null}

        {apiKeys.length === 0 ? (
          <p className="px-2 py-2 text-[13px] text-gray-500" data-testid="gateway-api-keys-empty">
            Create a key to use your models in Claude Code, Codex, Cursor or any OpenAI or Anthropic compatible tool.
          </p>
        ) : (
          <div className="flex flex-col">
            {apiKeys.map((apiKey) => (
              <div
                key={apiKey.id}
                className="group grid min-h-11 grid-cols-[minmax(0,1fr)_auto_2rem] items-center gap-3 rounded-lg px-2 transition-colors duration-150 hover:bg-[var(--dls-hover)] focus-within:bg-[var(--dls-hover)]"
                data-gateway-api-key={apiKey.name}
              >
                <span className="flex min-w-0 items-center gap-3 py-2">
                  <span className="flex size-6 shrink-0 items-center justify-center text-gray-500"><KeyRound size={16} aria-hidden /></span>
                  <span className="min-w-0 truncate text-[13px] font-medium leading-5 text-[var(--dls-text-primary)]">{apiKey.name}</span>
                  <span className="hidden min-w-0 truncate font-mono text-[12px] text-[var(--dls-text-secondary)] sm:block">{apiKey.prefix}…</span>
                </span>
                <span className="hidden items-center gap-4 text-right text-[12px] md:flex" title={formatCreated(apiKey.createdAt)}>
                  <span className={gatewayApiKeyExpired(apiKey.expiresAt) ? "font-medium text-red-600" : "text-[var(--dls-text-secondary)]"} data-gateway-api-key-expiry>
                    {formatExpiry(apiKey.expiresAt)}
                  </span>
                  <span className="w-28 truncate text-[var(--dls-text-secondary)]">{formatLastUsed(apiKey.lastUsedAt)}</span>
                </span>
                <span className="flex justify-end opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 [@media(hover:none)]:opacity-100">
                  <ItemMenu
                    label={`Actions for ${apiKey.name}`}
                    entries={[{
                      label: "Revoke",
                      destructive: true,
                      confirm: {
                        title: `Revoke ${apiKey.name}?`,
                        description: "Tools using this key stop working right away. This can't be undone.",
                        action: "Revoke key",
                      },
                      onSelect: async () => { await revoke.mutateAsync(apiKey.id); },
                    }]}
                  />
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col pt-1">
          {baseUrls(baseUrl).map((entry) => (
            <div key={entry.label} className="flex min-h-9 items-center gap-2 px-2 text-[12px] text-[var(--dls-text-secondary)]">
              <span className="w-36 shrink-0">{entry.label}</span>
              <code className="min-w-0 truncate font-mono text-[12px] text-[var(--dls-text-primary)]" data-testid={`gateway-api-keys-base-url-${entry.id}`}>{entry.url}</code>
              <CopyButton value={entry.url} label={`Copy ${entry.label}`} />
            </div>
          ))}
        </div>
      </section>

      <CreateGatewayApiKeyDialog open={creating} baseUrl={baseUrl} onClose={() => setCreating(false)} />
    </LibraryCompactSurface>
  );
}

/**
 * Where tools point: OpenAI compatible tools take the URL with /v1 (they add /chat/completions or
 * /responses); Anthropic tools take it without (they add /v1/messages).
 */
function baseUrls(baseUrl: string) {
  return [
    { id: "openai", label: "OpenAI base URL", url: baseUrl },
    { id: "anthropic", label: "Anthropic base URL", url: baseUrl.replace(/\/v1\/?$/, "") },
  ];
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => void copy()}
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}

function CreateGatewayApiKeyDialog({ open, baseUrl, onClose }: { open: boolean; baseUrl: string; onClose: () => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/20" />
        <Dialog.Popup
          data-testid="gateway-api-key-dialog"
          data-ph-no-capture
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-gray-100 bg-white p-5 outline-none"
        >
          {/* Mounted only while open: a closed dialog forgets the key it showed. */}
          {open ? <CreateGatewayApiKeyForm baseUrl={baseUrl} onClose={onClose} /> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CreateGatewayApiKeyForm({ baseUrl, onClose }: { baseUrl: string; onClose: () => void }) {
  const create = useCreateGatewayApiKey();
  const [name, setName] = useState("");
  const [expiryDays, setExpiryDays] = useState<number | null>(DEFAULT_GATEWAY_API_KEY_EXPIRY);
  const [created, setCreated] = useState<CreatedGatewayApiKey | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      setCreated(await create.mutateAsync({ name: trimmed, expiresAt: expiryFromDays(expiryDays) }));
    } catch {
      // Shown below from the mutation's error.
    }
  }

  if (created) {
    return (
      <>
        <Dialog.Title className="text-[16px] font-semibold leading-6 text-gray-900">{created.apiKey.name} is ready</Dialog.Title>
        <p className="mt-1 text-[13px] text-gray-500" data-testid="gateway-api-key-created-expiry">{formatExpiry(created.apiKey.expiresAt)}</p>
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-gray-700">API key, shown once</span>
            <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[12px] leading-5 text-gray-900" data-testid="gateway-api-key-secret">{created.key}</code>
              <CopyButton value={created.key} label="Copy API key" />
            </div>
          </div>
          {baseUrls(baseUrl).map((entry) => (
            <div key={entry.label} className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-gray-700">{entry.label}</span>
              <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                <code className="min-w-0 flex-1 break-all font-mono text-[12px] leading-5 text-gray-900">{entry.url}</code>
                <CopyButton value={entry.url} label={`Copy ${entry.label}`} />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 flex items-center justify-between gap-2">
          <a href={GATEWAY_API_KEYS_DOCS_URL} target="_blank" rel="noreferrer" className="text-[12px] text-gray-600 underline underline-offset-4 hover:text-gray-900">
            How to use
          </a>
          <DenButton size="sm" onClick={onClose} data-testid="gateway-api-key-done">Done</DenButton>
        </div>
      </>
    );
  }

  return (
    <>
      <Dialog.Title className="text-[16px] font-semibold leading-6 text-gray-900">Create an API key</Dialog.Title>
      <form className="mt-5 flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-gray-700">Name</span>
          <DenInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Claude Code on my laptop"
            maxLength={GATEWAY_API_KEY_NAME_MAX_LENGTH}
            disabled={create.isPending}
            autoComplete="off"
            autoFocus
            required
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-gray-700">Expires</span>
          <DenSelect
            value={expiryDays === null ? "never" : String(expiryDays)}
            onChange={(event) => setExpiryDays(event.target.value === "never" ? null : Number(event.target.value))}
            disabled={create.isPending}
            aria-label="Expires"
          >
            {GATEWAY_API_KEY_EXPIRY_CHOICES.map((days) => (
              <option key={days ?? "never"} value={days === null ? "never" : String(days)}>
                {days === null ? "Never" : `In ${expiryChoiceLabel(days)}`}
              </option>
            ))}
          </DenSelect>
        </label>
        {create.error ? <p className="text-[12px] text-red-600" role="alert">{create.error.message}</p> : null}
        <div className="flex justify-end gap-2">
          <Dialog.Close disabled={create.isPending} className={buttonVariants({ variant: "secondary", size: "sm" })}>Cancel</Dialog.Close>
          <DenButton type="submit" size="sm" loading={create.isPending} disabled={!name.trim()} data-testid="gateway-api-key-submit">Create key</DenButton>
        </div>
      </form>
    </>
  );
}
