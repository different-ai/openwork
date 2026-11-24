/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

import type { EnablementResult } from "../../app/extensions";
import {
  extensionTaxonomyLabel,
  type ExtensionTaxonomy,
} from "../domains/settings/extension-taxonomy";
import { resolveExtensionIconUrl } from "./extension-icon-src";

export type ExtensionCardProps = {
  name: string;
  description: string;
  iconSlug?: string;
  iconSrc?: string;
  url?: string;
  taxonomy?: ExtensionTaxonomy;
  connected?: boolean;
  enablement?: EnablementResult[];
  connecting?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  disabledReason?: string | null;
  nextActionLabel?: string;
  onNextAction?: () => void;
  onClick?: () => void;
  statusChip?: { label: string; tone: "attention" | "setup" };
  trailing?: ReactNode;
};

type ReadinessState = "ready" | "partial" | "none";

function ExtensionIcon(props: {
  name: string;
  iconSrc: string | null;
  connecting: boolean;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-dls-hover">
      {props.connecting ? (
        <Loader2 size={15} className="animate-spin text-dls-secondary" />
      ) : props.iconSrc && failedSrc !== props.iconSrc ? (
        <div className="flex size-5 items-center justify-center rounded-md bg-white">
          <img src={props.iconSrc} alt="" width={16} height={16} loading="lazy" style={{ display: "block" }} onError={() => setFailedSrc(props.iconSrc)} />
        </div>
      ) : <span aria-hidden className="text-[13px] font-medium text-muted-foreground">{props.name.trim().charAt(0).toUpperCase()}</span>}
    </div>
  );
}

export function ExtensionCard(props: ExtensionCardProps) {
  const {
    name,
    description,
    iconSlug,
    iconSrc,
    url,
    taxonomy = "mcp",
    connected: connectedProp = false,
    enablement,
    connecting = false,
    disabled = false,
    hidden = false,
    disabledReason = null,
    nextActionLabel,
    onNextAction,
    onClick,
  } = props;

  const allMet = enablement ? enablement.every((r) => r.met) : connectedProp;
  const someMet = enablement ? enablement.some((r) => r.met) && !allMet : false;
  const readiness: ReadinessState = allMet ? "ready" : someMet ? "partial" : "none";
  const resolvedIconSrc = resolveExtensionIconUrl({ iconSrc, iconSlug, serviceUrl: url }) ?? null;
  const summary = disabledReason ?? description;

  return (
    <div className="group flex h-[52px] w-full items-center gap-3" data-library-integrated-row>
      <button type="button" disabled={disabled || connecting} onClick={onClick} data-library-row={name} title={summary || undefined} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ExtensionIcon name={name} iconSrc={resolvedIconSrc} connecting={connecting} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
          <span data-library-description className="truncate text-xs text-muted-foreground">{summary || extensionTaxonomyLabel(taxonomy)}</span>
        </span>
      </button>
      <span data-library-status className="w-14 shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground">{hidden ? "Hidden" : disabledReason ? "Blocked" : props.statusChip?.label ?? (readiness === "ready" ? "Ready" : "Set up")}</span>
      <span data-library-action className="flex min-w-[72px] shrink-0 items-center justify-end gap-1">
        {!disabledReason && !connecting && nextActionLabel ? <Button variant="outline" size="icon-sm" aria-label={nextActionLabel} onClick={() => (onNextAction ? onNextAction() : onClick?.())}><ArrowRight data-icon="inline-start" /></Button> : null}
        {props.trailing}
      </span>
    </div>
  );
}
