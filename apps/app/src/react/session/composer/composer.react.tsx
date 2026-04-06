/** @jsxImportSource react */
import { useEffect, useState } from "react";
import type { Agent } from "@opencode-ai/sdk/v2/client";
import fuzzysort from "fuzzysort";
import type { ComposerAttachment, PromptMode } from "../../../app/types";
import { LexicalPromptEditor } from "./editor.react";
import type { SlashCommandOption } from "../../../app/types";
import { ReactComposerNotice, type ReactComposerNotice as ReactComposerNoticeData } from "./notice.react";

type MentionItem = {
  id: string;
  kind: "agent" | "file";
  value: string;
  label: string;
};

type ComposerProps = {
  draft: string;
  mentions: Record<string, "agent" | "file">;
  onDraftChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  busy: boolean;
  disabled: boolean;
  statusLabel: string;
  modelLabel: string;
  onModelClick: () => void;
  mode: PromptMode;
  onModeChange: (mode: PromptMode) => void;
  attachments: ComposerAttachment[];
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  attachmentsEnabled: boolean;
  attachmentsDisabledReason: string | null;
  modelVariantLabel: string;
  modelVariant: string | null;
  modelBehaviorOptions?: { value: string | null; label: string }[];
  onModelVariantChange: (value: string | null) => void;
  agentLabel: string;
  selectedAgent: string | null;
  listAgents: () => Promise<Agent[]>;
  onSelectAgent: (agent: string | null) => void;
  listCommands: () => Promise<SlashCommandOption[]>;
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
  onInsertMention: (kind: "agent" | "file", value: string) => void;
  notice: ReactComposerNoticeData | null;
  onNotice: (notice: ReactComposerNoticeData) => void;
};

