import type { ComposerAttachment } from "@/app/types";
import type { StationThreadHandoff } from "./station-handoff";

export type StationThreadComposerInput = {
  prompt: string;
  attachments: ComposerAttachment[];
};

function attachmentId() {
  return globalThis.crypto?.randomUUID?.() ?? `station-${Date.now().toString(36)}`;
}

export function stationThreadComposerInput(
  handoff: StationThreadHandoff,
  id = attachmentId(),
): StationThreadComposerInput {
  const record = handoff.transcriptRecord;
  if (!record) return { prompt: handoff.prompt, attachments: [] };
  const file = new File([record.content], record.filename, { type: record.mimeType });
  const attachment: ComposerAttachment = {
    id,
    name: record.filename,
    mimeType: record.mimeType,
    size: file.size,
    kind: "file",
    file,
  };
  return {
    prompt: `${handoff.prompt}\n\n[attachment ${id}]`,
    attachments: [attachment],
  };
}
