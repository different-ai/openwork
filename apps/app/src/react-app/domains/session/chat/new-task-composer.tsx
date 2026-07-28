/** @jsxImportSource react */
import { useRef, useState } from "react";
import type { Agent } from "@opencode-ai/sdk/v2/client";

import { createDenClient, readDenSettings } from "@/app/lib/den";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { McpServerEntry, McpStatusMap, ModelRef, SkillCard, SlashCommandOption } from "@/app/types";
import { t } from "@/i18n";
import { ReactSessionComposer } from "@/react-app/domains/session/surface/composer/composer";
import { encodeComposerMentionValue, type ComposerMentionKind } from "@/react-app/domains/session/surface/composer/mention-encoding";
import {
  createPastedTextChip,
  resolvePastedTextPlaceholders,
  type PastedTextChip,
} from "@/react-app/domains/session/surface/composer/pasted-text";
import { loadSessionConnectCapabilities } from "@/react-app/domains/connections/cloud-inventory-cache";

/**
 * Workspace-scoped wiring for the new-task composer. Everything here is
 * route-level state (default model prefs, selected agent, workspace client),
 * so choices made before the session exists carry into the session that the
 * hero creates.
 */
export type NewTaskComposerContext = {
  client: OpenworkServerClient;
  workspaceId: string | null;
  selectedModel: ModelRef;
  modelUnavailable?: boolean;
  modelUnavailableMessage?: string | null;
  onRefreshOrganizationModels?: () => void | Promise<void>;
  modelPickerOpen: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  onModelChange: (model: ModelRef) => void;
  openWorkModelsEntitled?: boolean;
  modelVariantLabel: string;
  modelVariant: string | null;
  modelBehaviorOptions?: { value: string | null; label: string }[];
  onModelVariantChange: (value: string | null) => void;
  agentLabel: string;
  selectedAgent: string | null;
  listAgents: () => Promise<Agent[]>;
  onSelectAgent: (agent: string | null) => void;
  listCommands: () => Promise<SlashCommandOption[]>;
  searchFiles: (query: string) => Promise<string[]>;
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  onOpenSettingsSection?: (section: "commands" | "skills" | "mcps" | "plugins") => void;
};

export type NewTaskComposerProps = {
  draft: string;
  onDraftChange: (value: string) => void;
  /** Called with a non-empty draft; the caller creates the session (and workspace if needed). */
  onRunTask: (resolvedDraft: string) => void;
  /** Disable submission while a default workspace is being prepared. */
  busy: boolean;
  context: NewTaskComposerContext | null;
};

const noop = () => {};
const emptyAgents = async (): Promise<Agent[]> => [];
const emptyCommands = async (): Promise<SlashCommandOption[]> => [];
const emptyFiles = async (): Promise<string[]> => [];
const FALLBACK_MODEL: ModelRef = { providerID: "", modelID: "" };

/**
 * The real session composer, reused for the "What do you need done?" empty
 * state. The draft (including skill/mention tokens) is seeded into the
 * created session's composer, so pills typed here survive the handoff.
 * Attachments stay disabled: they are uploaded per session, which does not
 * exist yet.
 */