export function ReactSessionComposer(props: ComposerProps) {
  let fileInput: HTMLInputElement | undefined;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [commands, setCommands] = useState<SlashCommandOption[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);

  const slashMatch = props.mode === "prompt" ? props.draft.match(/^\/(\S*)$/) : null;
  const slashQuery = slashMatch?.[1] ?? "";
  const mentionMatch = props.mode === "prompt" ? props.draft.match(/@([^\s@]*)$/) : null;
  const mentionQuery = mentionMatch?.[1] ?? "";

  useEffect(() => {
    setSlashOpen(Boolean(slashMatch));
  }, [slashMatch]);

  useEffect(() => {
    setMentionOpen(Boolean(mentionMatch));
  }, [mentionMatch]);

  useEffect(() => {
    if (!agentMenuOpen) return;
    void props.listAgents().then(setAgents).catch(() => setAgents([]));
  }, [agentMenuOpen, props]);

  useEffect(() => {
    if (!slashOpen) return;
    void props.listCommands().then(setCommands).catch(() => setCommands([]));
  }, [slashOpen, props]);

  useEffect(() => {
    if (!mentionOpen) return;
    let cancelled = false;
    void Promise.all([props.listAgents(), props.searchFiles(mentionQuery)]).then(([agentList, files]) => {
      if (cancelled) return;
      const recent = props.recentFiles.slice(0, 8);
      const next: MentionItem[] = [
        ...agentList.map((agent) => ({ id: `agent:${agent.name}`, kind: "agent" as const, value: agent.name, label: agent.name })),
        ...recent.map((file) => ({ id: `file:${file}`, kind: "file" as const, value: file, label: file })),
        ...files.filter((file) => !recent.includes(file)).map((file) => ({ id: `file:${file}`, kind: "file" as const, value: file, label: file })),
      ];
      setMentionItems(next);
    }).catch(() => {
      if (!cancelled) setMentionItems([]);
    });
    return () => {
      cancelled = true;
    };
  }, [mentionOpen, mentionQuery, props]);

  const slashFiltered = !slashOpen
    ? []
    : slashQuery
      ? fuzzysort.go(slashQuery, commands, { keys: ["name", "description"] }).map((entry) => entry.obj).slice(0, 8)
      : commands.slice(0, 8);
  const mentionFiltered = !mentionOpen
    ? []
    : mentionQuery
      ? fuzzysort.go(mentionQuery, mentionItems, { keys: ["label"] }).map((entry) => entry.obj).slice(0, 8)
      : mentionItems.slice(0, 8);

  return (
    <div className="mx-auto w-full max-w-[800px] px-4">
      <div className="rounded-[28px] border border-dls-border bg-dls-surface shadow-[var(--dls-card-shadow)]">
        <div className="flex items-center justify-between gap-3 border-b border-dls-border px-4 py-3">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${props.mode === "prompt" ? "border-dls-border bg-dls-hover text-dls-text" : "border-dls-border/70 bg-transparent text-dls-secondary hover:bg-dls-hover/60"}`}
              onClick={() => props.onModeChange("prompt")}
            >
              Prompt
            </button>
            <button
              type="button"
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${props.mode === "shell" ? "border-dls-border bg-dls-hover text-dls-text" : "border-dls-border/70 bg-transparent text-dls-secondary hover:bg-dls-hover/60"}`}
              onClick={() => props.onModeChange("shell")}
            >
              Shell
            </button>
            <button
              type="button"
              className="rounded-full border border-dls-border bg-dls-hover/60 px-3 py-1 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover"
              onClick={props.onModelClick}
            >
              {props.modelLabel}
            </button>
            {props.modelBehaviorOptions?.length ? (
              <select
                value={props.modelVariant ?? ""}
                className="rounded-full border border-dls-border bg-dls-hover/60 px-3 py-1 text-xs font-medium text-dls-text outline-none"
                onChange={(event) => props.onModelVariantChange(event.currentTarget.value || null)}
              >
                {props.modelBehaviorOptions.map((option) => (
                  <option key={option.value ?? "default"} value={option.value ?? ""}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : null}
            <div className="relative">
              <button
                type="button"
                className="rounded-full border border-dls-border bg-dls-hover/60 px-3 py-1 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover"
                onClick={() => setAgentMenuOpen((value) => !value)}
              >
                {props.agentLabel}
              </button>
              {agentMenuOpen ? (
                <div className="absolute left-0 top-full z-20 mt-2 w-64 rounded-2xl border border-dls-border bg-dls-surface p-2 shadow-[var(--dls-card-shadow)]">
                  <button
                    type="button"
                    className={`mb-1 w-full rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-dls-hover ${props.selectedAgent === null ? "bg-dls-hover text-dls-text" : "text-dls-secondary"}`}
                    onClick={() => {
                      props.onSelectAgent(null);
                      setAgentMenuOpen(false);
                    }}
                  >
                    Default agent
                  </button>
                  {agents.map((agent) => (
                    <button
                      key={agent.name}
                      type="button"
                      className={`w-full rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-dls-hover ${props.selectedAgent === agent.name ? "bg-dls-hover text-dls-text" : "text-dls-secondary"}`}
                      onClick={() => {
                        props.onSelectAgent(agent.name);
                        setAgentMenuOpen(false);
                      }}
                    >
                      {agent.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <input
            ref={(element) => {
              fileInput = element ?? undefined;
            }}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              if (files.length) props.onAttachFiles(files);
              event.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            className="rounded-full border border-dls-border bg-dls-hover/60 px-3 py-1 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover disabled:opacity-50"
            onClick={() => fileInput?.click()}
            disabled={!props.attachmentsEnabled}
            title={props.attachmentsDisabledReason ?? undefined}
          >
            Attach files
          </button>
        </div>
        {props.attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 border-b border-dls-border px-4 py-3">
            {props.attachments.map((attachment) => (
              <div key={attachment.id} className="flex items-center gap-2 rounded-full border border-dls-border bg-dls-hover/60 px-3 py-1.5 text-xs text-dls-text">
                <span className="max-w-[220px] truncate">{attachment.name}</span>
                <button
                  type="button"
                  className="text-dls-secondary transition-colors hover:text-dls-text"
                  onClick={() => props.onRemoveAttachment(attachment.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="relative">
          <ReactComposerNotice notice={props.notice} />
          <LexicalPromptEditor
            value={props.draft}
            mentions={props.mentions}
            disabled={props.disabled}
            placeholder="Describe your task..."
            onChange={props.onDraftChange}
            onSubmit={props.onSend}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData?.files ?? []);
              if (!files.length) return;
              event.preventDefault();
              if (!props.attachmentsEnabled) {
                props.onNotice({
                  title: props.attachmentsDisabledReason ?? "Attachments are unavailable.",
                  tone: "warning",
                });
                return;
              }
              props.onAttachFiles(files);
              props.onNotice({
                title: files.length === 1 ? `Attached ${files[0]?.name ?? "file"}` : `Attached ${files.length} files`,
                tone: "success",
              });
            }}
            onDragOver={(event) => {
              if (event.dataTransfer?.files?.length) event.preventDefault();
            }}
            onDrop={(event) => {
              const files = Array.from(event.dataTransfer?.files ?? []);
              if (!files.length) return;
              event.preventDefault();
              if (!props.attachmentsEnabled) {
                props.onNotice({
                  title: props.attachmentsDisabledReason ?? "Attachments are unavailable.",
                  tone: "warning",
                });
                return;
              }
              props.onAttachFiles(files);
              props.onNotice({
                title: files.length === 1 ? `Attached ${files[0]?.name ?? "file"}` : `Attached ${files.length} files`,
                tone: "success",
              });
            }}
          />
        </div>
        {slashOpen && slashFiltered.length > 0 ? (
          <div className="border-t border-dls-border px-3 py-2">
            <div className="grid gap-1">
              {slashFiltered.map((command) => (
                <button
                  key={command.id}
                  type="button"
                  className="rounded-xl px-3 py-2 text-left transition-colors hover:bg-dls-hover"
                  onClick={() => props.onDraftChange(`/${command.name} `)}
                >
                  <div className="text-sm font-medium text-dls-text">/{command.name}</div>
                  {command.description ? <div className="text-xs text-dls-secondary">{command.description}</div> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {mentionOpen && mentionFiltered.length > 0 ? (
          <div className="border-t border-dls-border px-3 py-2">
            <div className="grid gap-1">
              {mentionFiltered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="rounded-xl px-3 py-2 text-left transition-colors hover:bg-dls-hover"
                  onClick={() => props.onInsertMention(item.kind, item.value)}
                >
                  <div className="text-sm font-medium text-dls-text">@{item.label}</div>
                  <div className="text-xs text-dls-secondary">{item.kind === "agent" ? "Agent" : "File"}</div>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 border-t border-dls-border px-4 py-3">
          <div className="text-xs text-dls-secondary">{props.statusLabel}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-full border border-dls-border px-4 py-2 text-sm text-dls-secondary transition-colors hover:bg-dls-hover disabled:opacity-50"
              onClick={props.onStop}
              disabled={!props.busy}
            >
              Stop
            </button>
            <button
              type="button"
              className="rounded-full bg-[var(--dls-accent)] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--dls-accent-hover)] disabled:opacity-50"
              onClick={props.onSend}
              disabled={props.busy || props.disabled || !props.draft.trim()}
            >
              Run task
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
