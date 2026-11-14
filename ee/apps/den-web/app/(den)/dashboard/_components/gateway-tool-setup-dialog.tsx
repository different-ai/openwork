"use client";

import { Dialog } from "@base-ui/react/dialog";
import { DEFAULT_GATEWAY_API_KEY_EXPIRY, type CreatedGatewayApiKey } from "@openwork/types/den/gateway-api-keys";
import { KeyRound, Lock, Plug, Plus, X } from "lucide-react";
import { useState } from "react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton } from "../../_components/ui/button";
import { expiryFromDays, formatExpiry, useCreateGatewayApiKey } from "./gateway-api-keys-data";
import { CopyField, GATEWAY_TOOLS, GatewayToolSteps, type GatewayToolId } from "./gateway-tool-setup";

/**
 * Library › Models › "Use OpenWork AI Gateway with other tools": one small
 * logo button per tool. Each opens that tool's steps in a dialog, with a way
 * to create a key there so every step shows the real key, ready to copy.
 */

type Tool = (typeof GATEWAY_TOOLS)[number];

/** Shorter names for the button row, where the logo already says whose tool it is. */
const BUTTON_LABELS: Partial<Record<GatewayToolId, string>> = {
  codex: "Codex CLI",
  "codex-app": "Codex app",
  other: "Other",
};

function ToolMark({ tool, size }: { tool: Tool; size: "sm" | "md" }) {
  const box = size === "sm" ? "h-5 w-5 rounded-[6px] border-0 bg-transparent" : "h-9 w-9 rounded-[10px]";
  const image = size === "sm" ? "h-[14px] w-[14px]" : "h-[18px] w-[18px]";
  if (!tool.slug) {
    return (
      <span className={`flex shrink-0 items-center justify-center ${size === "md" ? "border border-gray-100 bg-white" : ""} ${box}`}>
        <Plug size={size === "sm" ? 14 : 18} className="text-gray-500" aria-hidden />
      </span>
    );
  }
  return <DenBrandMark name={tool.name} simpleIconSlug={tool.slug} serviceUrl={tool.serviceUrl} className={box} imageClassName={image} />;
}

/** The "Set up" row: a logo button per tool. */
export function GatewayToolSetupRow({ enabled, baseUrl }: { enabled: boolean; baseUrl: string }) {
  const [open, setOpen] = useState<GatewayToolId | null>(null);
  const tool = GATEWAY_TOOLS.find((entry) => entry.id === open) ?? null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-2" data-testid="gateway-tool-setup-row">
      <span className="w-12 shrink-0 text-[12px] font-medium leading-5 text-[var(--dls-text-secondary)]">Set up</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {GATEWAY_TOOLS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setOpen(entry.id)}
            aria-label={`Set up ${entry.name}`}
            title={entry.line}
            data-testid={`gateway-tool-setup-${entry.id}`}
            className="group inline-flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white pl-1.5 pr-2.5 text-[12px] font-medium text-gray-600 transition-[background-color,border-color,color] duration-150 ease-out hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
          >
            <span className="opacity-70 grayscale transition-[filter,opacity] duration-150 ease-out group-hover:opacity-100 group-hover:grayscale-0 group-focus-visible:opacity-100 group-focus-visible:grayscale-0">
              <ToolMark tool={entry} size="sm" />
            </span>
            {BUTTON_LABELS[entry.id] ?? entry.name}
          </button>
        ))}
      </div>
      <GatewayToolSetupDialog tool={tool} enabled={enabled} baseUrl={baseUrl} onClose={() => setOpen(null)} />
    </div>
  );
}

