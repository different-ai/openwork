/** @jsxImportSource react */
import { useRef, useState } from "react";
import type { Agent } from "@opencode-ai/sdk/v2/client";

import type { CloudImportedPlugin } from "@/app/cloud/import-state";
import { createDenClient, readDenSettings } from "@/app/lib/den";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { ComposerAttachment, McpServerEntry, McpStatusMap, ModelOption, ModelRef, SkillCard, SlashCommandOption } from "@/app/types";
import { t } from "@/i18n";
import type { ComposerSettingsSection } from "@/react-app/domains/settings/library";
import { ReactSessionComposer } from "@/react-app/domains/session/surface/composer/composer";
import { WorkspaceRunModeMenu } from "@/react-app/domains/session/surface/composer/workspace-run-mode-menu";
import { encodeComposerMentionValue, type ComposerMentionKind } from "@/react-app/domains/session/surface/composer/mention-encoding";
import {
  createPastedTextChip,
  resolvePastedTextPlaceholders,
  type PastedTextChip,
} from "@/react-app/domains/session/surface/composer/pasted-text";
import {
  loadSessionConnectCapabilities,
  readCachedConnectCapabilities,
  readCloudInventoryScope,
} from "@/react-app/domains/connections/cloud-inventory-cache";
import { connectPluginsForComposer, EMPTY_CONNECT_CAPABILITY_INVENTORY } from "@/react-app/domains/session/surface/connect-capability-inventory";
import { resolveAttachmentFileMetadata } from "@/react-app/domains/session/sync/attachment-file-part";

/**
 * Workspace-scoped wiring for the new-task composer. Everything here is
 * route-level state (default model prefs, selected agent, workspace client),
 * so choices made before the session exists carry into the session that the
 * hero creates.
 */
export type NewTaskComposerContext = {
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  selectedModel: ModelRef;
  modelOptions?: readonly ModelOption[];
  modelUnavailable?: boolean;
  modelUnavailableMessage?: string | null;
  organizationModelsEmpty?: boolean;
  onRefreshOrganizationModels?: () => void | Promise<void>;
  modelPickerOpen: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  onModelChange: (model: ModelRef, variant?: string | null) => void;
  openWorkModelsEntitled?: boolean;
  openWorkModelsSyncing?: boolean;
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
  onOpenSettingsSection?: (section: ComposerSettingsSection) => void;
};