export function NewTaskComposer(props: NewTaskComposerProps) {
  const [mentions, setMentions] = useState<Record<string, ComposerMentionKind>>({});
  const [skills, setSkills] = useState<SkillCard[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>([]);
  const [mcpStatuses, setMcpStatuses] = useState<McpStatusMap>({});
  const [mcpStatus, setMcpStatus] = useState<string | null>(null);
  const [pastedText, setPastedText] = useState<PastedTextChip[]>([]);
  const context = props.context;
  const workspaceId = context?.workspaceId ?? null;

  const listSkills = context && workspaceId
    ? async (): Promise<SkillCard[]> => {
        const connectPromise = loadSessionConnectCapabilities();
        const response = await context.client.listSkills(workspaceId, { includeGlobal: true });
        const localSkills = (response.items ?? []).map((skill) => ({
          name: skill.name,
          path: skill.path,
          description: skill.description,
          trigger: skill.trigger,
          scope: skill.scope,
          origin: "local",
        } satisfies SkillCard));
        const connect = await connectPromise;
        const next = [...localSkills, ...connect.skills];
        setSkills(next);
        return next;
      }
    : undefined;

  const listMcp = context && workspaceId
    ? async (): Promise<{ servers: McpServerEntry[]; statuses: McpStatusMap; status: string | null }> => {
        const connectPromise = loadSessionConnectCapabilities();
        const response = await context.client.listMcp(workspaceId);
        const localServers = (response.items ?? []).map((entry) => ({
          name: entry.name,
          config: entry.config as McpServerEntry["config"],
          source: entry.source,
          origin: entry.name === "openwork-cloud" ? "openwork-connect" : "local",
        } satisfies McpServerEntry));
        const connect = await connectPromise;
        const servers = [...localServers, ...connect.mcpServers];
        const statuses = connect.mcpStatuses;
        const status = servers.length ? null : "No MCP servers loaded.";
        setMcpServers(servers);
        setMcpStatuses(statuses);
        setMcpStatus(status);
        return { servers, statuses, status };
      }
    : undefined;

  const handleInsertMention = (kind: ComposerMentionKind, value: string) => {
    // @agent mentions switch the pending task's agent instead of inserting a
    // mention token (mirrors the session composer, #2101).
    if (kind === "agent") {
      props.onDraftChange(props.draft.replace(/@([^\s@]*)$/, ""));
      context?.onSelectAgent(value);
      return;
    }
    props.onDraftChange(props.draft.replace(/@([^\s@]*)$/, `@${encodeComposerMentionValue(value)} `));
    setMentions((previous) => ({ ...previous, [value]: kind }));
  };

  const handlePasteText = (text: string) => {
    const pasted = createPastedTextChip(text);
    setPastedText((current) => [...current, pasted]);
    props.onDraftChange(`${props.draft}[pasted text ${pasted.label}]`);
  };

  const handleExpandPastedText = (id: string) => {
    const pasted = pastedText.find((item) => item.id === id);
    if (!pasted) return;
    props.onDraftChange(props.draft.replace(`[pasted text ${pasted.label}]`, pasted.text));
    setPastedText((current) => current.filter((item) => item.id !== id));
  };

  const handleRemovePastedText = (id: string) => {
    const pasted = pastedText.find((item) => item.id === id);
    if (!pasted) return;
    props.onDraftChange(props.draft.replace(`[pasted text ${pasted.label}]`, ""));
    setPastedText((current) => current.filter((item) => item.id !== id));
  };

  const handleRunTask = () => {
    props.onRunTask(resolvePastedTextPlaceholders(props.draft, pastedText));
  };

  const handleUnsupportedFileLinks = (links: string[]) => {
    if (!links.length) return;
    props.onDraftChange(`${props.draft}${props.draft && !props.draft.endsWith("\n") ? "\n" : ""}${links.join("\n")}`);
  };

  return (
    <ReactSessionComposer
      draft={props.draft}
      mentions={mentions}
      onDraftChange={props.onDraftChange}
      onSend={handleRunTask}
      onSteer={noop}
      onQueue={noop}
      onStop={noop}
      busy={false}
      steering={false}
      submissionPreparing={props.busy}
      queuedCount={0}
      disabled={Boolean(context?.modelUnavailable)}
      modelUnavailable={context?.modelUnavailable}
      modelUnavailableMessage={context?.modelUnavailableMessage}
      statusLabel=""
      modelPickerOpen={context?.modelPickerOpen ?? false}
      selectedModel={context?.selectedModel ?? FALLBACK_MODEL}
      openWorkModelsEntitled={context?.openWorkModelsEntitled}
      onRefreshOrganizationModels={context?.onRefreshOrganizationModels}
      onModelPickerOpenChange={context?.onModelPickerOpenChange ?? noop}
      onModelChange={context?.onModelChange ?? noop}
      attachments={[]}
      onAttachFiles={noop}
      onRemoveAttachment={noop}
      attachmentsEnabled={false}
      attachmentsDisabledReason="Attachments become available once the task starts."
      modelVariantLabel={context?.modelVariantLabel ?? ""}
      modelVariant={context?.modelVariant ?? null}
      modelBehaviorOptions={context?.modelBehaviorOptions}
      onModelVariantChange={context?.onModelVariantChange ?? noop}
      agentLabel={context?.agentLabel ?? t("session.default_agent")}
      selectedAgent={context?.selectedAgent ?? null}
      listAgents={context?.listAgents ?? emptyAgents}
      onSelectAgent={context?.onSelectAgent ?? noop}
      listCommands={context?.listCommands ?? emptyCommands}
      listSkills={listSkills}
      skills={skills}
      listMcp={listMcp}
      mcpServers={mcpServers}
      mcpStatus={mcpStatus}
      mcpStatuses={mcpStatuses}
      onOpenSettingsSection={context?.onOpenSettingsSection}
      recentFiles={[]}
      searchFiles={context?.searchFiles ?? emptyFiles}
      onInsertMention={handleInsertMention}
      onPasteText={handlePasteText}
      onUnsupportedFileLinks={handleUnsupportedFileLinks}
      pastedText={pastedText}
      onExpandPastedText={handleExpandPastedText}
      onRemovePastedText={handleRemovePastedText}
      isRemoteWorkspace={context?.isRemoteWorkspace ?? false}
      isSandboxWorkspace={context?.isSandboxWorkspace ?? false}
      onUploadInboxFiles={null}
      // The hero owns its own page padding, so the composer must fill the hero column and line up with the suggestion cards.
      flush
      draftScopeKey={`new-task:${workspaceId ?? "chat-first"}`}
    />
  );
}
