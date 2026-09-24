/** @jsxImportSource react */
import { ChevronRight, Loader2, MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { resolveExtensionIconUrl } from "@/react-app/design-system/extension-icon-src";
import { ExtensionMeshAvatar } from "@/react-app/design-system/extension-mesh-avatar";
import type { GatewayConnectProvider } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { gatewayConnectProviderKey } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { t } from "../../../../i18n";
import { type LibraryModelProvider, modelCountLabel } from "../library-models";
import { LibraryPage } from "./library-page";

export function ModelProviderIcon(props: { provider: Pick<LibraryModelProvider, "name" | "iconSlug">; size?: number }) {
  const size = props.size ?? 20;
  const src = props.provider.iconSlug ? resolveExtensionIconUrl({ iconSlug: props.provider.iconSlug }) : null;
  return src
    ? <img src={src} alt="" width={size} height={size} className="block" />
    : <ExtensionMeshAvatar name={props.provider.name} category="model" className="size-6 rounded-md" />;
}

function stateLine(provider: LibraryModelProvider, waiting: boolean) {
  if (waiting) return t("extensions.model_state_waiting");
  if (provider.state === "needs_signin") return t("extensions.model_state_not_signed_in", { name: signInBrand(provider) });
  if (provider.state === "api_key") return t("extensions.model_state_api_key");
  if (provider.section === "mac") return t("extensions.model_state_local");
  return t("extensions.model_state_ready");
}

/**
 * A model provider's page in the Library: whether it is ready, the one thing
 * to do about it, and every model it gives the person.
 */
export function LibraryModelPage(props: {
  provider: LibraryModelProvider;
  signingInKey: string | null;
  onBack: () => void;
  onSignIn?: (provider: GatewayConnectProvider) => void;
  onCancelSignIn?: () => void;
  onRemove?: (providerId: string) => void;
}) {
  const { provider } = props;
  const pending = provider.pending[0] ?? null;
  const waiting = pending !== null && props.signingInKey === gatewayConnectProviderKey(pending);
  const headerAction = waiting ? (
    <Button variant="outline" size="sm" onClick={props.onCancelSignIn}>{t("common.cancel")}</Button>
  ) : pending && props.onSignIn ? (
    <Button size="sm" onClick={() => props.onSignIn?.(pending)}>{t("extensions.model_sign_in_with", { name: signInBrand(provider) })}</Button>
  ) : provider.state === "api_key" && props.onRemove ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="icon-sm" aria-label={t("extensions.row_menu_label", { name: provider.name })} />}
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuItem variant="destructive" onClick={() => props.onRemove?.(provider.providerId)}>{t("extensions.row_menu_delete")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <LibraryPage
      testId="library-model-page"
      title={provider.name}
      icon={<ModelProviderIcon provider={provider} />}
      headerAction={headerAction}
      subtitleNode={(
        <span className="inline-flex items-center gap-1.5" data-testid="library-model-state">
          {waiting ? <Loader2 size={11} className="animate-spin" /> : <span className={`size-1.5 rounded-full ${provider.state === "needs_signin" ? "bg-dls-border" : "bg-green-9"}`} />}
          {stateLine(provider, waiting)}
        </span>
      )}
      onBack={props.onBack}
    >
      <section className="flex flex-col gap-2" data-testid="library-model-list">
        <h2 className="text-[13px] text-dls-secondary">{modelCountLabel(provider.models.length)}</h2>
        <div className="overflow-hidden rounded-xl border border-dls-border bg-dls-surface [&>div+div]:border-t [&>div+div]:border-dls-border/60">
          {provider.models.map((model) => {
            const src = model.vendorIconSlug ? resolveExtensionIconUrl({ iconSlug: model.vendorIconSlug }) : null;
            return (
              <div key={model.id} className="flex items-center gap-3 px-4 py-2.5" data-testid="library-model-row">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dls-border bg-white">
                  {src ? <img src={src} alt="" width={14} height={14} className="block" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-dls-text">{model.name}</span>
                <span className="shrink-0 text-xs text-dls-secondary">{model.vendor}</span>
              </div>
            );
          })}
        </div>
      </section>
      <details className="group rounded-xl border border-dls-border bg-dls-surface">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-[13px] text-dls-text [&::-webkit-details-marker]:hidden">
          {t("extensions.model_technical_details")}
          <ChevronRight size={14} className="text-dls-secondary transition-transform group-open:rotate-90" />
        </summary>
        <dl className="flex flex-col gap-1.5 border-t border-dls-border/60 px-4 py-3 text-xs text-dls-secondary">
          <div className="flex justify-between gap-4"><dt>{t("extensions.model_technical_provider")}</dt><dd className="text-dls-text">{provider.sourceProviderId}</dd></div>
          <div className="flex justify-between gap-4"><dt>{t("extensions.model_technical_runtime_id")}</dt><dd className="text-dls-text">{provider.providerId}</dd></div>
          {provider.pending.map((entry) => (
            <div key={gatewayConnectProviderKey(entry)} className="flex justify-between gap-4">
              <dt>{t("extensions.model_technical_credential_set")}</dt>
              <dd className="text-dls-text">{entry.credentialSetId ?? entry.cloudProviderId}</dd>
            </div>
          ))}
        </dl>
      </details>
    </LibraryPage>
  );
}

/** Member sign-in through the Gateway is Google today; say the brand people recognise. */
export function signInBrand(provider: Pick<LibraryModelProvider, "sourceProviderId" | "name">): string {
  return provider.sourceProviderId.startsWith("google") || provider.name.toLowerCase().includes("google") ? "Google" : provider.name;
}
