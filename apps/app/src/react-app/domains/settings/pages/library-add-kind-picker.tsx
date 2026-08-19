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
import type { LibraryAddKind } from "../library";

const MAKE_KINDS: LibraryAddKind[] = ["skill", "command", "agent", "plugin"];
const CONNECT_KINDS: LibraryAddKind[] = ["mcp", "connection"];

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
      </span>
    </button>
  );
}

function KindSection(props: {
  label: string;
  kinds: LibraryAddKind[];
  selected: LibraryAddKind;
  onSelect: (kind: LibraryAddKind) => void;
}) {
  if (props.kinds.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <p className="shrink-0 font-mono text-[11px] font-medium tracking-[0.12em] text-dls-secondary">
          {props.label}
        </p>
        <span className="h-px flex-1 bg-dls-border" />
      </div>
      <div role="radiogroup" aria-label={props.label} className="flex flex-col gap-1">
        {props.kinds.map((kind) => (
          <KindOptionRow
            key={kind}
            kind={kind}
            selected={props.selected === kind}
            onSelect={() => props.onSelect(kind)}
          />
        ))}
      </div>
    </div>
  );
}

export function LibraryAddKindPicker(props: {
  open: boolean;
  kinds: LibraryAddKind[];
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

  const makeKinds = MAKE_KINDS.filter((kind) => props.kinds.includes(kind));
  const connectKinds = CONNECT_KINDS.filter((kind) => props.kinds.includes(kind));

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
        <div className="flex flex-col gap-5">
          <KindSection
            label={t("extensions.add_picker_make")}
            kinds={makeKinds}
            selected={selected ?? makeKinds[0] ?? connectKinds[0] ?? "skill"}
            onSelect={setSelected}
          />
          <KindSection
            label={t("extensions.add_picker_connect")}
            kinds={connectKinds}
            selected={selected ?? makeKinds[0] ?? connectKinds[0] ?? "skill"}
            onSelect={setSelected}
          />
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
