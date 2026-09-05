/** @jsxImportSource react */
import { ArrowUp, FileText, GripVertical, ListPlus, X } from "lucide-react";
import { Fragment, useRef, useState, type DragEvent, type ReactNode } from "react";

import { ImageAttachmentBadge } from "@/components/chat/image-attachment-badge";
import { t } from "@/i18n";
import type { ComposerAttachment, ComposerDraft, ComposerPart } from "@/app/types";
import { parseConnectSkillToken } from "@/react-app/domains/session/surface/composer/connect-skill-token";
import { parseConnectorToken } from "@/react-app/domains/session/surface/composer/connector-token";
import type { QueuedComposerItem } from "@/react-app/domains/session/surface/composer-state-store";

export type QueuedMessagesPanelProps = {
  items: QueuedComposerItem[];
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onEdit: (id: string, text: string) => void;
  sending?: boolean;
};

const TOKEN_RE = /(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[connect-skill [^\]]+\]|\[skill [^\]]+\]|\[connector [^\]]+\])/;

function isImageAttachment(attachment: ComposerAttachment) {
  return attachment.kind === "image" || attachment.mimeType.startsWith("image/");
}

function pastedLines(parts: ComposerPart[], label: string) {
  for (const part of parts) {
    if (part.type === "paste" && part.label === label) return part.lines;
  }
  return 1;
}

function QueuedDraftContent(props: { draft: ComposerDraft }) {
  const attachmentsById = new Map(props.draft.attachments.map((attachment) => [attachment.id, attachment]));
  const text = props.draft.text;
  if (!text.trim() && props.draft.attachments.length > 0) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {props.draft.attachments.map((attachment) => (
          <QueuedAttachmentChip key={attachment.id} attachment={attachment} />
        ))}
      </span>
    );
  }

  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const segment of text.split(TOKEN_RE)) {
    if (!segment) continue;
    const key = `${offset}:${segment}`;
    offset += segment.length;

    const attachmentMatch = segment.match(/^\[attachment (.+)\]$/);
    if (attachmentMatch?.[1]) {
      const attachment = attachmentsById.get(attachmentMatch[1]);
      if (attachment) {
        nodes.push(<QueuedAttachmentChip key={key} attachment={attachment} />);
        continue;
      }
    }

    const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
    if (pasteMatch?.[1]) {
      const lines = pastedLines(props.draft.parts, pasteMatch[1]);
      nodes.push(
        <span
          key={key}
          className="mx-0.5 inline-flex items-center rounded-full border border-amber-6/35 bg-amber-3/15 px-2.5 py-1 text-xs font-medium text-amber-11 align-middle"
          title={`Pasted text · ${pasteMatch[1]}`}
        >
          {`Pasted · ${lines} line${lines === 1 ? "" : "s"}`}
        </span>,
      );
      continue;
    }

    const connectSkill = parseConnectSkillToken(segment);
    const skillMatch = segment.match(/^\[skill (.+)\]$/);
    const skillName = connectSkill?.slug ?? skillMatch?.[1];
    if (skillName) {
      nodes.push(
        <span
          key={key}
          className="mx-0.5 inline-flex items-center rounded-full border border-violet-6/35 bg-violet-3/20 px-2.5 py-1 text-xs font-medium text-violet-11 align-middle"
          title={`Skill: ${connectSkill?.name ?? skillName}`}
        >
          {`/${skillName}`}
        </span>,
      );
      continue;
    }

    const connectorName = parseConnectorToken(segment);
    if (connectorName) {
      nodes.push(
        <span
          key={key}
          className="mx-0.5 inline-flex items-center rounded-full border border-blue-6/35 bg-blue-3/20 px-2.5 py-1 text-xs font-medium text-blue-11 align-middle"
          title={`Connector: ${connectorName}`}
        >
          {connectorName}
        </span>,
      );
      continue;
    }

    nodes.push(
      <Fragment key={key}>{segment}</Fragment>,
    );
  }

  if (nodes.length === 0) {
    return (
      <span className="text-gray-10">
        {t("composer.queued_attachments_only", { count: props.draft.attachments.length })}
      </span>
    );
  }

  return <span className="inline">{nodes}</span>;
}

