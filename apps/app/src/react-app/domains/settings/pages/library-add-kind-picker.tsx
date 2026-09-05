/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Box, Check, FileText, Link2, Server, SquareTerminal, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "../../../../i18n";
import { cn } from "@/lib/utils";
import {
  libraryConnectorIconUrls,
  type LibraryConnectorCue,
} from "../library-connector-cues";
import type { LibraryAddKind } from "../library";

const PICKER_KIND_ORDER: LibraryAddKind[] = [
  "skill",
  "command",
  "agent",
  "plugin",
  "mcp",
  "workspace-mcp",
  "connection",
];

type KindMeta = {
  title: string;
  description: string;
  icon: typeof FileText;
  badge?: string;
};

function kindMeta(kind: LibraryAddKind): KindMeta {
  switch (kind) {
    case "skill":
      return {
        title: t("extensions.kind_skill"),
        description: t("extensions.kind_skill_hint"),
        icon: FileText,
      };
    case "command":
      return {
        title: t("extensions.kind_command"),
        description: t("extensions.kind_command_hint"),
        icon: SquareTerminal,
      };
    case "agent":
      return {
        title: t("extensions.kind_agent"),
        description: t("extensions.kind_agent_hint"),
        icon: UserRound,
      };
    case "plugin":
      return {
        title: t("extensions.kind_plugin"),
        description: t("extensions.kind_plugin_hint"),
        icon: Box,
      };
    case "mcp":
      return {
        title: t("extensions.kind_mcp"),
        description: t("extensions.kind_mcp_hint"),
        icon: Server,
      };
    case "workspace-mcp":
      return {
        title: t("extensions.kind_workspace_mcp"),
        description: t("extensions.kind_workspace_mcp_hint"),
        icon: Server,
      };
    case "connection":
      return {
        title: t("extensions.kind_connection"),
        description: t("extensions.kind_connection_hint"),
        icon: Link2,
        badge: t("extensions.kind_connection_badge"),
      };
  }
}

function KindOptionRow(props: {
  kind: LibraryAddKind;
  selected: boolean;
  onSelect: () => void;
  connectorCues: LibraryConnectorCue[];
}) {
  const meta = kindMeta(props.kind);
  const Icon = meta.icon;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      data-kind={props.kind}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left",
        props.selected ? "bg-dls-hover" : "bg-transparent",
      )}
      onClick={props.onSelect}
    >
      <span
        className={cn(
          "flex size-[17px] shrink-0 items-center justify-center rounded-full",
          props.selected
            ? "bg-foreground text-background"
            : "border-[1.5px] border-dls-border bg-transparent",
        )}
      >
        {props.selected ? <Check size={10} strokeWidth={3} /> : null}
      </span>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-dls-hover text-dls-secondary">
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span data-kind-title={props.kind} className="text-sm font-semibold tracking-[-0.01em] text-dls-text">
            {meta.title}
          </span>
          {meta.badge ? (
            <span className="rounded-full bg-blue-3 px-2 py-0.5 text-[11px] font-medium text-blue-11">
              {meta.badge}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-[13px] leading-[18px] text-dls-secondary">
          {meta.description}
        </span>
        {props.kind === "connection" && props.connectorCues.length > 0 ? (
          <span
            className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5"
            data-testid="connection-logo-cues"
          >
            {props.connectorCues.map((cue) => (
              <ConnectorLogoCue key={cue.id} cue={cue} />
            ))}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function ConnectorLogoCue({ cue }: { cue: LibraryConnectorCue }) {
  const [imageIndex, setImageIndex] = useState(0);
  const iconUrls = libraryConnectorIconUrls(cue);
  const iconUrl = iconUrls[imageIndex];

  useEffect(() => {
    setImageIndex(0);
  }, [cue.faviconDomain, cue.iconSlug, cue.iconSrc, cue.id, cue.serviceUrl]);

  return (
    <span
      className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-dls-border bg-white p-1 shadow-xs"
      data-connector-cue={cue.id}
      title={cue.name}
    >
      {iconUrl ? (
        <img
          src={iconUrl}
          alt={`${cue.name} logo`}
          className="size-full object-contain"
          onError={() => setImageIndex((current) => current + 1)}
        />
      ) : (
        <span
          aria-label={`${cue.name} logo`}
          className="text-[10px] font-semibold uppercase text-slate-700"
        >
          {cue.name.slice(0, 1)}
        </span>
      )}
    </span>
  );
}

export function LibraryAddKindPicker(props: {
  open: boolean;
  kinds: LibraryAddKind[];
  connectorCues?: LibraryConnectorCue[];
  onClose: () => void;
  onSelect: (kind: LibraryAddKind) => void;
}) {
  const firstKind = props.kinds[0];
  const [selected, setSelected] = useState<LibraryAddKind | null>(firstKind ?? null);

  useEffect(() => {
    if (!props.open) return;
    setSelected((current) => (
      current && props.kinds.includes(current) ? current : props.kinds[0] ?? null
    ));
  }, [props.open, props.kinds]);

  const orderedKinds = PICKER_KIND_ORDER.filter((kind) => props.kinds.includes(kind));

  const handleContinue = () => {
    if (!selected) return;
    props.onSelect(selected);
    setSelected(null);
    props.onClose();
  };

  const handleClose = () => {
    setSelected(null);
    props.onClose();
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="max-h-[min(92dvh,880px)] overflow-y-auto lg:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-2xl font-semibold tracking-[-0.03em]">
            {t("extensions.add_picker_title")}
          </DialogTitle>
          <DialogDescription>
            {t("extensions.add_picker_hint")}
          </DialogDescription>
        </DialogHeader>
        <div
          role="radiogroup"
          aria-label={t("extensions.add_picker_title")}
          className="flex min-w-0 flex-col gap-1"
          data-testid="library-add-choices"
        >
          {orderedKinds.map((kind) => (
            <KindOptionRow
              key={kind}
              kind={kind}
              selected={selected === kind}
              onSelect={() => setSelected(kind)}
              connectorCues={props.connectorCues ?? []}
            />
          ))}
        </div>
        <DialogFooter>
          <p className="me-auto text-xs text-dls-secondary">
            {t("extensions.add_picker_footer")}
          </p>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button disabled={!selected} onClick={handleContinue}>
            {t("extensions.add_picker_continue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