function GatewayToolSetupDialog({ tool, enabled, baseUrl, onClose }: { tool: Tool | null; enabled: boolean; baseUrl: string; onClose: () => void }) {
  return (
    <Dialog.Root open={tool !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/20" />
        <Dialog.Popup
          data-testid="gateway-tool-setup-dialog"
          data-ph-no-capture
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[600px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-gray-100 bg-white p-5 outline-none"
        >
          {/* Keyed by tool and mounted only while open: closing forgets a key it showed. */}
          {tool ? <ToolSetup key={tool.id} tool={tool} enabled={enabled} baseUrl={baseUrl} onClose={onClose} /> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ToolSetup({ tool, enabled, baseUrl, onClose }: { tool: Tool; enabled: boolean; baseUrl: string; onClose: () => void }) {
  const [created, setCreated] = useState<CreatedGatewayApiKey | null>(null);
  return (
    <div className="flex flex-col gap-5" data-gateway-tool-setup={tool.id}>
      <div className="flex items-center gap-3">
        <ToolMark tool={tool} size="md" />
        <Dialog.Title className="min-w-0 flex-1 text-[16px] font-semibold leading-6 tracking-[-0.01em] text-gray-900">{`Set up ${tool.name}`}</Dialog.Title>
        <Dialog.Close aria-label="Close" className="flex size-7 shrink-0 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900">
          <X size={16} aria-hidden />
        </Dialog.Close>
      </div>
      <ApiKeyStep tool={tool} enabled={enabled} created={created} onCreated={setCreated} />
      <div className="h-px bg-gray-100" aria-hidden />
      <GatewayToolSteps tool={tool.id} apiKey={created?.key ?? null} baseUrl={baseUrl} />
      <div className="flex justify-end">
        <DenButton size="sm" variant={created ? "primary" : "secondary"} onClick={onClose} data-testid="gateway-tool-setup-done">Done</DenButton>
      </div>
    </div>
  );
}

/**
 * The key the steps use: one created right here (shown once, then filled into
 * every step), or a note to use one made before.
 */
function ApiKeyStep({ tool, enabled, created, onCreated }: {
  tool: Tool;
  enabled: boolean;
  created: CreatedGatewayApiKey | null;
  onCreated: (key: CreatedGatewayApiKey) => void;
}) {
  const create = useCreateGatewayApiKey();

  async function createKey() {
    try {
      onCreated(await create.mutateAsync({ name: tool.id === "other" ? "My tool" : tool.name, expiresAt: expiryFromDays(DEFAULT_GATEWAY_API_KEY_EXPIRY) }));
    } catch {
      // Shown below from the mutation's error.
    }
  }

  if (created) {
    return (
      <div className="flex flex-col gap-1.5" data-testid="gateway-tool-setup-key">
        <span className="flex items-center justify-between gap-2 text-[12px]">
          <span className="font-medium text-gray-900">API key, shown once</span>
          <span className="text-gray-500">{`${created.apiKey.name} · ${formatExpiry(created.apiKey.expiresAt)}`}</span>
        </span>
        <CopyField value={created.key} label="Copy API key" testId="gateway-tool-setup-key-secret" />
        <span className="text-[12px] text-gray-500">It&apos;s filled into the steps below.</span>
      </div>
    );
  }

  if (!enabled) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg bg-gray-50 px-3 py-2.5 text-[13px] text-gray-600" data-testid="gateway-tool-setup-locked">
        <Lock size={12} aria-hidden="true" />
        Turned off by your organization. An admin can allow 3rd party tools in AI Gateway › API Keys.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 rounded-xl bg-gray-50 px-3 py-2.5" data-testid="gateway-tool-setup-key">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-white text-gray-500"><KeyRound size={14} aria-hidden /></span>
        <span className="min-w-0 flex-1 text-[13px] leading-5 text-gray-600">
          <b className="font-medium text-gray-900">{`A key for ${tool.id === "other" ? "your tool" : tool.name}`}</b>
          <span className="block text-[12px] text-gray-500">Or use one you already made.</span>
        </span>
        <DenButton size="sm" icon={Plus} loading={create.isPending} onClick={() => void createKey()} data-testid="gateway-tool-setup-create-key">
          Create key
        </DenButton>
      </div>
      {create.error ? <p className="text-[12px] text-red-600" role="alert">{create.error.message}</p> : null}
    </div>
  );
}