function QueuedAttachmentChip(props: { attachment: ComposerAttachment }) {
  if (isImageAttachment(props.attachment) && props.attachment.previewUrl) {
    return (
      <ImageAttachmentBadge
        src={props.attachment.previewUrl}
        alt={props.attachment.name}
        className="mx-0.5 align-middle"
      />
    );
  }

  return (
    <span
      className="mx-0.5 inline-flex h-10 max-w-[140px] items-center gap-1.5 rounded-xl border border-border/70 bg-muted/40 px-2 align-middle"
      title={props.attachment.name}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-[11px] font-medium text-foreground">{props.attachment.name}</span>
    </span>
  );
}

function QueuedDraftRow(props: {
  item: QueuedComposerItem;
  ids: string[];
  sending?: boolean;
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onEdit: (id: string, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(props.item.draft.text);
  const draggingRef = useRef(false);

  const commitEdit = () => {
    const next = draftText.trim();
    setEditing(false);
    if (!next || next === props.item.draft.text) {
      setDraftText(props.item.draft.text);
      return;
    }
    props.onEdit(props.item.id, next);
  };

  const moveId = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const from = props.ids.indexOf(fromId);
    const to = props.ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    const next = [...props.ids];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    props.onReorder(next);
  };

  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    event.dataTransfer.setData("text/plain", props.item.id);
    event.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const fromId = event.dataTransfer.getData("text/plain");
    draggingRef.current = false;
    if (fromId) moveId(fromId, props.item.id);
  };

  return (
    <div
      draggable={!editing && !props.sending}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={() => {
        draggingRef.current = false;
      }}
      className="flex items-start gap-2 rounded-xl border border-gray-6 bg-gray-1 px-2 py-2.5"
    >
      <span
        className="mt-0.5 flex size-5 shrink-0 cursor-grab items-center justify-center text-gray-9 active:cursor-grabbing"
        title={t("composer.queued_reorder")}
        aria-hidden="true"
      >
        <GripVertical size={14} />
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            autoFocus
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            onBlur={commitEdit}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraftText(props.item.draft.text);
                setEditing(false);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                commitEdit();
              }
            }}
            className="min-h-16 w-full resize-y rounded-lg border border-gray-6 bg-gray-2 px-2 py-1.5 text-sm leading-5 text-gray-12 outline-none focus:border-gray-8"
            aria-label={t("composer.queued_edit")}
          />
        ) : (
          <button
            type="button"
            disabled={props.sending}
            onClick={() => {
              if (draggingRef.current) return;
              setDraftText(props.item.draft.text);
              setEditing(true);
            }}
            className="w-full whitespace-pre-wrap break-words rounded-md px-0.5 text-left text-sm leading-5 text-gray-11 hover:text-gray-12 disabled:pointer-events-none"
            title={t("composer.queued_edit")}
          >
            <QueuedDraftContent draft={props.item.draft} />
          </button>
        )}
      </div>
      <div className="mt-0.5 flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => props.onSendNow(props.item.id)}
          disabled={props.sending}
          className="flex size-5 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-40"
          title={t("composer.queued_send_now")}
          aria-label={t("composer.queued_send_now")}
        >
          <ArrowUp size={13} />
        </button>
        <button
          type="button"
          onClick={() => props.onRemove(props.item.id)}
          disabled={props.sending}
          className="flex size-5 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-40"
          title={t("common.remove")}
          aria-label={t("common.remove")}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

/**
 * Shows the follow-up messages the user has queued while the agent is busy.
 * Each entry can be reordered, edited, sent immediately, or removed.
 */
export function QueuedMessagesPanel(props: QueuedMessagesPanelProps) {
  if (props.items.length === 0) return null;
  const ids = props.items.map((item) => item.id);

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent">
      <div className="border-b border-dls-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-5 shrink-0 items-center justify-center rounded-full border border-gray-7/40 bg-gray-3/40 text-gray-11">
            <ListPlus size={12} />
          </div>
          <div className="text-sm font-medium leading-5 text-gray-12">
            {t("composer.queued_count", { count: props.items.length })}
          </div>
        </div>
      </div>

      <div className="max-h-48 space-y-2 overflow-auto px-4 py-3">
        {props.items.map((item) => (
          <QueuedDraftRow
            key={item.id}
            item={item}
            ids={ids}
            sending={props.sending}
            onRemove={props.onRemove}
            onSendNow={props.onSendNow}
            onReorder={props.onReorder}
            onEdit={props.onEdit}
          />
        ))}
      </div>
    </div>
  );
}
