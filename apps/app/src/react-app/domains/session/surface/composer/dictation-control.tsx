/** @jsxImportSource react */
import { ChevronDown, Copy, LoaderCircle, Mic, Trash2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { DICTATION_RECENT_LIMIT, useDictationStore, type DictationTranscript } from "./dictation-store";
import type { DictationStatus } from "./use-dictation";

async function copyTranscript(transcript: DictationTranscript) {
  try {
    await navigator.clipboard.writeText(transcript.text);
    toast.success(t("composer.dictation_copied"));
  } catch {
    toast.error(t("composer.dictation_copy_failed"));
  }
}

function TranscriptItem(props: { transcript: DictationTranscript }) {
  return (
    <DropdownMenuItem onClick={() => void copyTranscript(props.transcript)} title={props.transcript.text}>
      <Copy />
      <span className="min-w-0 flex-1 truncate">{props.transcript.text}</span>
    </DropdownMenuItem>
  );
}

export function DictationControl(props: { status: DictationStatus; disabled: boolean; onToggle: () => void }) {
  const transcripts = useDictationStore((state) => state.transcripts);
  const clearStash = useDictationStore((state) => state.clearStash);
  const recent = transcripts.slice(0, DICTATION_RECENT_LIMIT);
  const stashed = transcripts.slice(DICTATION_RECENT_LIMIT);
  const recording = props.status === "recording";
  const transcribing = props.status === "transcribing";
  const label = recording
    ? t("composer.dictation_stop")
    : transcribing
      ? t("composer.dictation_transcribing")
      : t("composer.dictation_start");

  return (
    <div data-composer-dictation className="flex shrink-0 items-center">
      <button
        type="button"
        className={cn(
          "inline-flex h-9 max-h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50",
          recording ? "bg-red-3 text-red-11 hover:bg-red-4" : "text-gray-10 hover:bg-gray-3 hover:text-gray-12",
        )}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onToggle}
        disabled={transcribing || (props.disabled && !recording)}
        aria-pressed={recording}
        aria-label={label}
        title={label}
      >
        {transcribing ? <LoaderCircle size={16} className="animate-spin" /> : <Mic size={16} className={recording ? "animate-pulse" : ""} />}
      </button>
      {transcripts.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex h-9 max-h-9 w-5 shrink-0 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
            aria-label={t("composer.dictation_history")}
            title={t("composer.dictation_history")}
          >
            <ChevronDown size={13} />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-80">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("composer.dictation_recent")}</DropdownMenuLabel>
              {recent.map((transcript) => <TranscriptItem key={transcript.id} transcript={transcript} />)}
            </DropdownMenuGroup>
            {stashed.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>{t("composer.dictation_stashed", { count: stashed.length })}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-80">
                    {stashed.map((transcript) => <TranscriptItem key={transcript.id} transcript={transcript} />)}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={clearStash}>
                      <Trash2 />
                      {t("composer.dictation_clear_stash")}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