export type NewTaskComposerProps = {
  draft: string;
  onDraftChange: (value: string) => void;
  /** Called with a non-empty draft and in-memory attachments; the caller creates the session (and workspace if needed). */
  onRunTask: (resolvedDraft: string, attachments: ComposerAttachment[]) => void;
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
 * Attachments are collected before the session exists and seeded into the
 * created session, where the normal send path uploads them into the workspace.
 */
export function NewTaskComposer(props: NewTaskComposerProps) {
  const [mentions, setMentions] = useState<Record<string, ComposerMentionKind>>({});
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [skills, setSkills] = useState<SkillCard[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>([]);
  const [mcpStatuses, setMcpStatuses] = useState<McpStatusMap>({});
  const [mcpStatus, setMcpStatus] = useState<string | null>(null);
  const [importedPlugins, setImportedPlugins] = useState<CloudImportedPlugin[]>([]);
  const [pastedText, setPastedText] = useState<PastedTextChip[]>([]);
  const skillsConnectPushRef = useRef(0);
  const mcpConnectPushRef = useRef(0);
  const pluginConnectPushRef = useRef(0);
  const context = props.context;
  const workspaceClient = context?.client ?? null;
  const workspaceId = context?.workspaceId ?? null;

  const listSkills = workspaceClient && workspaceId
    ? async (): Promise<SkillCard[]> => {
        const pushId = ++skillsConnectPushRef.current;
        // Paint cached Connect inventory instantly; the fresh fan-out lands live.
        const scope = readCloudInventoryScope();
        const cachedConnect = (scope ? readCachedConnectCapabilities(scope) : null) ?? EMPTY_CONNECT_CAPABILITY_INVENTORY;
        const connectPromise = loadSessionConnectCapabilities();
        const response = await workspaceClient.listSkills(workspaceId, { includeGlobal: true });
        const localSkills = (response.items ?? []).map((skill) => ({
          name: skill.name,
          path: skill.path,
          description: skill.description,
          trigger: skill.trigger,
          scope: skill.scope,
          origin: "local",
        } satisfies SkillCard));
        void connectPromise.then((connect) => {
          if (skillsConnectPushRef.current !== pushId) return;
          setSkills([...localSkills, ...connect.skills]);
        });
        const next = [...localSkills, ...cachedConnect.skills];
        setSkills(next);
        return next;
      }
    : undefined;

  const listMcp = workspaceClient && workspaceId
    ? async (): Promise<{ servers: McpServerEntry[]; statuses: McpStatusMap; status: string | null }> => {
        const pushId = ++mcpConnectPushRef.current;
        const scope = readCloudInventoryScope();
        const cachedConnect = (scope ? readCachedConnectCapabilities(scope) : null) ?? EMPTY_CONNECT_CAPABILITY_INVENTORY;
        const connectPromise = loadSessionConnectCapabilities();
        const response = await workspaceClient.listMcp(workspaceId);
        const localServers = (response.items ?? []).map((entry) => ({
          name: entry.name,
          config: entry.config as McpServerEntry["config"],
          source: entry.source,
          origin: entry.name === "openwork-cloud" ? "openwork-connect" : "local",
        } satisfies McpServerEntry));
        void connectPromise.then((connect) => {
          if (mcpConnectPushRef.current !== pushId) return;
          const freshServers = [...localServers, ...connect.mcpServers];
          const freshStatus = freshServers.length ? null : "No MCP servers loaded.";
          setMcpServers(freshServers);
          setMcpStatuses(connect.mcpStatuses);
          setMcpStatus(freshStatus);
        });
        const servers = [...localServers, ...cachedConnect.mcpServers];
        const statuses = cachedConnect.mcpStatuses;
        const status = servers.length ? null : "No MCP servers loaded.";
        setMcpServers(servers);
        setMcpStatuses(statuses);
        setMcpStatus(status);
        return { servers, statuses, status };
      }
    : undefined;

  const listImportedPlugins = async (): Promise<CloudImportedPlugin[]> => {
    const pushId = ++pluginConnectPushRef.current;
    const scope = readCloudInventoryScope();
    const cachedConnect = (scope ? readCachedConnectCapabilities(scope) : null) ?? EMPTY_CONNECT_CAPABILITY_INVENTORY;
    const connectPromise = loadSessionConnectCapabilities();
    void connectPromise.then((connect) => {
      if (pluginConnectPushRef.current !== pushId) return;
      setImportedPlugins(connectPluginsForComposer(connect.plugins));
    });
    const plugins = connectPluginsForComposer(cachedConnect.plugins);
    setImportedPlugins(plugins);
    return plugins;
  };

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

  const handleDraftChange = (value: string) => {
    props.onDraftChange(value);
    const idsInDraft = new Set(
      [...value.matchAll(/\[attachment ([^\]]+)\]/g)].map((match) => match[1]).filter((id): id is string => Boolean(id)),
    );
    setAttachments((current) => {
      const retained = current.filter((attachment) => idsInDraft.has(attachment.id));
      if (retained.length === current.length) return current;
      for (const attachment of current) {
        if (!idsInDraft.has(attachment.id)) revokeAttachmentPreview(attachment);
      }
      return retained;
    });
  };

  const handleAttachFiles = (files: File[]) => {
    if (!files.length) return;
    const next: ComposerAttachment[] = files.map((file) => {
      const metadata = resolveAttachmentFileMetadata(file);
      return {
        id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        name: file.name,
        mimeType: metadata.mime,
        size: file.size,
        kind: metadata.kind,
        file,
        previewUrl: metadata.kind === "image" ? URL.createObjectURL(file) : undefined,
      };
    });
    setAttachments((current) => [...current, ...next]);
    props.onDraftChange(`${props.draft}${next.map((attachment) => `[attachment ${attachment.id}]`).join("")}`);
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target) revokeAttachmentPreview(target);
      return current.filter((item) => item.id !== id);
    });
    props.onDraftChange(props.draft.replaceAll(`[attachment ${id}]`, ""));
  };

  const handleRunTask = () => {
    props.onRunTask(resolvePastedTextPlaceholders(props.draft, pastedText), attachments);
  };

  const handleUnsupportedFileLinks = (links: string[]) => {
    if (!links.length) return;
    props.onDraftChange(`${props.draft}${props.draft && !props.draft.endsWith("\n") ? "\n" : ""}${links.join("\n")}`);
  };

  return (
    <ReactSessionComposer
      runModeControl={<WorkspaceRunModeMenu client={workspaceClient} workspaceId={workspaceId} busy={props.busy} />}
      draft={props.draft}
      mentions={mentions}
      onDraftChange={handleDraftChange}
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
      organizationModelsEmpty={context?.organizationModelsEmpty}
      statusLabel=""
      modelPickerOpen={context?.modelPickerOpen ?? false}
      selectedModel={context?.selectedModel ?? FALLBACK_MODEL}
      modelOptions={context?.modelOptions}
      openWorkModelsEntitled={context?.openWorkModelsEntitled}
      openWorkModelsSyncing={context?.openWorkModelsSyncing}
      onRefreshOrganizationModels={context?.onRefreshOrganizationModels}
      onModelPickerOpenChange={context?.onModelPickerOpenChange ?? noop}
      onModelChange={context?.onModelChange ?? noop}
      attachments={attachments}
      attachmentsUploading={props.busy && attachments.length > 0}
      onAttachFiles={handleAttachFiles}
      onRemoveAttachment={handleRemoveAttachment}
      attachmentsEnabled
      attachmentsDisabledReason={null}
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
      listImportedPlugins={listImportedPlugins}
      importedPlugins={importedPlugins}
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

function revokeAttachmentPreview(attachment: { previewUrl?: string | undefined }) {
  if (!attachment.previewUrl) return;
  URL.revokeObjectURL(attachment.previewUrl);
}
