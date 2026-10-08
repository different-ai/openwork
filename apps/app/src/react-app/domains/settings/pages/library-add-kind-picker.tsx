/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Check, FileText, LayoutGrid, Plug, Server, SquareTerminal, UserRound } from "lucide-react";

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
import { libraryConnectorIconUrls, type LibraryConnectorCue } from "../library-connector-cues";
import type { LibraryAddKind } from "../library";

const PICKER_KIND_ORDER: LibraryAddKind[] = [
  "connection",
  "mcp",
  "skill",
  "plugin",
];

type KindMeta = {
  title: string;
  description: string;
  icon: typeof FileText;
};

function kindMeta(kind: LibraryAddKind): KindMeta {
  switch (kind) {
    case "skill":
      return { title: t("extensions.kind_skill"), description: t("extensions.kind_skill_hint"), icon: FileText };
    case "command":
      return { title: t("extensions.kind_command"), description: t("extensions.kind_command_hint"), icon: SquareTerminal };
    case "agent":
      return { title: t("extensions.kind_agent"), description: t("extensions.kind_agent_hint"), icon: UserRound };
    case "plugin":
      return { title: t("extensions.kind_plugin"), description: t("extensions.kind_plugin_hint"), icon: LayoutGrid };
    case "mcp":
      return { title: t("extensions.kind_mcp"), description: t("extensions.empty_mcp_hint"), icon: Server };
    case "workspace-mcp":
      return { title: t("extensions.kind_workspace_mcp"), description: t("extensions.kind_workspace_mcp_hint"), icon: Server };
    case "connection":
      return { title: t("extensions.kind_connector"), description: t("extensions.kind_connector_hint"), icon: Plug };
  }
}

function KindOptionRow(props: {
  kind: LibraryAddKind;
  selected: boolean;
  onSelect: () => void;
  onChoose: () => void;
  connectorCues: LibraryConnectorCue[];
}) {
  const meta = kindMeta(props.kind);
  const Icon = meta.icon;
  const showCues = (props.kind === "connection" || props.kind === "mcp") && props.connectorCues.length > 0;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      data-kind={props.kind}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left transition-colors",
        props.selected ? "bg-dls-hover" : "bg-transparent hover:bg-dls-hover/60",
      )}
      onClick={props.onSelect}
      onDoubleClick={props.onChoose}
    >
      <span
        className={cn(
          "flex size-[17px] shrink-0 items-center justify-center rounded-full",
          props.selected ? "bg-foreground text-background" : "border-[1.5px] border-dls-border bg-transparent",
        )}
      >
        {props.selected ? <Check size={10} strokeWidth={3} /> : null}
      </span>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-dls-hover text-dls-secondary">
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span data-kind-title={props.kind} className="block text-sm font-semibold tracking-[-0.01em] text-dls-text">
          {meta.title}
        </span>
        <span className="mt-0.5 block text-[13px] leading-[18px] text-dls-secondary">
          {meta.description}
        </span>
        {showCues ? (
          <span className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5" data-testid="connection-logo-cues">
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
  const iconUrls = libraryConnectorIconUrls(cue);
  const [failed, setFailed] = useState(0);
  const iconUrl = iconUrls[failed];
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
          loading="eager"
          decoding="async"
          onError={() => setFailed((current) => current + 1)}
        />
      ) : (
        <span aria-label={`${cue.name} logo`} className="text-[10px] font-semibold uppercase text-slate-700">
          {cue.name.slice(0, 1)}
        </span>
      )}
    </span>
  );
}

/** Add to your Library: pick one kind, then Continue to its page. */
export function LibraryAddKindPicker(props: {
  open: boolean;
  kinds: LibraryAddKind[];
  connectorCues?: LibraryConnectorCue[];
  onClose: () => void;
  onSelect: (kind: LibraryAddKind) => void;
}) {
  const orderedKinds = PICKER_KIND_ORDER.filter((kind) => props.kinds.includes(kind));
  const firstKind = orderedKinds[0] ?? null;
  const [selected, setSelected] = useState<LibraryAddKind | null>(firstKind);

  useEffect(() => {
    if (!props.open) return;
    setSelected((current) => (current && props.kinds.includes(current) && PICKER_KIND_ORDER.includes(current) ? current : firstKind));
  }, [props.open, props.kinds, firstKind]);

  const choose = (kind: LibraryAddKind | null) => {
    if (!kind) return;
    props.onClose();
    props.onSelect(kind);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-h-[min(92dvh,880px)] overflow-y-auto lg:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-2xl font-semibold tracking-[-0.03em]">
            {t("extensions.add_picker_title")}
          </DialogTitle>
          <DialogDescription>{t("extensions.add_picker_hint")}</DialogDescription>
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
              onChoose={() => choose(kind)}
              connectorCues={props.connectorCues ?? []}
            />
          ))}
        </div>
        <DialogFooter>
          <p className="me-auto text-xs text-dls-secondary">{t("extensions.add_picker_footer")}</p>
          <DialogClose render={<Button variant="outline" />}>{t("common.cancel")}</DialogClose>
          <Button disabled={!selected} onClick={() => choose(selected)}>
            {t("extensions.add_picker_continue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
