"use client";

import { AUTO_ROUTER_THINKING_LABELS, autoRouterThinkingLevelSchema, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router";
import { cursorBaseUrl, cursorModelName } from "@openwork/types/den/gateway-cursor";
import { Check, Copy, Lock, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenSelect } from "../../_components/ui/select";
import { getLibraryRoute, orgFeatureEnabled } from "../../_lib/den-org";
import { markFeatureUsed } from "../../_lib/feature-usage";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useCursorSetupModels, type CursorSetupModel } from "./cursor-setup-data";
import { createOwnGatewayApiKeyRoute, useMyGatewayApiKeys } from "./gateway-api-keys-data";
import { ItemHeader, ItemPage, SectionTitle } from "./item-header";
import { ItemPanel } from "./item-list";

/**
 * Library › Models › Set up Cursor (feature `gatewayCursorSetup`): what to paste into Cursor's
 * settings to use the viewer's AI Gateway models there. Cursor only takes another provider through
 * its OpenAI key and base URL override, and each model by a typed name, so this page hands over the
 * base URL and one short name per model.
 */
export function CursorSetupScreen() {
  const { orgSlug, orgContext } = useOrgDashboard();
  const available = orgFeatureEnabled(orgContext, "gatewayMemberApiKeys") && orgFeatureEnabled(orgContext, "gatewayCursorSetup");
  const keys = useMyGatewayApiKeys(available);
  const models = useCursorSetupModels(available);
  const back = { href: `${getLibraryRoute(orgSlug)}?show=models`, label: "My Library" };

  if (!available) return <ItemPage><ItemHeader back={back} title="Not available" description="Cursor setup isn't turned on for your organization." /></ItemPage>;
  if (!keys.data && keys.isLoading) return <ItemPage><ItemHeader back={back} title="Loading..." /></ItemPage>;
  if (!keys.data) return <ItemPage><ItemHeader back={back} title="It did not load" description="Reload the page to try again." /></ItemPage>;

  const { enabled, baseUrl, apiKeys } = keys.data;
  const keyCount = apiKeys.length;

  return (
    <ItemPage testId="cursor-setup">
      <ItemHeader back={back} title="Set up Cursor" />

      {!enabled ? (
        <p className="flex items-center gap-1.5 text-[13px] text-gray-600" data-testid="cursor-setup-disabled">
          <Lock size={12} aria-hidden="true" />
          Turned off by your organization. An admin can allow 3rd party tools in AI Gateway › API Keys.
        </p>
      ) : null}

      <section className="flex flex-col gap-2.5" data-testid="cursor-setup-key">
        <SectionTitle title="1. Create an API key" />
        <ItemPanel>
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <span className="text-[13px] leading-5 text-gray-600">
              {keyCount === 0 ? "You have no API keys yet." : `You have ${keyCount} API ${keyCount === 1 ? "key" : "keys"}. A key is shown once, so create one for Cursor.`}
            </span>
            {enabled ? <DenButton size="sm" variant="secondary" icon={Plus} href={createOwnGatewayApiKeyRoute(orgSlug)} data-testid="cursor-setup-create-key">Create key</DenButton> : null}
          </div>
        </ItemPanel>
      </section>

      <section className="flex flex-col gap-2.5" data-testid="cursor-setup-base-url">
        <SectionTitle title="2. Point Cursor at OpenWork" />
        <ItemPanel>
          <Step>In Cursor, open <b className="font-medium text-gray-900">Settings › Models › API Keys</b>.</Step>
          <Step>Turn on <b className="font-medium text-gray-900">OpenAI API Key</b> and paste your key.</Step>
          <Step field={<CopyField value={cursorBaseUrl(baseUrl)} label="Copy base URL" testId="cursor-setup-base-url-value" />}>
            Turn on <b className="font-medium text-gray-900">Override OpenAI Base URL</b> and paste this:
          </Step>
        </ItemPanel>
      </section>

      <section className="flex flex-col gap-2.5" data-testid="cursor-setup-models">
        <SectionTitle title="3. Add your models" meta="In Cursor's Models settings, select Add model and paste a name" />
        <ItemPanel>
          {models.isLoading ? <p className="px-5 py-4 text-[13px] text-gray-500">Loading...</p> : null}
          {models.error ? <p className="px-5 py-4 text-[13px] text-red-600" role="alert">{models.error.message}</p> : null}
          {models.data && models.data.length === 0 ? <p className="px-5 py-4 text-[13px] text-gray-500" data-testid="cursor-setup-models-empty">Your organization hasn&apos;t given you any models yet.</p> : null}
          {(models.data ?? []).map((model) => <ModelRow key={model.modelId} model={model} />)}
        </ItemPanel>
      </section>

      <details className="group rounded-2xl border border-gray-100 bg-white" data-testid="cursor-setup-notes">
        <summary className="cursor-pointer list-none px-5 py-3 text-[13px] font-medium text-gray-700 [&::-webkit-details-marker]:hidden">Good to know</summary>
        <ul className="flex list-disc flex-col gap-2 border-t border-gray-100 py-4 pl-9 pr-5 text-[13px] leading-5 text-gray-600">
          <li>Then pick one of the models you added in Cursor&apos;s model picker.</li>
          <li>Cursor doesn&apos;t send a thinking level for models added this way. Choose one here and add that name; add the same model more than once to switch between levels.</li>
          <li>Tab completions and Cursor&apos;s own models keep using your Cursor plan.</li>
          <li>Cursor calls the base URL from its own servers, so it must be reachable from the internet.</li>
          <li>Usage counts toward your AI Gateway limit, like any other request with your key.</li>
        </ul>
      </details>
    </ItemPage>
  );
}

function Step({ children, field }: { children: ReactNode; field?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-5 py-3 text-[13px] leading-5 text-gray-600">
      <p>{children}</p>
      {field}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      // Copying a setup value is the use of this page.
      markFeatureUsed("gatewayCursorSetup");
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

function CopyField({ value, label, testId }: { value: string; label: string; testId?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5">
      <code className="min-w-0 flex-1 break-all font-mono text-[12px] leading-5 text-gray-900" data-testid={testId}>{value}</code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

function ModelRow({ model }: { model: CursorSetupModel }) {
  const [thinking, setThinking] = useState<AutoRouterThinkingLevel>("default");
  const name = cursorModelName({ name: model.name, modelId: model.modelId, thinking });
  return (
    <div className="grid grid-cols-1 items-center gap-x-4 gap-y-2 px-5 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]" data-cursor-model={model.name}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-medium leading-5 text-gray-900">{model.name}</span>
          <span className="block truncate text-[12px] leading-4 text-gray-500">{model.providerName}</span>
        </span>
        {model.thinkingLevels.length > 1 ? (
          <span className="w-44 shrink-0">
            <DenSelect
              value={thinking}
              aria-label={`Thinking level for ${model.name}`}
              onChange={(event) => {
                const level = autoRouterThinkingLevelSchema.safeParse(event.target.value);
                if (level.success) setThinking(level.data);
              }}
            >
              {model.thinkingLevels.map((level) => (
                <option key={level} value={level}>{level === "default" ? "Default thinking" : `${AUTO_ROUTER_THINKING_LABELS[level]} thinking`}</option>
              ))}
            </DenSelect>
          </span>
        ) : null}
      </div>
      <CopyField value={name} label={`Copy the Cursor name for ${model.name}`} testId="cursor-model-name" />
    </div>
  );
}
