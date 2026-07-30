/** @jsxImportSource react */
import { ArrowUp, FileText, ListPlus, X } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { ImageAttachmentBadge } from "@/components/chat/image-attachment-badge";
import { t } from "@/i18n";
import type { ComposerAttachment, ComposerDraft, ComposerPart } from "@/app/types";
import { parseConnectSkillToken } from "@/react-app/domains/session/surface/composer/connect-skill-token";

export type QueuedMessagesPanelProps = {
  drafts: ComposerDraft[];
  onRemove: (index: number) => void;
  onSendNow: (index: number) => void;
  sending?: boolean;
};

const TOKEN_RE = /(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[connect-skill [^\]]+\]|\[skill [^\]]+\])/;

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

/**
 * Shows the follow-up messages the user has queued while the agent is busy.
 * Rendered above the composer (mirrors the QuestionPanel header style). Each
 * entry can be sent immediately (arrow up) or removed (X).
 */
export function QueuedMessagesPanel(props: QueuedMessagesPanelProps) {
  if (props.drafts.length === 0) return null;

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent">
      <div className="border-b border-dls-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-5 shrink-0 items-center justify-center rounded-full border border-gray-7/40 bg-gray-3/40 text-gray-11">
            <ListPlus size={12} />
          </div>
          <div className="text-sm font-medium leading-5 text-gray-12">
            {t("composer.queued_count", { count: props.drafts.length })}
          </div>
        </div>
      </div>

      <div className="max-h-48 space-y-2 overflow-auto px-4 py-3">
        {props.drafts.map((draft, index) => (
            <div
              key={index}
              className="flex items-start justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-5 text-gray-11">
                <QueuedDraftContent draft={draft} />
              </div>
              <div className="mt-0.5 flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => props.onSendNow(index)}
                  disabled={props.sending}
                  className="flex size-5 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-40"
                  title={t("composer.queued_send_now")}
                  aria-label={t("composer.queued_send_now")}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => props.onRemove(index)}
                  disabled={props.sending}
                  className="flex size-5 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-40"
                  title={t("common.remove")}
                  aria-label={t("common.remove")}
                >
                  <X size={13} />
                </button>
              </div>
            </div>
        ))}
      </div>
    </div>
  );
}
