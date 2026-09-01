/** @jsxImportSource react */
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import { useQuery } from "@tanstack/react-query";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";
import { Check, CirclePause, Minimize2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";

import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { createClient, unwrap } from "@/app/lib/opencode";
import { abortSessionSafe } from "@/app/lib/opencode-session";
import { composeNativeSessionSnapshot } from "@/app/lib/opencode-session-native";
import { setThemeMode } from "@/app/theme";
import { t } from "@/i18n";
import type { ComposerSettingsSection } from "@/react-app/domains/settings/library";
import { type CloudImportedPlugin } from "@/app/cloud/import-state";
import { createDenClient, readDenSettings } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { useSessionDraftState } from "@/react-app/domains/session/sync/draft-store";
import type {
  OpenworkServerClient,
  OpenworkSessionSnapshot,
} from "@/app/lib/openwork-server";
import type {
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  McpServerEntry,
  McpStatusMap,
  ModelRef,
  PendingPermission,
  PendingQuestion,
  SkillCard,
  TodoItem,
} from "@/app/types";
import {
  publishInspectorSlice,
  recordInspectorEvent,
} from "@/app/lib/app-inspector";
import { useControlAction, type OpenworkControlAction } from "@/react-app/shell/control/control-provider";
import { attemptSilentMcpReauth } from "@/react-app/domains/connections/mcp-silent-reauth";
import type {
  CloudMcpSubmissionGateState,
  CloudMcpSubmissionResult,
} from "@/react-app/domains/connections/cloud-mcp-submit-readiness";
import { ReactSessionComposer } from "./composer/composer";
import { useSessionModelSelection } from "./session-model-store";
import type { ProviderCatalog } from "./use-model-behavior";
import type { ModelAvailability } from "./model-availability";
import { decodeComposerMentionValue, encodeComposerMentionValue, type ComposerMentionKind } from "./composer/mention-encoding";
import { desktopBridge, openDesktopUrl } from "@/app/lib/desktop";
import { parseSlashCommandInvocation } from "./composer/slash-command";
import { connectSkillPrompt, parseConnectSkillToken } from "./composer/connect-skill-token";
import { createPastedTextChip, resolvePastedTextPlaceholders } from "./composer/pasted-text";
import {
  canAdmitNextQueuedItem,
  claimQueuedSend,
  dispatchQueuedDrain,
  getQueuedDrainState,
  nextObservationProbeAt,
  subscribeQueuedDrain,
} from "./queued-drain-machine";
import { DevProfiler } from "@/react-app/shell/dev-profiler";
import { PaperGrainGradient } from "@openwork/ui/react";
import { useShellConfig } from "@/react-app/shell/shell-config";
import { useReactRenderWatchdog } from "@/react-app/shell/react-render-watchdog";
import { SessionDebugPanel } from "./debug-panel";
import { deriveRenderedSessionMessages, resolveRenderedSessionSnapshot } from "./session-render-state";
import {
  ADMISSION_OUTCOME_GRACE_MS,
  createSingleFlight,
  messageHasVisibleAssistantOutput,
  resolveAdmissionOutcome,
} from "./session-admission-outcome";
import { interruptedTaskRecoveryPrompt } from "@/react-app/domains/session/sync/session-error";
import { useLocal } from "@/react-app/kernel/local-provider";
import { resolveAttachmentFileMetadata } from "@/react-app/domains/session/sync/attachment-file-part";
import { deriveSessionRenderModel } from "@/react-app/domains/session/sync/transition-controller";
import { setQueuedSendContext } from "@/react-app/domains/session/sync/queued-send-context";
import { useSessionScrollController } from "./scroll-controller";
import { SessionScrollOverlay } from "./scroll-overlay";
import { SessionFindBar } from "./find-bar";
import { useSessionFindStore } from "./find-store";
import { getSessionActivityStatusLabel, useSessionActivityStore, type SessionActivityStatus } from "@/react-app/domains/session/status/session-activity-store";
import { PermissionApprovalPanel } from "@/react-app/domains/session/chat/permission-approval-modal";
import { QuestionPanel } from "@/react-app/domains/session/modals/question-modal";
import { QueuedMessagesPanel } from "@/react-app/domains/session/modals/queued-messages-panel";
import { deriveOpenTargets, sameOpenTargets, selectAutoOpenTarget, type OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { usePanelTabStore } from "@/react-app/domains/session/panel/panel-tab-store";
import {
  markSessionSnapshotFetchStart,
  reconcileFailureDegradedThreshold,
  seedSessionState,
  snapshotKey as reactSnapshotKey,
  statusKey as reactStatusKey,
  transcriptKey as reactTranscriptKey,
  useWorkspaceSyncStreamStore,
  workspaceSyncStreamKey,
} from "@/react-app/domains/session/sync/session-sync";
import { resolveForkBoundaryId } from "@/react-app/domains/session/sync/transcript-reconcile";
import {
  claimComposerSessionDraftScope,
  composerDraftNeedsHydration,
  getComposerAttachments,
  getComposerDraft,
  getComposerHistory,
  getComposerMentions,
  getComposerPasteParts,
  getComposerQueuedDrafts,
  getComposerRevertMessageId,
  getComposerSessionDraftScope,
  persistableComposerDraftText,
  useComposerStateStore,
} from "./composer-state-store";
import { MessageList } from "@/components/chat/message-list";
import { MessageListProvider, type DispatchAction } from "@/components/chat/message-list-provider";
import type {
  ChatToolReconnectAction,
  ChatToolReconnectProgress,
  ChatToolReconnectResult,
} from "@/components/tools/error-attribution";
import { useChatMcpReconnectStore } from "@/components/tools/mcp-reconnect-state";
import { MERMAID_LIMITS } from "@/components/markdown/mermaid";
import {
  isChatMcpReconnectScopeCurrent,
  waitForFreshMcpAuthorization,
  type ChatMcpReconnectScope,
} from "./mcp-chat-reconnect";
import { OpenTargetProvider, type OpenTargetOptions } from "@/lib/target-provider";
import type { ThreadStatus } from "@/lib/messages";
import {
  EnvironmentVariableProvider,
  type ApplyEnvironmentChangesResult,
} from "@/react-app/domains/settings/pages/environment-variable-provider";
import {
  clearCloudInventoryCache,
  CLOUD_INVENTORY_CHANGED_EVENT,
  loadSessionConnectCapabilities,
  readCachedConnectCapabilities,
  readCloudInventoryScope,
} from "@/react-app/domains/connections/cloud-inventory-cache";
import { connectPluginsForComposer, EMPTY_CONNECT_CAPABILITY_INVENTORY } from "@/react-app/domains/session/surface/connect-capability-inventory";
import { consumeComposerAutoSend } from "./composer-auto-send";
import { useOrgMcpConnections } from "@/react-app/domains/connections/use-org-mcp-connections";
import { buildConnectorToolIdentities } from "@/react-app/domains/connections/connector-tool-identity";

const EMPTY_TRANSCRIPT: UIMessage[] = [];
const IDLE_STATUS: SessionStatus = { type: "idle" };
const DEFAULT_COMPOSER_CONTROL_TEXT = "Help me outline the next OpenWork task.";
const SESSION_SURFACE_SELECTOR = "[data-session-surface-id]";
const MARKDOWN_PRIMITIVE_EVAL_TEXT = `# Markdown proof heading

This shared renderer keeps **bold proof text**, inline \`renderMarkdownHtml\`, and [OpenWork link](https://openworklabs.com) readable in one message.

\`\`\`ts
const pipeline = "shared markdown primitive";
console.log(pipeline);
\`\`\`

\`\`\`mermaid
flowchart LR
  InlineStart[Inline Mermaid Start] --> InlineFinish[Inline Mermaid Finish]
\`\`\`

Search token: markdown-primitive-highlight.`;
/**
 * Staged so each proof frame adds visibly new content: inline math, then the
 * display equations, then the malformed-input and currency edge cases.
 */
const MARKDOWN_MATH_EVAL_STAGES = [
  `# Schrodinger proof heading

The time-independent form is $E\\psi = \\hat{H}\\psi$, and models often write the
same inline math as \\(i\\hbar \\frac{\\partial}{\\partial t}\\Psi\\) instead.`,
  `$$
\\hat{H} = -\\frac{\\hbar^2}{2m}\\nabla^2 + V(\\mathbf{r})
$$

The quadratic formula arrives as display math too:

\\[
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
\\]`,
  `Malformed input like $\\frac{1}{$ must not break this paragraph, and prices such
as $5 and $10 stay plain text.`,
];

type SessionError = {
  message: string;
  kind?: "model-not-found" | "generic";
  /** For model-not-found: the model that failed. */
  failedModel?: { providerID: string; modelID: string };
  /** For model-not-found: suggested replacements from the backend. */
  suggestions?: Array<{ providerID: string; modelID: string }>;
};

function createMarkdownPrimitiveEvalMessages(sessionId: string) {
  const userMessageId = `${sessionId}:eval-markdown-user`;
  const assistantMessageId = `${sessionId}:eval-markdown-assistant`;
  const guardedDiagram = [
    "flowchart TD",
    ...Array.from({ length: MERMAID_LIMITS.maxNodes + 1 }, (_, index) => `Guard${index}[Guard node ${index}]`),
  ].join("\n");
  const proofText = `${MARKDOWN_PRIMITIVE_EVAL_TEXT}

\`\`\`mermaid
flowchart LR
  Remote[No remote resources] --> Safe[Sanitized SVG]
  click Remote "https://example.com/redirect"
\`\`\`

\`\`\`mermaid
not-a-mermaid-diagram
\`\`\`

\`\`\`mermaid
${guardedDiagram}
\`\`\``;
  const messages: UIMessage[] = [
    {
      id: userMessageId,
      role: "user",
      parts: [{ type: "text", text: "Show the Markdown primitive proof message." }],
      metadata: { opencode: { created: Date.now() } },
    },
    {
      id: assistantMessageId,
      role: "assistant",
      parts: [{ type: "text", text: proofText }],
      metadata: { opencode: { created: Date.now() + 1 } },
    },
  ];

  return { messages, assistantMessageId };
}

/**
 * Dev-only deterministic transcript covering every LaTeX delimiter the renderer
 * supports, plus the malformed-input and currency cases it must leave alone.
 */
function createMarkdownMathEvalMessages(sessionId: string, stage: number) {
  const assistantMessageId = `${sessionId}:eval-math-assistant`;
  const text = MARKDOWN_MATH_EVAL_STAGES.slice(0, Math.max(1, Math.min(stage, MARKDOWN_MATH_EVAL_STAGES.length)))
    .join("\n\n");
  const messages: UIMessage[] = [
    {
      id: `${sessionId}:eval-math-user`,
      role: "user",
      parts: [{ type: "text", text: "Show the LaTeX math proof message." }],
      metadata: { opencode: { created: Date.now() } },
    },
    {
      id: assistantMessageId,
      role: "assistant",
      parts: [{ type: "text", text }],
      metadata: { opencode: { created: Date.now() + 1 } },
    },
  ];

  return { messages, assistantMessageId };
}

/**
 * Dev-only deterministic transcript exercising the Paper chat rules:
 * sentence-style capability calls, aggregated tool runs, collapsed
 * thinking, linkified bare URLs with favicons, and the FILES strip.
 */
function createChatTranscriptEvalMessages(sessionId: string) {
  const now = Date.now();
  const messages: UIMessage[] = [
    {
      id: `${sessionId}:eval-transcript-user`,
      role: "user",
      parts: [{
        type: "text",
        text: "Plan tomorrow around my calendar and check https://linear.app for open issues.",
      }],
      metadata: { opencode: { created: now } },
    },
    {
      id: `${sessionId}:eval-transcript-assistant`,
      role: "assistant",
      parts: [
        {
          type: "reasoning",
          text: "**Planning approach**\n\nCalendar first, then open issues, then draft the plan.",
          state: "done",
        },
        {
          type: "dynamic-tool",
          toolName: "openwork-cloud_execute_capability",
          toolCallId: "eval-transcript-capability",
          state: "output-available",
          input: { name: "getCapabilitiesGoogleWorkspaceCalendarEvents", body: {} },
          output: JSON.stringify({ events: 3 }),
        },
        {
          type: "dynamic-tool",
          toolName: "bash",
          toolCallId: "eval-transcript-bash-1",
          state: "output-available",
          input: { command: "git status --short", description: "Check repo state" },
          output: "",
        },
        {
          type: "dynamic-tool",
          toolName: "bash",
          toolCallId: "eval-transcript-bash-2",
          state: "output-available",
          input: { command: "pnpm typecheck", description: "Typecheck the app" },
          output: "",
        },
        {
          type: "dynamic-tool",
          toolName: "edit",
          toolCallId: "eval-transcript-edit-1",
          state: "output-available",
          input: { filePath: "/tmp/openwork-eval/plan-tomorrow.md", oldString: "", newString: "" },
          output: "",
        },
        {
          type: "dynamic-tool",
          toolName: "read",
          toolCallId: "eval-transcript-read-1",
          state: "output-available",
          input: { filePath: "/tmp/openwork-eval/meeting-notes.md" },
          output: "",
        },
        {
          type: "dynamic-tool",
          toolName: "granola_ask_about_meetings",
          toolCallId: "eval-transcript-failed",
          state: "output-error",
          input: { body: { query: "What did we decide about pricing?" } },
          errorText: "unauthorized",
        },
        {
          type: "text",
          text: "Your plan is drafted — details in [OpenWork](https://openworklabs.com). Search token: chat-transcript-proof.",
        },
      ],
      // `completed` makes the finished turn fold behind a real
      // "Worked for 1m 35s" line, like server-synced turns do.
      metadata: { opencode: { created: now + 1, completed: now + 95_001 } },
    },
  ];

  return { messages };
}

function createConnectorToolCallEvalMessages(sessionId: string): UIMessage[] {
  const now = Date.now();
  return [
    {
      id: `${sessionId}:eval-connector-user`,
      role: "user",
      parts: [{ type: "text", text: "Check my next Google Workspace calendar event." }],
      metadata: { opencode: { created: now } },
    },
    {
      id: `${sessionId}:eval-connector-assistant`,
      role: "assistant",
      parts: [{
        type: "dynamic-tool",
        toolName: "openwork-cloud_execute_capability",
        toolCallId: "eval-connector-google-workspace",
        state: "output-available",
        input: { name: "getCapabilitiesGoogleWorkspaceCalendarEvents", body: {} },
        output: JSON.stringify({ events: 1 }),
      }],
      metadata: { opencode: { created: now + 1, completed: now + 2_000 } },
    },
  ];
}

function createSessionLifecycleEvalMessages(sessionId: string): UIMessage[] {
  const now = Date.now();
  return [
    {
      id: `${sessionId}:eval-lifecycle-user`,
      role: "user",
      parts: [{ type: "text", text: "Inspect the repository state." }],
      metadata: { opencode: { created: now } },
    },
    {
      id: `${sessionId}:eval-lifecycle-assistant`,
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "bash",
          toolCallId: "eval-lifecycle-bash",
          state: "input-streaming",
          input: { command: "git status --short --branch", description: "Check repository state" },
        },
        {
          type: "dynamic-tool",
          toolName: "read",
          toolCallId: "eval-lifecycle-read",
          state: "input-streaming",
          input: { filePath: "/tmp/openwork-eval/brief.md" },
        },
      ],
      metadata: { opencode: { created: now + 1 } },
    },
  ];
}

function createSubagentActivityEvalMessages(sessionId: string): UIMessage[] {
  const now = Date.now();
  return [
    {
      id: `${sessionId}:eval-subagent-user`,
      role: "user",
      parts: [{ type: "text", text: "Build an isolated Azure reproduction." }],
      metadata: { opencode: { created: now } },
    },
    {
      id: `${sessionId}:eval-subagent-assistant`,
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "task",
          toolCallId: "eval-subagent-activity",
          state: "input-streaming",
          input: {
            description: "Build isolated Azure repro",
            prompt: "Reproduce the Azure failure in isolation.",
            subagent_type: "executor-deep",
          },
        },
      ],
      metadata: { opencode: { created: now + 1 } },
    },
  ];
}

function createChatLoadingEvalMessages(sessionId: string): UIMessage[] {
  return [{
    id: `${sessionId}:eval-chat-loading-user`,
    role: "user",
    parts: [{ type: "text", text: "Confirm the loading treatment." }],
    metadata: { opencode: { created: Date.now() } },
  }];
}

export type SessionSurfaceProps = {
  client: OpenworkServerClient;
  environmentClient?: OpenworkServerClient | null;
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  draftScope: string | null;
  isControlTarget: boolean;
  opencodeBaseUrl: string;
  openworkToken: string;
  developerMode: boolean;
  modelLabel: string;
  onModelClick: (sessionId?: string) => void;
  modelPickerOpen: boolean;
  modelUnavailable?: boolean;
  modelUnavailableMessage?: string | null;
  /**
   * Resolves availability for one provider/model identity against the active
   * workspace's settled catalogs. Each surface validates its OWN effective
   * session model with it instead of inheriting the route-global default
   * verdict; `props.modelUnavailable` is only the fallback when absent.
   */
  resolveModelAvailability?: (model: ModelRef | null) => ModelAvailability;
  organizationModelsEmpty?: boolean;
  selectedModel: ModelRef;
  /** providerID → modelID → provider model, for per-session variant options. */
  providerCatalog?: ProviderCatalog;
  /** Den/import includes OpenWork Models for this org member (not just local sync). */
  openWorkModelsEntitled?: boolean;
  /** The server is waiting to reload this workspace with OpenWork Models. */
  openWorkModelsSyncing?: boolean;
  onRefreshOrganizationModels?: () => void | Promise<void>;
  onModelPickerOpenChange: (open: boolean) => void;
  onModelChange: (model: ModelRef, variant?: string | null) => void;
  onSendDraft: (draft: ComposerDraft, sessionId: string) => Promise<CloudMcpSubmissionResult>;
  cloudMcpSubmissionState: CloudMcpSubmissionGateState;
  onOpenConnect: () => void;
  onDraftChange: (draft: ComposerDraft) => void;
  attachmentsEnabled: boolean;
  attachmentsDisabledReason: string | null;
  modelVariantLabel: string;
  modelVariant: string | null;
  modelBehaviorOptions?: { value: string | null; label: string }[];
  onModelVariantChange: (value: string | null) => void;
  agentLabel: string;
  selectedAgent: string | null;
  listAgents: () => Promise<import("@opencode-ai/sdk/v2/client").Agent[]>;
  onSelectAgent: (agent: string | null) => void;
  listCommands: () => Promise<import("@/app/types").SlashCommandOption[]>;
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  todos?: TodoItem[];
  activePermission?: PendingPermission | null;
  permissionReplyBusy?: boolean;
  respondPermission?: (requestID: string, reply: "once" | "always" | "reject") => void;
  activeQuestion?: PendingQuestion | null;
  questionReplyBusy?: boolean;
  respondQuestion?: (requestID: string, answers: string[][]) => void;
  safeStringify?: (value: unknown) => string;
  onChangeModel?: (model: { providerID: string; modelID: string }) => void;
  onUploadInboxFiles?: ((files: File[], options?: { notify?: boolean }) => void | Promise<unknown>) | null;
  providerConnectedCount?: number;
  onOpenSettingsSection?: ((section: ComposerSettingsSection) => void) | undefined;
  onRevertToMessage?: (messageId: string, sessionId: string) => Promise<boolean>;
  onRestoreRevertedSession?: (sessionId: string) => Promise<boolean>;
  onForkAtMessage?: (messageId: string | null, sessionId: string) => void;
  /** Open a sub-agent (child) session in the main chat surface. */
  onOpenSubagentSession?: (sessionId: string) => void;
  onOpenTarget?: (target: OpenTarget, options?: OpenTargetOptions, sessionId?: string) => void;
  environmentRuntimeKey?: string | null;
  onApplyEnvironmentChanges?: () => Promise<ApplyEnvironmentChangesResult>;
};

function messageToReadableText(message: UIMessage) {
  const header = message.role === "user" ? "You" : message.role === "assistant" ? "OpenWork" : message.role;
  const body = message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "reasoning") return [part.text];
      if (part.type === "file") {
        const name = part.filename?.trim() || "file";
        const url = part.url.startsWith("data:")
          ? `data:${part.mediaType || "application/octet-stream"};base64,…`
          : part.url;
        return [`[file:${name}] ${url}`];
      }
      if (part.type === "dynamic-tool") {
        if (part.state === "output-error") return [`[tool:${part.toolName}] ${part.errorText}`];
        if (part.state === "output-available") return [`[tool:${part.toolName}] ${JSON.stringify(part.output)}`];
        return [`[tool:${part.toolName}] ${JSON.stringify(part.input)}`];
      }
      return [];
    })
    .join("\n\n");
  return `${header}\n${body}`.trim();
}

function transcriptToText(messages: UIMessage[]) {
  return messages
    .flatMap((message) => {
      const text = messageToReadableText(message);
      return text ? [text] : [];
    })
    .join("\n\n---\n\n");
}

function isSessionSurfaceMounted(sessionId: string) {
  for (const surface of document.querySelectorAll(SESSION_SURFACE_SELECTOR)) {
    if (surface.getAttribute("data-session-surface-id") === sessionId) return true;
  }
  return false;
}

function firstMountedSessionSurfaceId() {
  return document.querySelector(SESSION_SURFACE_SELECTOR)?.getAttribute("data-session-surface-id") ?? null;
}

function resolveFindOwnerSessionId() {
  const focusedRoot = document.activeElement?.closest(SESSION_SURFACE_SELECTOR);
  const focusedSessionId = focusedRoot?.getAttribute("data-session-surface-id") ?? null;
  if (focusedSessionId) return focusedSessionId;

  const lastFocusedSessionId = useSessionFindStore.getState().lastFocusedSessionId;
  if (lastFocusedSessionId && isSessionSurfaceMounted(lastFocusedSessionId)) {
    return lastFocusedSessionId;
  }

  return firstMountedSessionSurfaceId();
}

function statusLabel(snapshot: OpenworkSessionSnapshot | undefined, busy: boolean) {
  if (busy) return "Running...";
  if (snapshot?.status.type === "busy") return "Running...";
  if (snapshot?.status.type === "retry") return `Retrying: ${snapshot.status.message}`;
  return "Ready";
}

function controlTextArgument(args: unknown) {
  if (typeof args === "string") return args;
  if (args && typeof args === "object" && "text" in args) {
    const text = (args as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return DEFAULT_COMPOSER_CONTROL_TEXT;
}

const waitForControl = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function useSharedQueryState<T>(queryKey: readonly unknown[], fallback: T) {
  const query = useQuery<T, Error, T, readonly unknown[]>({
    queryKey,
    queryFn: async () => fallback,
    enabled: false,
  });
  return query.data ?? fallback;
}

function AssistantWaitingCard({ label = t("session.assistant_thinking") }: { label?: string }) {
  return (
    <div className="flex justify-start" role="status" aria-live="polite">
      <div className="inline-flex items-center gap-1.5 px-1 py-1 text-[12px] text-dls-secondary">
        <div style={{ width: 20, height: 20, borderRadius: "50%", overflow: "hidden" }}>
          <PaperGrainGradient
            speed={12}
            softness={0.1}
            intensity={1}
            noise={0.05}
            shape="sphere"
            colors={["#818cf8", "#fb7185", "#fbbf24", "#34d399"]}
            colorBack="#ffffff00"
            style={{ backgroundColor: "#818cf8", width: "100%", height: "100%", borderRadius: "50%" }}
          />
        </div>
        <span>{label}</span>
      </div>
    </div>
  );
}

// Terminal recovery surface for an accepted admission that reached idle with
// no assistant result. Styled after the interrupted-run status line: a quiet
// pause, not a failure, with Resume as the single emphasized action.
function AdmissionOutcomeUnknownCard(props: { resuming: boolean; onResume: () => void }) {
  return (
    <div
      data-testid="admission-outcome-unknown"
      role="status"
      className="not-prose mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10"
    >
      <div className="flex min-w-0 items-center gap-2 py-1 text-sm text-dls-secondary">
        <CirclePause aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0">{t("session.admission_outcome_unknown")}</span>
        <span aria-hidden="true" className="text-dls-secondary/60">·</span>
        <button
          type="button"
          data-testid="admission-outcome-resume"
          disabled={props.resuming}
          onClick={props.onResume}
          className="shrink-0 cursor-pointer font-medium text-dls-text underline-offset-2 transition-colors hover:underline disabled:cursor-default disabled:opacity-60"
        >
          {t("session.resume_interrupted")}
        </button>
      </div>
    </div>
  );
}

function TodoPanel(props: { todos: TodoItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const todos = props.todos.filter((todo) => todo.content.trim());
  const completedTodos = todos.filter((todo) => todo.status === "completed").length;
  const progressLabel = t("session.todo_progress_label");
  const label = expanded ? progressLabel : `${progressLabel} · ${completedTodos}/${todos.length}`;

  if (todos.length === 0) return null;

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent">
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-xs text-gray-9 transition-colors hover:bg-gray-2/50"
          onClick={() => setExpanded((current) => !current)}
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-11">{label}</span>
          </div>
          <Minimize2 size={12} className={`text-gray-8 transition-transform ${expanded ? "" : "rotate-180"}`} />
        </button>
        {expanded ? (
          <div className="max-h-60 space-y-2.5 overflow-auto border-t border-dls-border px-4 pb-3">
            {todos.map((todo, index) => {
              const done = todo.status === "completed";
              const cancelled = todo.status === "cancelled";
              const active = todo.status === "in_progress";
              return (
                <div key={todo.id} className="flex items-start gap-2.5 pt-2.5 first:pt-2.5">
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <div
                      className={`flex size-4.5 items-center justify-center rounded-full border ${
                        done
                          ? "border-green-6 bg-green-2 text-green-11"
                          : active
                            ? "border-amber-6 bg-amber-2 text-amber-11"
                            : cancelled
                              ? "border-gray-6 bg-gray-2 text-gray-8"
                              : "border-gray-6 bg-gray-1 text-gray-8"
                      }`}
                    >
                      {done ? <Check size={10} /> : active ? <span className="size-1.5 rounded-full bg-amber-9" /> : null}
                    </div>
                  </div>
                  <div className={`flex-1 text-sm leading-relaxed ${cancelled ? "text-gray-9 line-through" : "text-gray-12"}`}>
                    <span className="mr-1.5 text-gray-9">{index + 1}.</span>
                    {todo.content}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
    </div>
  );
}

function parseSessionError(thrown: unknown): SessionError {
  const raw = thrown instanceof Error ? thrown.message : String(thrown);
  // Try to detect ProviderModelNotFoundError from the SDK error shape.
  // The error message may be a JSON string from our serializer in session-route.
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.name === "ProviderModelNotFoundError" && parsed?.data) {
      const { providerID, modelID, suggestions } = parsed.data;
      return {
        message: `Model ${providerID}/${modelID} is not available.`,
        kind: "model-not-found",
        failedModel: { providerID, modelID },
        suggestions: Array.isArray(suggestions) ? suggestions : [],
      };
    }
  } catch {
    // Not JSON — fall through to plain message
  }
  // Check if the raw string mentions model-not-found patterns
  if (/ProviderModelNotFoundError/i.test(raw) || /model.*not found/i.test(raw)) {
    return { message: raw, kind: "model-not-found" };
  }
  return { message: raw || "Failed to send prompt." };
}

function SessionErrorCard({ error, onDismiss, onChangeModel, onOpenModelPicker }: {
  error: SessionError;
  onDismiss: () => void;
  onChangeModel?: (model: { providerID: string; modelID: string }) => void;
  onOpenModelPicker?: () => void;
}) {
  return (
    <div className="mx-auto max-w-[720px] px-3 py-3 sm:px-5" data-testid="session-error-card" role="alert">
      <div className="rounded-2xl border border-red-6/30 bg-red-3/15 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-red-11">{error.message}</div>
            {error.kind === "model-not-found" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {error.suggestions && error.suggestions.length > 0 ? (
                  error.suggestions.map((s) => (
                    <button
                      key={`${s.providerID}/${s.modelID}`}
                      type="button"
                      className="rounded-full border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover"
                      onClick={() => {
                        onChangeModel?.(s);
                        onDismiss();
                      }}
                    >
                      Use {s.providerID}/{s.modelID}
                    </button>
                  ))
                ) : null}
                <button
                  type="button"
                  className="rounded-full border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover"
                  onClick={() => {
                    onOpenModelPicker?.();
                    onDismiss();
                  }}
                >
                  Change model
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="shrink-0 rounded-full p-1 text-red-10 transition-colors hover:bg-red-3 hover:text-red-11"
            onClick={onDismiss}
            aria-label="Dismiss error"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function RevertedMessagesBanner(props: { hiddenCount: number; restoring: boolean; onRestore: () => void }) {
  return (
    <div
      className="mb-3 flex items-center gap-3 rounded-2xl border border-amber-7/40 bg-amber-2/30 px-4 py-3 text-sm text-amber-11"
      data-testid="reverted-messages-banner"
      role="status"
    >
      <span className="min-w-0 flex-1 font-medium">
        {t("session.reverted_messages_hidden", { count: props.hiddenCount })}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-full border border-amber-7/50 bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover disabled:opacity-50"
        disabled={props.restoring}
        onClick={props.onRestore}
      >
        {props.restoring ? t("session.restoring") : t("session.restore")}
      </button>
    </div>
  );
}

function revokeAttachmentPreview(attachment: { previewUrl?: string | undefined }) {
  if (!attachment.previewUrl) return;
  URL.revokeObjectURL(attachment.previewUrl);
}

function sameAttachments(left: ComposerAttachment[], right: ComposerAttachment[]): boolean {
  return left.length === right.length && left.every((attachment, index) => attachment.id === right[index]?.id);
}

function draftWithEditedText(draft: ComposerDraft, text: string): ComposerDraft {
  return {
    ...draft,
    text,
    resolvedText: text,
    parts: [{ type: "text", text }],
    command: undefined,
  };
}

function withoutRevertTarget(draft: ComposerDraft | null): ComposerDraft | null {
  if (!draft || !draft.revertMessageId) return draft;
  return { ...draft, revertMessageId: undefined };
}

function hiddenMessageCount(snapshot: OpenworkSessionSnapshot, revertMessageId: string): number {
  const index = snapshot.messages.findIndex((message) => message.info.id === revertMessageId);
  return index < 0 ? snapshot.messages.length : snapshot.messages.length - index;
}

export function SessionSurface(props: SessionSurfaceProps) {
  const local = useLocal();
  const { config: shellConfig } = useShellConfig();
  const showThinking = local.prefs.showThinking;
  const findOpen = useSessionFindStore((state) => state.open);
  const findSessionId = useSessionFindStore((state) => state.sessionId);
  const findAppliedQuery = useSessionFindStore((state) => state.appliedQuery);
  const setFindLastFocused = useSessionFindStore((state) => state.setLastFocused);
  const findOwned = findOpen && findSessionId === props.sessionId;
  const findHighlightQuery = findOwned && findAppliedQuery.trim().length >= 2 ? findAppliedQuery : "";
  const sessionActivityStatus = useSessionActivityStore(
    (state) => state.statusesByWorkspaceId[props.workspaceId]?.[props.sessionId] ?? "idle",
  );
  const draft = useComposerStateStore((state) => getComposerDraft(state, props.sessionId));
  const attachments = useComposerStateStore((state) => getComposerAttachments(state, props.sessionId));
  // True while a send with attachments is in flight (compression + inbox
  // upload + prompt POST); drives the uploading overlay on composer chips.
  const [attachmentsUploading, setAttachmentsUploading] = useState(false);
  const mentions = useComposerStateStore((state) => getComposerMentions(state, props.sessionId));
  const pasteParts = useComposerStateStore((state) => getComposerPasteParts(state, props.sessionId));
  const setComposerDraft = useComposerStateStore((state) => state.setDraft);
  const replaceComposerDraft = useComposerStateStore((state) => state.replaceDraft);
  const hydrateComposerDraft = useComposerStateStore((state) => state.hydrateDraft);
  const clearComposerRevertTarget = useComposerStateStore((state) => state.clearRevertTarget);
  const setComposerAttachments = useComposerStateStore((state) => state.setAttachments);
  const setComposerMentions = useComposerStateStore((state) => state.setMentions);
  const setComposerPasteParts = useComposerStateStore((state) => state.setPasteParts);
  const clearComposerSession = useComposerStateStore((state) => state.clearSession);
  const {
    scopeKey: persistedDraftKey,
    snapshot: persistedDraftSnapshot,
    save: persistDraft,
  } = useSessionDraftState(props.draftScope, props.workspaceId, props.sessionId);
  const appliedPersistedDraftRef = useRef<{
    scopeKey: string;
    snapshot: typeof persistedDraftSnapshot;
  } | null>(null);
  const [hydratedDraftScopeKey, setHydratedDraftScopeKey] = useState<string | null>(null);

  // Layout timing is intentional: an account/org boundary must replace the
  // previous scope's in-memory Zustand draft before the browser can paint it.
  useLayoutEffect(() => {
    const applied = appliedPersistedDraftRef.current;
    if (applied?.scopeKey === persistedDraftKey && applied.snapshot === persistedDraftSnapshot) return;

    const claimedScopeKey = getComposerSessionDraftScope(props.sessionId);
    claimComposerSessionDraftScope(props.sessionId, persistedDraftKey);
    appliedPersistedDraftRef.current = {
      scopeKey: persistedDraftKey,
      snapshot: persistedDraftSnapshot,
    };

    const currentState = useComposerStateStore.getState();
    const currentDraft = getComposerDraft(currentState, props.sessionId);
    const nextDraft = persistedDraftSnapshot?.text ?? "";
    const needsHydration = composerDraftNeedsHydration({
      claimedScopeKey,
      nextScopeKey: persistedDraftKey,
      currentText: currentDraft,
      storedText: nextDraft,
    });

    if (needsHydration) {
      for (const attachment of getComposerAttachments(currentState, props.sessionId)) {
        revokeAttachmentPreview(attachment);
      }
      hydrateComposerDraft(props.sessionId, nextDraft);
    }
    setHydratedDraftScopeKey(persistedDraftKey);
  }, [hydrateComposerDraft, persistedDraftKey, persistedDraftSnapshot, props.sessionId]);
  const inputHistory = useComposerStateStore((state) => getComposerHistory(state, props.sessionId));
  const appendComposerHistory = useComposerStateStore((state) => state.appendHistory);
  // Queued follow-up drafts live in the shared composer store keyed by session
  // id. That keeps a queued message in session A from being drained into
  // session B when the route swaps the same surface component to another
  // session.
  const queuedItems = useComposerStateStore((state) => getComposerQueuedDrafts(state, props.sessionId));
  useEffect(() => {
    if (queuedItems.length === 0) return;
    setQueuedSendContext(props.sessionId, {
      workspaceId: props.workspaceId,
      workspaceRoot: props.workspaceRoot,
      opencodeBaseUrl: props.opencodeBaseUrl,
      openworkToken: props.openworkToken,
      client: props.client,
      agent: props.selectedAgent,
      variant: props.modelVariant,
      model: props.selectedModel,
      environmentRuntimeKey: props.environmentRuntimeKey ?? null,
    });
  }, [
    props.client,
    props.environmentRuntimeKey,
    props.modelVariant,
    props.opencodeBaseUrl,
    props.openworkToken,
    props.selectedAgent,
    props.selectedModel,
    props.sessionId,
    props.workspaceId,
    props.workspaceRoot,
    queuedItems.length,
  ]);
  const appendQueuedDraft = useComposerStateStore((state) => state.appendQueuedDraft);
  const removeQueuedDraftFromStore = useComposerStateStore((state) => state.removeQueuedDraft);
  const updateQueuedDraftInStore = useComposerStateStore((state) => state.updateQueuedDraft);
  const reorderQueuedDrafts = useComposerStateStore((state) => state.reorderQueuedDrafts);
  const clearQueuedDrafts = useComposerStateStore((state) => state.clearQueuedDrafts);
  const prependQueuedDrafts = useComposerStateStore((state) => state.prependQueuedDrafts);
  // Per-conversation model controls: each pane resolves its own remembered
  // model (falling back to the global default) and owns its picker open
  // state, so split panes never control each other's model picker.
  const sessionModel = useSessionModelSelection({
    sessionId: props.sessionId,
    fallbackModel: props.selectedModel,
    fallbackModelLabel: props.modelLabel,
    fallbackVariant: props.modelVariant,
    fallbackVariantLabel: props.modelVariantLabel,
    fallbackBehaviorOptions: props.modelBehaviorOptions,
    providerCatalog: props.providerCatalog,
    onFallbackVariantChange: props.onModelVariantChange,
  });
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const handleModelPickerOpenChange = useCallback((open: boolean) => {
    setModelPickerOpen(open);
    // Preserve route side effects (cloud provider sync on open).
    props.onModelPickerOpenChange(open);
  }, [props.onModelPickerOpenChange]);
  const handleModelChange = useCallback((nextModel: ModelRef, variant?: string | null) => {
    sessionModel.setModel(nextModel, variant);
    props.onModelChange(nextModel, variant);
    setModelPickerOpen(false);
  }, [props.onModelChange, sessionModel]);
  const handleModelVariantChange = useCallback((value: string | null) => {
    sessionModel.setVariant(value);
    props.onModelVariantChange(value);
  }, [props.onModelVariantChange, sessionModel]);
  const handleOpenModelPicker = useCallback(() => {
    props.onModelClick(props.sessionId);
  }, [props.onModelClick, props.sessionId]);
  // Availability is scoped to THIS conversation's effective model. A missing
  // global default must not disable a conversation that remembers a valid
  // model, and a pending catalog (loading or superseded by a workspace
  // switch) never renders "Model no longer available".
  const sessionModelUnavailable = props.resolveModelAvailability
    ? props.resolveModelAvailability(sessionModel.selectedModel).status === "unavailable"
    : Boolean(props.modelUnavailable);
  const [error, setError] = useState<SessionError | null>(null);
  const [restoringRevertedMessages, setRestoringRevertedMessages] = useState(false);
  const [showDelayedLoading, setShowDelayedLoading] = useState(false);
  const [awaitingAssistantBaseline, setAwaitingAssistantBaseline] = useState<number | null>(null);
  // Terminal invariant: an accepted admission that reached idle with no
  // assistant result surfaces a bounded recovery card instead of plain idle.
  const [admissionOutcomeUnresolved, setAdmissionOutcomeUnresolved] = useState(false);
  const [rendered, setRendered] = useState<{ sessionId: string; snapshot: OpenworkSessionSnapshot } | null>(null);
  const [toolSkills, setToolSkills] = useState<SkillCard[]>([]);
  const [toolMcpServers, setToolMcpServers] = useState<McpServerEntry[]>([]);
  const [toolMcpStatus, setToolMcpStatus] = useState<string | null>(null);
  const [toolMcpStatuses, setToolMcpStatuses] = useState<McpStatusMap>({});
  const [toolImportedPlugins, setToolImportedPlugins] = useState<CloudImportedPlugin[]>([]);
  const orgMcpConnections = useOrgMcpConnections();
  const connectorIdentities = useMemo(
    () => buildConnectorToolIdentities({
      mcpServers: toolMcpServers,
      orgConnections: orgMcpConnections.connections,
    }),
    [orgMcpConnections.connections, toolMcpServers],
  );
  const skillsConnectPushRef = useRef(0);
  const mcpConnectPushRef = useRef(0);
  const pluginConnectPushRef = useRef(0);
  const [steering, setSteering] = useState(false);
  const [verifiedOpenTargets, setVerifiedOpenTargets] = useState<OpenTarget[]>([]);
  const [cloudQueueRetryVersion, setCloudQueueRetryVersion] = useState(0);
  const sending = props.cloudMcpSubmissionState.status === "sending";
  const cloudQueueBlockedRef = useRef(false);
  // Shared with promote-to-send so a manual send-now cannot race the idle drain.
  const drainingQueueRef = useRef(false);
  // Admission-aware drain state. It lives in a module-level per-session store
  // (not a ref) so an in-flight admission survives navigating away and back.
  const subscribeDrainState = useCallback(
    (listener: () => void) => subscribeQueuedDrain(props.sessionId, listener),
    [props.sessionId],
  );
  const readDrainState = useCallback(() => getQueuedDrainState(props.sessionId), [props.sessionId]);
  const queuedDrainState = useSyncExternalStore(subscribeDrainState, readDrainState);
  const lastObservationProbeAtRef = useRef<number | null>(null);
  const [observationProbeVersion, setObservationProbeVersion] = useState(0);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const hydratedKeyRef = useRef<string | null>(null);
  const autoOpenedTargetRef = useRef<string | null>(null);
  const initializedAutoOpenSessionRef = useRef<string | null>(null);
  const opencodeClient = useMemo(
    () => createClient(props.opencodeBaseUrl, undefined, { token: props.openworkToken, mode: "openwork" }),
    [props.opencodeBaseUrl, props.openworkToken],
  );

  const snapshotQueryKey = useMemo(
    () => reactSnapshotKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );
  const transcriptQueryKey = useMemo(
    () => reactTranscriptKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );
  const statusQueryKey = useMemo(
    () => reactStatusKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );
  const snapshotQuery = useQuery<OpenworkSessionSnapshot>({
    queryKey: snapshotQueryKey,
    queryFn: async ({ signal }) => {
      const startedAt = Date.now();
      const item = await composeNativeSessionSnapshot(
        { opencodeBaseUrl: props.opencodeBaseUrl, token: props.openworkToken },
        props.sessionId,
        { limit: 140, signal },
      );
      markSessionSnapshotFetchStart(item, startedAt);
      return item;
    },
    staleTime: 500,
  });

  const currentSnapshot = snapshotQuery.data?.session.id === props.sessionId ? snapshotQuery.data : null;
  const transcriptState = useSharedQueryState<UIMessage[]>(transcriptQueryKey, EMPTY_TRANSCRIPT);
  const statusQuery = useQuery<SessionStatus, Error, SessionStatus, readonly unknown[]>({
    queryKey: statusQueryKey,
    queryFn: async () => currentSnapshot?.status ?? IDLE_STATUS,
    enabled: false,
  });
  const statusState = statusQuery.data ?? currentSnapshot?.status ?? IDLE_STATUS;
  // The shared status entry is written only by the session-status stream and
  // its reconnect-time level reconciliation, so its presence marks the value
  // as a real observed level instead of a render fallback. Queue-drain
  // completion must never trust a fallback idle (a remount briefly renders
  // idle before any status has been observed).
  const statusIsObservedLevel = statusQuery.data !== undefined;

  useEffect(() => {
    if (!currentSnapshot) return;
    setRendered({ sessionId: props.sessionId, snapshot: currentSnapshot });
  }, [props.sessionId, currentSnapshot]);

  useEffect(() => {
    hydratedKeyRef.current = null;
    setSteering(false);
    setError(null);
    setRestoringRevertedMessages(false);
    setShowDelayedLoading(false);
    setAwaitingAssistantBaseline(null);
    setAdmissionOutcomeUnresolved(false);
    // Composer draft state lives in the shared store keyed by session id, so
    // switching sessions preserves each session's own in-progress composer.
    autoOpenedTargetRef.current = null;
    initializedAutoOpenSessionRef.current = null;
    setVerifiedOpenTargets([]);
  }, [props.sessionId]);

  useEffect(() => () => {
    clearComposerRevertTarget(props.sessionId);
  }, [clearComposerRevertTarget, props.sessionId]);

  // Publish a composer inspector slice so external drivers can read draft
  // state, attachments, mentions, and sending status from the running app.
  useEffect(() => {
    const dispose = publishInspectorSlice("composer", () => ({
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
      draft,
      draftLength: draft.length,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        kind: attachment.kind,
      })),
      mentions,
      pasteParts: pasteParts.map((part) => ({
        id: part.id,
        label: part.label,
        lines: part.lines,
      })),
      sending,
      cloudMcpSubmission: {
        status: props.cloudMcpSubmissionState.status,
        attempt: props.cloudMcpSubmissionState.attempt,
        maxAttempts: props.cloudMcpSubmissionState.maxAttempts,
        code: props.cloudMcpSubmissionState.issue?.code ?? null,
        stage: props.cloudMcpSubmissionState.issue?.stage ?? null,
      },
      error,
    }));
    return dispose;
  }, [
    attachments,
    draft,
    error,
    mentions,
    pasteParts,
    props.sessionId,
    props.workspaceId,
    props.cloudMcpSubmissionState,
    sending,
  ]);

  useEffect(() => {
    recordInspectorEvent("session.mounted", {
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
    });
  }, [props.sessionId, props.workspaceId]);

  useEffect(() => {
    if (!currentSnapshot) return;
    seedSessionState(props.workspaceId, currentSnapshot);
  }, [currentSnapshot, props.sessionId, props.workspaceId]);

  useEffect(() => {
    if (!currentSnapshot) return;
    const key = `${props.sessionId}:${currentSnapshot.session.time?.updated ?? currentSnapshot.session.time?.created ?? 0}:${currentSnapshot.messages.length}`;
    if (hydratedKeyRef.current === key) return;
    hydratedKeyRef.current = key;
    seedSessionState(props.workspaceId, currentSnapshot);
  }, [props.sessionId, currentSnapshot, props.workspaceId]);

  const snapshot = resolveRenderedSessionSnapshot({
    sessionId: props.sessionId,
    currentSnapshot,
    cachedRendered: rendered,
  });
  const revertMessageId = snapshot?.session.revert?.messageID ?? null;
  const revertedMessageCount = snapshot && revertMessageId ? hiddenMessageCount(snapshot, revertMessageId) : 0;
  const liveStatus = statusState ?? snapshot?.status ?? IDLE_STATUS;
  const preparingCloudTools = props.cloudMcpSubmissionState.status === "checking" ||
    props.cloudMcpSubmissionState.status === "repairing";
  const chatStreaming = sending || liveStatus.type === "busy" || liveStatus.type === "retry";
  // A busy status is a claim that decays: the sync layer revalidates it
  // continuously against /session/status, and once that validation keeps
  // failing (network drop, sleep, dead engine) the transcript must present
  // "reconnecting" instead of a confidently ticking Working row.
  const syncStreamKey = workspaceSyncStreamKey({ workspaceId: props.workspaceId, baseUrl: props.opencodeBaseUrl });
  const syncReconcileHealth = useWorkspaceSyncStreamStore(
    (state) => state.reconcileHealthByKey[syncStreamKey],
  );
  const runSyncHealth = useMemo(() => ({
    degraded: (syncReconcileHealth?.consecutiveFailures ?? 0) >= reconcileFailureDegradedThreshold,
    lastConfirmedAt: syncReconcileHealth?.lastSuccessAt ?? null,
  }), [syncReconcileHealth]);

  useEffect(() => {
    if (!chatStreaming) setSteering(false);
  }, [chatStreaming]);
  const [evalThreadStatus, setEvalThreadStatus] = useState<ThreadStatus | null>(null);
  const status = useMemo((): ThreadStatus => {
    if (evalThreadStatus) return evalThreadStatus;
    if (sending) {
      return "submitted";
    }

    if (liveStatus.type === "busy") {
      return "streaming";
    }

    if (liveStatus.type === "retry") {
      return "retrying";
    }

    return "ready";
  }, [evalThreadStatus, liveStatus, sending]);
  const [evalMarkdownMessages, setEvalMarkdownMessages] = useState<UIMessage[]>(EMPTY_TRANSCRIPT);
  useEffect(() => {
    setEvalMarkdownMessages(EMPTY_TRANSCRIPT);
    setEvalThreadStatus(null);
  }, [props.sessionId]);

  const baseRenderedMessages = useMemo(
    () => deriveRenderedSessionMessages({ transcriptState, snapshot }),
    [snapshot, transcriptState],
  );
  const renderedMessages = useMemo(() => {
    if (evalMarkdownMessages.length === 0) return baseRenderedMessages;

    return [...baseRenderedMessages, ...evalMarkdownMessages];
  }, [baseRenderedMessages, evalMarkdownMessages]);
  const renderedMessagesRef = useRef(renderedMessages);
  useEffect(() => {
    renderedMessagesRef.current = renderedMessages;
  }, [renderedMessages]);
  const seedMarkdownPrimitiveControlAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.markdown_primitive.seed_chat",
      label: "Seed markdown primitive chat proof",
      description: "Dev-only eval hook that renders deterministic Markdown in the active conversation.",
      sideEffect: "mutation",
      disabled: !props.sessionId,
      execute: () => {
        const seeded = createMarkdownPrimitiveEvalMessages(props.sessionId);
        setEvalMarkdownMessages(seeded.messages);
        return {
          ok: true,
          assistantMessageId: seeded.assistantMessageId,
          messageCount: seeded.messages.length,
        };
      },
    };
  }, [props.sessionId]);
  useControlAction(props.isControlTarget ? seedMarkdownPrimitiveControlAction : null);
  const setMermaidEvalThemeControlAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.mermaid.set_theme",
      label: "Set the Mermaid eval theme",
      description: "Dev-only eval hook that changes the app theme through the production theme API.",
      sideEffect: "mutation",
      disabled: !props.sessionId,
      execute: (args) => {
        const mode = args && typeof args === "object" && "mode" in args ? args.mode : null;
        if (mode !== "light" && mode !== "dark") throw new Error("Mermaid eval theme must be light or dark.");
        setThemeMode(mode);
        return { ok: true, mode };
      },
    };
  }, [props.sessionId]);
  useControlAction(props.isControlTarget ? setMermaidEvalThemeControlAction : null);
  const seedMarkdownMathControlAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.markdown_math.seed_chat",
      label: "Seed markdown math chat proof",
      description: "Dev-only eval hook that renders deterministic LaTeX math in the active conversation.",
      sideEffect: "mutation",
      disabled: !props.sessionId,
      execute: (args) => {
        const stage = typeof args === "object" && args !== null && "stage" in args && typeof args.stage === "number"
          ? args.stage
          : MARKDOWN_MATH_EVAL_STAGES.length;
        const seeded = createMarkdownMathEvalMessages(props.sessionId, stage);
        setEvalMarkdownMessages(seeded.messages);
        return {
          ok: true,
          assistantMessageId: seeded.assistantMessageId,
          messageCount: seeded.messages.length,
        };
      },
    };
  }, [props.sessionId]);
  useControlAction(props.isControlTarget ? seedMarkdownMathControlAction : null);
  const seedChatTranscriptControlAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.chat_transcript.seed",
      label: "Seed chat transcript proof",
      description: "Dev-only eval hook that renders a deterministic transcript with capability calls, aggregated tools, thinking, links, and file chips.",
      sideEffect: "mutation",
      disabled: !props.sessionId,
      execute: () => {
        const seeded = createChatTranscriptEvalMessages(props.sessionId);
        setEvalMarkdownMessages(seeded.messages);
        return { ok: true, messageCount: seeded.messages.length };
      },
    };
  }, [props.sessionId]);
  useControlAction(props.isControlTarget ? seedChatTranscriptControlAction : null);
  const seedConnectorToolCallControlAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.connector_tool_call.seed",
      label: "Seed a branded connector tool call",
      description: "Dev-only eval hook that renders a deterministic connector-backed capability call.",
      sideEffect: "mutation",
      disabled: !props.sessionId,
      execute: () => {
        setEvalMarkdownMessages(createConnectorToolCallEvalMessages(props.sessionId));
        return { ok: true, connector: "Google Workspace" };
      },
    };
  }, [props.sessionId]);
  useControlAction(props.isControlTarget ? seedConnectorToolCallControlAction : null);
  const seedSessionLifecycleControlAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.session_lifecycle.seed_unfinished_tools",
      label: "Seed unfinished tool lifecycle proof",
      description: "Dev-only eval hook that reconciles unfinished current-turn tools with the active task lifecycle.",
      sideEffect: "mutation",
      disabled: !props.sessionId,
      execute: (args) => {
        const lifecycle = typeof args === "object" && args !== null && "lifecycle" in args
          ? args.lifecycle
          : "idle";
        if (lifecycle !== "active" && lifecycle !== "waiting" && lifecycle !== "idle") {
          throw new Error(`Unsupported lifecycle: ${String(lifecycle)}`);
        }

        setEvalMarkdownMessages(createSessionLifecycleEvalMessages(props.sessionId));
        const activity = useSessionActivityStore.getState();
        activity.replaceWaitingRequests(props.workspaceId, props.sessionId, "permission", []);
        activity.replaceWaitingRequests(props.workspaceId, props.sessionId, "question", []);
        activity.clearError(props.workspaceId, props.sessionId);
        activity.setCompacting(props.workspaceId, props.sessionId, false);
        activity.setRunStatus(
          props.workspaceId,
          props.sessionId,
          lifecycle === "active" ? { type: "busy" } : { type: "idle" },
        );
        if (lifecycle === "waiting") {
          activity.setWaitingRequest(
            props.workspaceId,
            props.sessionId,
            "question",
            "eval-session-lifecycle-question",
            true,
          );
        }
        return { ok: true, lifecycle };
      },
    };
  }, [props.sessionId, props.workspaceId]);
  useControlAction(props.isControlTarget ? seedSessionLifecycleControlAction : null);
  const refreshCurrentSessionControlAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.composer_focus.refresh_current_session",
      label: "Refresh current session while composing",
      description: "Dev-only eval hook that exercises a same-session snapshot refresh without changing tasks.",
      sideEffect: "none",
      disabled: !props.sessionId,
      execute: async () => {
        const editor = composerShellRef.current?.querySelector<HTMLElement>(
          '[contenteditable="true"][data-lexical-editor="true"]',
        );
        const wasFocused = editor === document.activeElement;
        const result = await snapshotQuery.refetch();
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
        });

        return {
          ok: result.status === "success",
          wasFocused,
          remainsFocused: editor === document.activeElement,
          editable: editor?.getAttribute("contenteditable") === "true",
        };
      },
    };
  }, [props.sessionId, snapshotQuery.refetch]);
  useControlAction(props.isControlTarget ? refreshCurrentSessionControlAction : null);
  const seedSubagentActivityControlAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.task_activity.seed",
      label: "Seed running delegated-task activity proof",
      description: "Dev-only eval hook that renders a deterministic running delegated-task row.",
      sideEffect: "mutation",
      disabled: !props.sessionId,
      execute: () => {
        setEvalMarkdownMessages(createSubagentActivityEvalMessages(props.sessionId));
        useSessionActivityStore.getState().setRunStatus(
          props.workspaceId,
          props.sessionId,
          { type: "busy" },
        );
        return { ok: true };
      },
    };
  }, [props.sessionId, props.workspaceId]);
  useControlAction(props.isControlTarget ? seedSubagentActivityControlAction : null);
  const seedChatLoadingControlAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.chat_loading.seed",
      label: "Seed chat loading shimmer proof",
      description: "Dev-only eval hook that renders the main chat loading treatment.",
      sideEffect: "mutation",
      disabled: !props.sessionId,
      execute: () => {
        setEvalMarkdownMessages(createChatLoadingEvalMessages(props.sessionId));
        setEvalThreadStatus("streaming");
        useSessionActivityStore.getState().setRunStatus(
          props.workspaceId,
          props.sessionId,
          { type: "busy" },
        );
        return { ok: true };
      },
    };
  }, [props.sessionId, props.workspaceId]);
  useControlAction(props.isControlTarget ? seedChatLoadingControlAction : null);
  const openTargets = useMemo(() => deriveOpenTargets(renderedMessages), [renderedMessages]);
  const openTargetsFingerprint = useMemo(
    () => openTargets.map((target) => `${target.kind}:${target.value}:${target.confidence}`).join("|"),
    [openTargets],
  );
  const autoOpenTarget = selectAutoOpenTarget(verifiedOpenTargets);
  const handleOpenTarget = useCallback((target: OpenTarget, options?: OpenTargetOptions) => {
    props.onOpenTarget?.(target, options, props.sessionId);
  }, [props.onOpenTarget, props.sessionId]);
  const pendingSessionLoad = !snapshot && snapshotQuery.isLoading && renderedMessages.length === 0;
  const assistantOutputAfterAwaitStart = useMemo(() => {
    if (awaitingAssistantBaseline === null) return false;
    return renderedMessages
      .slice(awaitingAssistantBaseline)
      .some(messageHasVisibleAssistantOutput);
  }, [awaitingAssistantBaseline, renderedMessages]);
  const showAssistantWaitState = awaitingAssistantBaseline !== null && !assistantOutputAfterAwaitStart;
  const showAssistantRespondingState = awaitingAssistantBaseline !== null && assistantOutputAfterAwaitStart && chatStreaming;
  const effectiveActivityStatus: SessionActivityStatus = sessionActivityStatus !== "idle"
    ? sessionActivityStatus
    : showAssistantWaitState
      ? "thinking"
      : showAssistantRespondingState
        ? "responding"
        : "idle";
  useReactRenderWatchdog("SessionSurface", {
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
    messageCount: renderedMessages.length,
    liveStatus: liveStatus.type,
    sending,
    pendingSessionLoad,
    showAssistantWaitState,
    showAssistantRespondingState,
    hasSnapshot: Boolean(snapshot),
  });

  useEffect(() => {
    if (!autoOpenTarget || chatStreaming) return;
    if (autoOpenedTargetRef.current === autoOpenTarget.id) return;
    autoOpenedTargetRef.current = autoOpenTarget.id;
    props.onOpenTarget?.(autoOpenTarget, { auto: true }, props.sessionId);
  }, [autoOpenTarget, chatStreaming, props.onOpenTarget, props.sessionId]);

  useEffect(() => {
    let cancelled = false;
    const updateVerifiedOpenTargets = (targets: OpenTarget[]) => {
      setVerifiedOpenTargets((current) => sameOpenTargets(current, targets) ? current : targets);
    };
    function initializeAutoOpenState(targets: OpenTarget[]) {
      if (initializedAutoOpenSessionRef.current === props.sessionId) return;
      initializedAutoOpenSessionRef.current = props.sessionId;
      autoOpenedTargetRef.current = selectAutoOpenTarget(targets)?.id ?? null;
    }

    async function verifyTargets() {
      if (!openTargets.length) {
        initializeAutoOpenState([]);
        updateVerifiedOpenTargets([]);
        return;
      }
      try {
        const response = await props.client.resolveArtifacts(props.workspaceId, openTargets);
        if (!cancelled) {
          const nextTargets = response.items as OpenTarget[];
          initializeAutoOpenState(nextTargets);
          updateVerifiedOpenTargets(nextTargets);
        }
      } catch {
        if (!cancelled) {
          const nextTargets = openTargets.map((target) => ({ ...target, exists: target.kind === "url" }));
          initializeAutoOpenState(nextTargets);
          updateVerifiedOpenTargets(nextTargets);
        }
      }
    }
    void verifyTargets();
    return () => { cancelled = true; };
  }, [chatStreaming, openTargetsFingerprint, props.client, props.sessionId, props.workspaceId]);

  useEffect(() => {
    usePanelTabStore.getState().syncTranscriptArtifacts(props.sessionId, verifiedOpenTargets);
  }, [props.sessionId, verifiedOpenTargets]);

  useEffect(() => {
    if (!pendingSessionLoad) {
      setShowDelayedLoading(false);
      return;
    }
    const id = window.setTimeout(() => setShowDelayedLoading(true), 2000);
    return () => window.clearTimeout(id);
  }, [pendingSessionLoad]);

  // Terminal invariant for accepted admissions: idle with no assistant result
  // must never silently clear the task. The transcript-length check alone is
  // not an outcome — the newly appended user message satisfies it even when no
  // assistant message exists. Deriving the outcome from the transcript (last
  // user message answered by visible assistant output) also makes the recovery
  // state survive a reload: rehydrating the same transcript recomputes it.
  const admissionOutcome = useMemo(() => resolveAdmissionOutcome({
    messages: renderedMessages,
    statusType: liveStatus.type,
    sending,
    hasActiveQuestion: Boolean(props.activeQuestion),
    hasActivePermission: Boolean(props.activePermission),
    hasSessionError: error !== null,
  }), [error, liveStatus.type, props.activePermission, props.activeQuestion, renderedMessages, sending]);

  useEffect(() => {
    if (admissionOutcome !== "unresolved") {
      setAdmissionOutcomeUnresolved(false);
      return;
    }
    const id = window.setTimeout(() => {
      // Swap the wait state for the recovery card in one step so the
      // admission never terminates as plain idle without a result.
      setAwaitingAssistantBaseline(null);
      setAdmissionOutcomeUnresolved(true);
    }, ADMISSION_OUTCOME_GRACE_MS);
    return () => window.clearTimeout(id);
  }, [admissionOutcome]);

  const model = deriveSessionRenderModel({
    intendedSessionId: props.sessionId,
    renderedSessionId: renderedMessages.length > 0 || snapshot ? props.sessionId : null,
    hasSnapshot: Boolean(snapshot) || renderedMessages.length > 0,
    isFetching: snapshotQuery.isFetching,
    isError: snapshotQuery.isError || Boolean(error),
  });

  const buildDraft = useCallback((text: string, nextAttachments: ComposerAttachment[]): ComposerDraft => {
    const parts: ComposerPart[] = text.split(/(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[connect-skill [^\]]+\]|\[skill [^\]]+\]|@[^\s@]+)/).flatMap((segment) => {
      if (!segment) return [] as ComposerDraft["parts"];
      const attachmentMatch = segment.match(/^\[attachment (.+)\]$/);
      if (attachmentMatch) {
        // Attachment chips are visual tokens only; bytes travel via draft.attachments.
        return [] as ComposerDraft["parts"];
      }
      const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
      if (pasteMatch) {
        const target = pasteParts.find((item) => item.label === pasteMatch[1]);
        if (target) {
          return [{ type: "paste", id: target.id, label: target.label, text: target.text, lines: target.lines } satisfies ComposerDraft["parts"][number]];
        }
      }
      const connectSkill = parseConnectSkillToken(segment);
      if (connectSkill) {
        return [{ type: "text", text: connectSkillPrompt(connectSkill) } satisfies ComposerDraft["parts"][number]];
      }
      const skillMatch = segment.match(/^\[skill (.+)\]$/);
      if (skillMatch?.[1]) {
        return [{ type: "skill", name: skillMatch[1] } satisfies ComposerDraft["parts"][number]];
      }
      if (segment.startsWith("@")) {
        const value = decodeComposerMentionValue(segment.slice(1));
        const kind = mentions[value];
        if (kind === "agent") return [{ type: "agent", name: value } satisfies ComposerDraft["parts"][number]];
        if (kind === "file") return [{ type: "file", path: value, label: value } satisfies ComposerDraft["parts"][number]];
        if (kind === "app") return [{ type: "app", name: value } satisfies ComposerDraft["parts"][number]];
      }
      return [{ type: "text", text: segment } satisfies ComposerDraft["parts"][number]];
    });
    // Expand paste placeholders in resolvedText so the model receives
    // the actual pasted content instead of "[pasted text <label>]".
    let resolved = resolvePastedTextPlaceholders(text, pasteParts);
    resolved = resolved.replace(/\[attachment [^\]]+\]/g, "");
    resolved = resolved.replace(/\[connect-skill [^\]]+\]/g, (match) => {
      const token = parseConnectSkillToken(match);
      return token ? connectSkillPrompt(token) : match;
    });
    resolved = resolved.replace(/\[skill ([^\]]+)\]/g, (_match, name: string) => `the \"${name}\" skill`);
    for (const value of Object.keys(mentions)) {
      resolved = resolved.replaceAll(`@${encodeComposerMentionValue(value)}`, `@${value}`);
    }
    const slashCommand = parseSlashCommandInvocation(resolved);
    return {
      mode: "prompt",
      parts,
      attachments: nextAttachments,
      text,
      resolvedText: resolved,
      command: slashCommand ?? undefined,
      revertMessageId: getComposerRevertMessageId(useComposerStateStore.getState(), props.sessionId) ?? undefined,
    };
  }, [mentions, pasteParts, props.sessionId]);

  const handleComposerDraftChange = useCallback((value: string) => {
    setComposerDraft(props.sessionId, value);
    const idsInDraft = new Set(
      [...value.matchAll(/\[attachment ([^\]]+)\]/g)].map((match) => match[1]).filter((id): id is string => Boolean(id)),
    );
    const retained = attachments.filter((attachment) => idsInDraft.has(attachment.id));
    if (retained.length === attachments.length) return;
    for (const attachment of attachments) {
      if (!idsInDraft.has(attachment.id)) revokeAttachmentPreview(attachment);
    }
    setComposerAttachments(props.sessionId, retained);
  }, [attachments, props.sessionId, setComposerAttachments, setComposerDraft]);

  const handleCopyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(transcriptToText(renderedMessages));
    } catch (nextError) {
      setError({ message: nextError instanceof Error ? nextError.message : "Failed to copy transcript." });
    }
  };

  // Core sender shared by initial send and steered follow-ups. OpenCode
  // accepts follow-up user turns mid-run (steering) — the running loop picks
  // up the new message — so this is safe to call while the agent is busy.
  const sendDraft = useCallback(async (nextDraft: ComposerDraft) => {
    setError(null);
    try {
      const result = await props.onSendDraft(nextDraft, props.sessionId);
      if (result.outcome === "blocked" || result.outcome === "cancelled") return result;
      // Only report a run after the pre-send gate released the exact queued
      // submission and the route accepted or sent it.
      appendComposerHistory(props.sessionId, nextDraft.text);
      useSessionActivityStore.getState().setRunStatus(props.workspaceId, props.sessionId, { type: "busy" });
      setAwaitingAssistantBaseline(renderedMessages.length);
      return result;
    } catch (nextError) {
      const parsed = parseSessionError(nextError);
      captureAnalyticsEvent("task_send_failed", {});
      setError(parsed);
      useSessionActivityStore.getState().setError(props.workspaceId, props.sessionId, parsed.message);
      setAwaitingAssistantBaseline(null);
      throw nextError;
    }
  }, [appendComposerHistory, props.onSendDraft, props.sessionId, props.workspaceId, renderedMessages.length]);

  const clearComposer = useCallback(() => {
    clearComposerSession(props.sessionId);
    props.onDraftChange(buildDraft("", []));
  }, [buildDraft, clearComposerSession, props.onDraftChange, props.sessionId]);

  // Initial send (agent idle) and explicit "Steer" follow-up (agent busy)
  // share the same immediate path.
  const handleSend = useCallback(async () => {
    const originalDraft = draft;
    const text = originalDraft.trim();
    if (!text && attachments.length === 0) return;
    const nextDraft = buildDraft(text, attachments);
    const sentAttachments = attachments;
    if (sentAttachments.length) setAttachmentsUploading(true);
    try {
      const result = await sendDraft(nextDraft);
      if (result.outcome === "blocked" || result.outcome === "cancelled") return;
      const currentState = useComposerStateStore.getState();
      const currentDraft = getComposerDraft(currentState, props.sessionId);
      const currentAttachments = getComposerAttachments(currentState, props.sessionId);
      if (currentDraft === originalDraft && sameAttachments(currentAttachments, sentAttachments)) {
        clearComposer();
        sentAttachments.forEach(revokeAttachmentPreview);
      } else {
        const retainedIds = new Set(currentAttachments.map((attachment) => attachment.id));
        sentAttachments
          .filter((attachment) => !retainedIds.has(attachment.id))
          .forEach(revokeAttachmentPreview);
      }
    } catch {
    } finally {
      setAttachmentsUploading(false);
    }
  }, [attachments, buildDraft, clearComposer, draft, props.sessionId, sendDraft]);

  // One-step run from the empty-state hero: the route seeds this session's
  // draft and marks it for auto-send. Fire the same send path as the send
  // button once the composer is usable; if these conditions never hold
  // (e.g. no usable model), the mark is never consumed and the seeded
  // draft stays for manual sending.
  useEffect(() => {
    if (model.transitionState !== "idle") return;
    if (chatStreaming) return;
    if (sessionModelUnavailable) return;
    if (!draft.trim()) return;
    if (!consumeComposerAutoSend(props.sessionId)) return;
    void handleSend();
  }, [chatStreaming, draft, handleSend, model.transitionState, sessionModelUnavailable, props.sessionId]);

  const handleSteer = useCallback(async () => {
    setSteering(true);
    await handleSend();
  }, [handleSend]);

  const handleRetryCloudSubmission = useCallback(() => {
    if (draft.trim() || attachments.length > 0) {
      void handleSend();
      return;
    }
    cloudQueueBlockedRef.current = false;
    dispatchQueuedDrain(props.sessionId, { type: "user_retry" });
    setCloudQueueRetryVersion((version) => version + 1);
  }, [attachments.length, draft, handleSend, props.sessionId]);

  // Queue: hold the draft locally and clear the composer. The drain effect
  // sends it once the session reports idle.
  const handleQueue = useCallback(() => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    const queuedDraft = withoutRevertTarget(buildDraft(text, attachments));
    if (!queuedDraft) return;
    appendQueuedDraft(props.sessionId, queuedDraft);
    clearComposer();
  }, [appendQueuedDraft, attachments, buildDraft, clearComposer, draft, props.sessionId]);

  const removeQueuedDraft = useCallback((id: string) => {
    const target = queuedItems.find((item) => item.id === id);
    removeQueuedDraftFromStore(props.sessionId, id);
    target?.draft.attachments.forEach(revokeAttachmentPreview);
  }, [props.sessionId, queuedItems, removeQueuedDraftFromStore]);

  const editQueuedDraft = useCallback((id: string, text: string) => {
    const target = queuedItems.find((item) => item.id === id);
    if (!target) return;
    updateQueuedDraftInStore(props.sessionId, id, draftWithEditedText(target.draft, text));
  }, [props.sessionId, queuedItems, updateQueuedDraftInStore]);

  // Promote a queued follow-up to an immediate send (steer-style), instead of
  // waiting for the idle drain. Guarded against the drain effect so the same
  // draft cannot be delivered twice.
  const [sendingQueued, setSendingQueued] = useState(false);
  const sendQueuedDraftNow = useCallback(async (id: string) => {
    if (drainingQueueRef.current || sendingQueued) return;
    const item = queuedItems.find((queued) => queued.id === id);
    const target = withoutRevertTarget(item?.draft ?? null);
    if (!item || !target) return;
    setSendingQueued(true);
    removeQueuedDraftFromStore(props.sessionId, id);
    try {
      const result = await sendDraft(target);
      if (result.outcome === "blocked" || result.outcome === "cancelled") {
        prependQueuedDrafts(props.sessionId, [{ id: item.id, draft: target }]);
        return;
      }
      target.attachments.forEach(revokeAttachmentPreview);
    } catch {
      prependQueuedDrafts(props.sessionId, [{ id: item.id, draft: target }]);
    } finally {
      setSendingQueued(false);
    }
  }, [
    prependQueuedDrafts,
    props.sessionId,
    queuedItems,
    removeQueuedDraftFromStore,
    sendDraft,
    sendingQueued,
  ]);

  const handleAbort = useCallback(async () => {
    if (!chatStreaming) return;
    setError(null);
    // Stop means stop: drop queued follow-ups before aborting, otherwise the
    // queue-drain effect below re-prompts the agent the moment the abort
    // lands and the session reports idle (#2014).
    queuedItems.forEach((item) => item.draft.attachments.forEach(revokeAttachmentPreview));
    clearQueuedDrafts(props.sessionId);
    dispatchQueuedDrain(props.sessionId, { type: "queue_cleared" });
    // The prompt was sent through a directory-scoped client (session-route
    // passes the workspace root), so the abort must target the same scope —
    // without it the server resolves the default project, finds no live run,
    // and answers `200: false` while the stream keeps going (#2014).
    const aborted = await abortSessionSafe(
      opencodeClient,
      props.sessionId,
      props.workspaceRoot.trim() || undefined,
      {
        source: "composer.stop",
        initiator: "user",
        reason: "stop active session run",
      },
    );
    if (!aborted) {
      setError({ message: t("session.stop_failed") });
      return;
    }
    captureAnalyticsEvent("task_run_stopped", {});
    await snapshotQuery.refetch();
  }, [chatStreaming, clearQueuedDrafts, opencodeClient, props.sessionId, props.workspaceRoot, queuedItems, snapshotQuery.refetch]);

  const handleDismissError = useCallback(() => {
    setError(null);
    useSessionActivityStore.getState().clearError(props.workspaceId, props.sessionId);
  }, [props.sessionId, props.workspaceId]);

  // Drain one queued follow-up each time the session goes idle, so prompts
  // run as separate turns instead of one merged message. Progress is grounded
  // in the engine's own run status (liveStatus), not chatStreaming: the
  // client-side `sending` pulse would release the wait before the engine
  // actually went busy and the next idle render could steer the following
  // item into the still-starting turn. Feed status levels into the
  // admission-aware machine: a busy level attaches the current admission to a
  // running run, and an idle level completes an admission that was already
  // observed running. An admission that never shows busy is released only by
  // the authoritative probe below — never by a stale idle render.
  useEffect(() => {
    if (liveStatus.type !== "idle") {
      dispatchQueuedDrain(props.sessionId, { type: "busy_observed" });
      return;
    }
    if (!statusIsObservedLevel) return;
    if (getQueuedDrainState(props.sessionId).phase.kind === "running") {
      dispatchQueuedDrain(props.sessionId, { type: "idle_reconciled", observedAt: Date.now() });
    }
  }, [liveStatus.type, props.sessionId, statusIsObservedLevel]);

  // Admission observation probe: when an admitted send has produced no busy
  // observation within its window (dropped event, upstream dispatch failure
  // after admission, or an event-stream reconnect), reconcile against an
  // authoritative snapshot fetch instead of waiting on the missing edge
  // forever. The probe's start time orders the observed level against the
  // admission time inside the machine, so a stale idle can never release it.
  useEffect(() => {
    const probeAt = nextObservationProbeAt(queuedDrainState, lastObservationProbeAtRef.current);
    if (probeAt === null) return;
    const timer = window.setTimeout(() => {
      const startedAt = Date.now();
      lastObservationProbeAtRef.current = startedAt;
      void (async () => {
        try {
          const result = await snapshotQuery.refetch();
          const probed = result.data?.session.id === props.sessionId ? result.data.status : null;
          if (!probed) return;
          if (probed.type === "idle") {
            dispatchQueuedDrain(props.sessionId, { type: "idle_reconciled", observedAt: startedAt });
          } else {
            dispatchQueuedDrain(props.sessionId, { type: "busy_observed" });
          }
        } catch {
          // Probe failed (for example the local server was briefly
          // unreachable); the version bump below re-arms a spaced retry.
        } finally {
          setObservationProbeVersion((version) => version + 1);
        }
      })();
    }, Math.max(0, probeAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [observationProbeVersion, props.sessionId, queuedDrainState, snapshotQuery.refetch]);

  useEffect(() => {
    if (drainingQueueRef.current || sendingQueued) return;
    if (cloudQueueBlockedRef.current) return;
    if (queuedItems.length === 0) return;
    if (chatStreaming || liveStatus.type !== "idle") return;
    if (!canAdmitNextQueuedItem(queuedDrainState)) return;
    const nextItem = queuedItems[0];
    if (!nextItem) return;
    const nextDraft = withoutRevertTarget(nextItem.draft);
    if (!nextDraft) return;
    // Claim the send slot atomically BEFORE the send can resolve: the
    // engine's busy status can render before the send promise's continuation
    // runs, and claiming late would erase that observation. The claim is
    // per-session (not per-surface), so a split view of this session cannot
    // deliver the same queued item twice.
    if (!claimQueuedSend(props.sessionId, nextItem.id)) return;
    drainingQueueRef.current = true;
    removeQueuedDraftFromStore(props.sessionId, nextItem.id);
    void (async () => {
      try {
        const result = await sendDraft(nextDraft);
        dispatchQueuedDrain(props.sessionId, {
          type: "send_result",
          itemId: nextItem.id,
          outcome: result.outcome,
          at: Date.now(),
        });
        if (result.outcome === "blocked") {
          cloudQueueBlockedRef.current = true;
          prependQueuedDrafts(props.sessionId, [{ id: nextItem.id, draft: nextDraft }]);
        } else if (result.outcome === "cancelled") {
          prependQueuedDrafts(props.sessionId, [{ id: nextItem.id, draft: nextDraft }]);
        } else {
          nextDraft.attachments.forEach(revokeAttachmentPreview);
        }
      } catch {
        dispatchQueuedDrain(props.sessionId, { type: "send_error", itemId: nextItem.id });
        prependQueuedDrafts(props.sessionId, [{ id: nextItem.id, draft: nextDraft }]);
      } finally {
        drainingQueueRef.current = false;
      }
    })();
  }, [chatStreaming, cloudQueueRetryVersion, liveStatus.type, prependQueuedDrafts, props.sessionId, queuedDrainState, queuedItems, removeQueuedDraftFromStore, sendDraft, sendingQueued]);

  useEffect(() => {
    if (props.cloudMcpSubmissionState.status !== "failed") {
      cloudQueueBlockedRef.current = false;
      // A cleared submission gate releases a drain halted on needs_input; a
      // terminal_failure halt stays until the user explicitly retries.
      const drain = getQueuedDrainState(props.sessionId);
      if (drain.phase.kind === "halted" && drain.phase.reason === "needs_input") {
        dispatchQueuedDrain(props.sessionId, { type: "user_retry" });
      }
    }
  }, [props.cloudMcpSubmissionState.status, props.sessionId]);

  useEffect(() => {
    if (hydratedDraftScopeKey !== persistedDraftKey) return;
    const nextDraft = buildDraft(draft, attachments);
    const persistableText = persistableComposerDraftText(nextDraft.text);
    persistDraft({ text: persistableText, mode: nextDraft.mode });
    props.onDraftChange(nextDraft);
  }, [attachments, buildDraft, draft, hydratedDraftScopeKey, persistDraft, persistedDraftKey, props.onDraftChange]);

  const handleAttachFiles = useCallback((files: File[]) => {
    if (!props.attachmentsEnabled) {
      toast.warning(props.attachmentsDisabledReason ?? "Attachments are unavailable.");
      return;
    }
    // Any file type and size is accepted: model-readable formats become file
    // parts, everything else is copied into the workspace so the model reads
    // it with tools (see modelFacingAttachmentMime in attachment-file-part.ts).
    // Oversized files are rejected by the upload endpoint or provider with
    // their own errors instead of an opinionated composer cap.
    if (!files.length) return;
    const next = files.map((file) => {
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
    setComposerAttachments(props.sessionId, [...attachments, ...next]);
    // Inline attachment chips live in the draft as Lexical tokens (same
    // pattern as pasted-text chips), so they sit in the text flow.
    setComposerDraft(
      props.sessionId,
      `${draft}${next.map((attachment) => `[attachment ${attachment.id}]`).join("")}`,
    );
  }, [
    attachments,
    draft,
    props.attachmentsDisabledReason,
    props.attachmentsEnabled,
    props.sessionId,
    setComposerAttachments,
    setComposerDraft,
  ]);

  const handleRemoveAttachment = useCallback((id: string) => {
    const target = attachments.find((item) => item.id === id);
    if (target?.previewUrl) {
      URL.revokeObjectURL(target.previewUrl);
    }
    setComposerAttachments(props.sessionId, attachments.filter((item) => item.id !== id));
    setComposerDraft(props.sessionId, draft.replaceAll(`[attachment ${id}]`, ""));
  }, [attachments, draft, props.sessionId, setComposerAttachments, setComposerDraft]);

  const handleInsertMention = useCallback((kind: ComposerMentionKind, value: string) => {
    // @agent mentions switch the session agent instead of inserting an agent
    // part. Agent parts are treated as *subagent* (task tool) calls by the
    // engine, which silently fails for primary agents and left every reply
    // coming from the default agent (#2101).
    if (kind === "agent") {
      setComposerDraft(props.sessionId, draft.replace(/@([^\s@]*)$/, ""));
      props.onSelectAgent(value);
      toast.success(t("composer.agent_selected", { agent: value }));
      return;
    }
    setComposerDraft(props.sessionId, draft.replace(/@([^\s@]*)$/, `@${encodeComposerMentionValue(value)} `));
    setComposerMentions(props.sessionId, { ...mentions, [value]: kind });
    // Pre-flight Computer Use permissions when an app is mentioned so missing
    // Accessibility / Screen Recording grants surface before send, not as a
    // mid-task failure. Only ever runs on macOS desktop (apps aren't offered
    // elsewhere); errors are silently ignored.
    if (kind === "app") {
      void (async () => {
        try {
          const status = (await desktopBridge.checkComputerUsePermissions()) as { ok?: boolean };
          if (status.ok === true) return;
          toast.warning(t("composer.computer_use_permissions_missing", { app: value }), {
            action: {
              label: t("composer.computer_use_permissions_setup"),
              onClick: () => void desktopBridge.openComputerUsePermissionSetup(),
            },
          });
        } catch {
          // Desktop bridge unavailable — nothing to pre-flight.
        }
      })();
    }
  }, [draft, mentions, props.onSelectAgent, props.sessionId, setComposerDraft, setComposerMentions]);

  const handlePasteText = useCallback((text: string) => {
    const pasted = createPastedTextChip(text);
    setComposerPasteParts(props.sessionId, [...pasteParts, pasted]);
    setComposerDraft(props.sessionId, `${draft}[pasted text ${pasted.label}]`);
  }, [draft, pasteParts, props.sessionId, setComposerDraft, setComposerPasteParts]);

  const handleExpandPastedText = useCallback((id: string) => {
    const part = pasteParts.find((item) => item.id === id);
    if (!part) return;
    setComposerDraft(props.sessionId, draft.replace(`[pasted text ${part.label}]`, part.text));
    setComposerPasteParts(props.sessionId, pasteParts.filter((item) => item.id !== id));
  }, [draft, pasteParts, props.sessionId, setComposerDraft, setComposerPasteParts]);

  const handleRemovePastedText = useCallback((id: string) => {
    const target = pasteParts.find((item) => item.id === id);
    if (!target) return;
    setComposerDraft(props.sessionId, draft.replace(`[pasted text ${target.label}]`, ""));
    setComposerPasteParts(props.sessionId, pasteParts.filter((item) => item.id !== id));
  }, [draft, pasteParts, props.sessionId, setComposerDraft, setComposerPasteParts]);

  const handleUnsupportedFileLinks = useCallback((links: string[]) => {
    if (!links.length) return;
    setComposerDraft(props.sessionId, `${draft}${draft && !draft.endsWith("\n") ? "\n" : ""}${links.join("\n")}`);
  }, [draft, props.sessionId, setComposerDraft]);

  const typeComposerText = useCallback(async (text: string, revertMessageId?: string | null) => {
    window.dispatchEvent(new Event("openwork:focusPrompt"));
    replaceComposerDraft(props.sessionId, text, revertMessageId);
    await waitForControl(40);
  }, [props.sessionId, replaceComposerDraft]);

  useEffect(() => {
    const handleVoiceTranscript = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!detail || typeof detail !== "object" || Array.isArray(detail) || !("text" in detail) || typeof detail.text !== "string") return;
      const text = detail.text;
      void typeComposerText(text);
      props.onDraftChange(buildDraft(text, attachments));
      recordInspectorEvent("voice.transcript.applied", {
        workspaceId: props.workspaceId,
        sessionId: props.sessionId,
        length: text.length,
      });
    };
    window.addEventListener("openwork:voice-transcript", handleVoiceTranscript);
    return () => window.removeEventListener("openwork:voice-transcript", handleVoiceTranscript);
  }, [attachments, buildDraft, props.onDraftChange, props.sessionId, props.workspaceId, typeComposerText]);

  const composerSetTextControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "composer.set_text",
    label: "Type into the composer",
    description: "Replace the current session draft and type the supplied text visibly.",
    effects: { data: "none", ui: "focus", external: false },
    sideEffect: "none",
    requiresArgs: true,
    args: [{ name: "text", type: "string", required: true, description: "Prompt text to place in the composer." }],
    previewArgs: { text: DEFAULT_COMPOSER_CONTROL_TEXT },
    targetRef: composerShellRef,
    execute: async (args, helpers) => {
      const text = controlTextArgument(args);
      helpers.setNarration(`Typing ${text.length.toLocaleString()} characters into the composer…`);
      await typeComposerText(text);
      props.onDraftChange(buildDraft(text, attachments));
      return { draftLength: text.length };
    },
  }), [attachments, buildDraft, props.onDraftChange, typeComposerText]);
  useControlAction(props.isControlTarget ? composerSetTextControlAction : null);

  const composerSendControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "composer.send",
    label: "Send the composer prompt",
    description: "Send the currently visible composer draft to the active session.",
    sideEffect: "mutation",
    disabled: sessionModelUnavailable || (!draft.trim() && attachments.length === 0) || model.transitionState !== "idle",
    targetRef: composerShellRef,
    execute: async () => {
      await handleSend();
      return true;
    },
  }), [attachments.length, draft, handleSend, model.transitionState, sessionModelUnavailable]);
  useControlAction(props.isControlTarget ? composerSendControlAction : null);

  const composerStopControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "composer.stop",
    label: "Stop the current run",
    description: "Stop the current streaming session run.",
    sideEffect: "mutation",
    disabled: !chatStreaming,
    targetRef: composerShellRef,
    execute: async () => {
      await handleAbort();
      return true;
    },
  }), [chatStreaming, handleAbort]);
  useControlAction(props.isControlTarget ? composerStopControlAction : null);

  const listSkills = useCallback(async (): Promise<SkillCard[]> => {
    const pushId = ++skillsConnectPushRef.current;
    // Paint cached Connect inventory instantly; the fresh fan-out lands live.
    const scope = readCloudInventoryScope();
    const cachedConnect = (scope ? readCachedConnectCapabilities(scope) : null) ?? EMPTY_CONNECT_CAPABILITY_INVENTORY;
    const connectPromise = loadSessionConnectCapabilities();
    const response = await props.client.listSkills(props.workspaceId, { includeGlobal: true });
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
      setToolSkills([...localSkills, ...connect.skills]);
    });
    const next = [...localSkills, ...cachedConnect.skills];
    setToolSkills(next);
    return next;
  }, [props.client, props.workspaceId]);

  const listMcp = useCallback(async (): Promise<{ servers: McpServerEntry[]; statuses: McpStatusMap; status: string | null }> => {
    const pushId = ++mcpConnectPushRef.current;
    const scope = readCloudInventoryScope();
    const cachedConnect = (scope ? readCachedConnectCapabilities(scope) : null) ?? EMPTY_CONNECT_CAPABILITY_INVENTORY;
    const connectPromise = loadSessionConnectCapabilities();
    const localMcpPromise = props.client.listMcp(props.workspaceId);
    const directory = props.workspaceRoot.trim();
    const localStatusesPromise: Promise<McpStatusMap> = directory
      ? (async () => {
        try {
          return unwrap(await opencodeClient.mcp.status({ directory })) as McpStatusMap;
        } catch {
          return {};
        }
      })()
      : Promise.resolve({});
    const [response, localStatuses] = await Promise.all([localMcpPromise, localStatusesPromise]);
    const localServers = (response.items ?? []).map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
      source: entry.source,
      origin: entry.name === "openwork-cloud" ? "openwork-connect" : "local",
    } satisfies McpServerEntry));

    void connectPromise.then((connect) => {
      if (mcpConnectPushRef.current !== pushId) return;
      const freshServers = [...localServers, ...connect.mcpServers];
      const freshStatuses = { ...connect.mcpStatuses, ...localStatuses };
      const freshStatus = freshServers.length ? null : "No MCP servers loaded.";
      setToolMcpServers(freshServers);
      setToolMcpStatuses(freshStatuses);
      setToolMcpStatus(freshStatus);

      // Quiet self-heal: remote OAuth connectors whose access token expired
      // show "Sign in needed" even though the stored refresh token still
      // works. `mcp.connect` retries the refresh grant on a fresh transport
      // without ever opening a browser; on success the badge flips live.
      if (directory && localServers.length) {
        void attemptSilentMcpReauth({
          client: opencodeClient,
          directory,
          servers: localServers,
          statuses: localStatuses,
        })
          .then(async (attempted) => {
            if (!attempted) return;
            const healed = unwrap(await opencodeClient.mcp.status({ directory })) as McpStatusMap;
            if (mcpConnectPushRef.current !== pushId) return;
            setToolMcpStatuses({ ...connect.mcpStatuses, ...healed });
          })
          .catch(() => {
            // Best-effort; the manual Sign in path is unaffected.
          });
      }
    });

    const servers = [...localServers, ...cachedConnect.mcpServers];
    const statuses = { ...cachedConnect.mcpStatuses, ...localStatuses };
    const status = servers.length ? null : "No MCP servers loaded.";
    setToolMcpServers(servers);
    setToolMcpStatuses(statuses);
    setToolMcpStatus(status);

    return { servers, statuses, status };
  }, [opencodeClient, props.client, props.workspaceId, props.workspaceRoot]);

  const listImportedPlugins = useCallback(async (): Promise<CloudImportedPlugin[]> => {
    const pushId = ++pluginConnectPushRef.current;
    const scope = readCloudInventoryScope();
    const cachedConnect = (scope ? readCachedConnectCapabilities(scope) : null) ?? EMPTY_CONNECT_CAPABILITY_INVENTORY;
    const connectPromise = loadSessionConnectCapabilities();
    void connectPromise.then((connect) => {
      if (pluginConnectPushRef.current !== pushId) return;
      setToolImportedPlugins(connectPluginsForComposer(connect.plugins));
    });
    const plugins = connectPluginsForComposer(cachedConnect.plugins);
    setToolImportedPlugins(plugins);
    return plugins;
  }, []);

  const handleUploadInboxFiles = useCallback(async (files: File[]) => {
    const input = files.filter(Boolean);
    if (!input.length) return;
    try {
      const results = await Promise.all(input.map((file) => props.client.uploadInbox(props.workspaceId, file)));
      return results;
    } catch (nextError) {
      toast.warning(nextError instanceof Error ? nextError.message : "Shared folder upload failed");
      throw nextError;
    }
  }, [props.client, props.workspaceId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sessionScroll = useSessionScrollController({
    selectedSessionId: props.sessionId,
    renderedMessages,
    containerRef: scrollRef,
    contentRef,
  });

  const handleFindBeforeJump = useCallback(() => {
    sessionScroll.markScrollGesture(scrollRef.current);
  }, [sessionScroll.markScrollGesture]);

  const handleFindSurfaceInteraction = useCallback(() => {
    setFindLastFocused(props.sessionId);
  }, [props.sessionId, setFindLastFocused]);

  const handleFindShortcut = useEffectEvent((event: KeyboardEvent) => {
    const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod || event.shiftKey || event.altKey || event.key?.toLowerCase() !== "f") return;

    event.preventDefault();
    if (resolveFindOwnerSessionId() === props.sessionId) {
      useSessionFindStore.getState().openFind({ sessionId: props.sessionId });
    }
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleFindShortcut(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const state = useSessionFindStore.getState();
    if (state.open && state.sessionId && state.sessionId !== props.sessionId && !isSessionSurfaceMounted(state.sessionId)) {
      state.closeFind();
    }
  }, [props.sessionId]);

  const sessionIdRef = useRef(props.sessionId);
  useEffect(() => {
    sessionIdRef.current = props.sessionId;
  }, [props.sessionId]);
  useEffect(() => () => {
    const state = useSessionFindStore.getState();
    if (state.sessionId === sessionIdRef.current) {
      state.closeFind();
    }
  }, []);

  const handleMessageListDispatchAction = useCallback((action: DispatchAction) => {
    if (action.target === "settings" && action.action === "open") {
      props.onOpenSettingsSection?.(action.section);
    }
  }, [props.onOpenSettingsSection]);

  const handleMessageListSetPrompt = useCallback((prompt: string) => {
    void typeComposerText(prompt);
  }, [typeComposerText]);

  // Explicit user click on the interrupted-run error card or the
  // outcome-unknown recovery card. Re-submits the classified recovery prompt
  // through the normal send path so the agent continues the interrupted task
  // in this session instead of restarting it. The single-flight guard drops
  // (never queues) repeat clicks while one resume is in flight, so rapid
  // clicking admits exactly one recovery prompt.
  const resumeGuardRef = useRef(createSingleFlight());
  const [resuming, setResuming] = useState(false);
  const handleResumeInterrupted = useCallback(async (recoveryPrompt: string) => {
    await resumeGuardRef.current.run(async () => {
      setResuming(true);
      try {
        await sendDraft({
          mode: "prompt",
          parts: [{ type: "text", text: recoveryPrompt }],
          attachments: [],
          text: recoveryPrompt,
        });
      } catch {
        // sendDraft already surfaced the failure on the session error state.
      } finally {
        setResuming(false);
      }
    });
  }, [sendDraft]);
  const handleResumeUnknownOutcome = useCallback(() => {
    void handleResumeInterrupted(interruptedTaskRecoveryPrompt);
  }, [handleResumeInterrupted]);

  useEffect(() => {
    const resetReconnectState = () => {
      useChatMcpReconnectStore.getState().reset();
      clearCloudInventoryCache();
      setToolSkills((current) => current.filter((skill) => skill.origin !== "openwork-connect"));
      setToolMcpServers((current) => current.filter((server) => server.origin !== "openwork-connect"));
      setToolMcpStatuses((current) => Object.fromEntries(
        Object.entries(current).filter(([key]) => !key.startsWith("openwork-connect:")),
      ));
    };
    const refreshImportedPlugins = () => {
      void listImportedPlugins();
    };
    window.addEventListener(denSettingsChangedEvent, resetReconnectState);
    window.addEventListener(CLOUD_INVENTORY_CHANGED_EVENT, refreshImportedPlugins);
    return () => {
      window.removeEventListener(denSettingsChangedEvent, resetReconnectState);
      window.removeEventListener(CLOUD_INVENTORY_CHANGED_EVENT, refreshImportedPlugins);
    };
  }, []);

  const handleMcpReconnect = useCallback(async (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
  ): Promise<ChatToolReconnectResult> => {
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const organizationId = settings.activeOrgId?.trim() ?? "";
    if (!token || !organizationId) {
      props.onOpenConnect();
      throw new Error("Sign in to OpenWork Cloud, then try reconnecting again.");
    }

    const scope: ChatMcpReconnectScope = {
      baseUrl: settings.baseUrl,
      token,
      organizationId,
    };
    const currentScope = (): ChatMcpReconnectScope => {
      const current = readDenSettings();
      return {
        baseUrl: current.baseUrl,
        token: current.authToken?.trim() ?? "",
        organizationId: current.activeOrgId?.trim() ?? "",
      };
    };
    try {
      const denClient = createDenClient({ baseUrl: settings.baseUrl, token });
      const connections = await denClient.listMcpConnections(organizationId, "usable");
      const connection = connections.find((entry) => entry.id === action.connectionId);
      if (!connection || connection.authType !== "oauth" || connection.credentialMode !== "per_member") {
        throw new Error(`${action.connectionName} is no longer available as your reconnectable account.`);
      }

      recordInspectorEvent("mcp.chat_reconnect.started", {
        workspaceId: props.workspaceId,
        sessionId: props.sessionId,
        connectionId: action.connectionId,
      });
      onProgress({ phase: "opening" });
      const result = await denClient.startMcpConnectionConnect(organizationId, action.connectionId);
      if (result.status === "connected") {
        recordInspectorEvent("mcp.chat_reconnect.completed", {
          workspaceId: props.workspaceId,
          sessionId: props.sessionId,
          connectionId: action.connectionId,
          completion: "already_connected",
        });
        return "connected";
      }
      if (!result.authorizeUrl) throw new Error(`Could not start ${action.connectionName} authorization.`);

      await openDesktopUrl(result.authorizeUrl);
      onProgress({ phase: "authorization_opened", authorizeUrl: result.authorizeUrl });
      await waitForFreshMcpAuthorization({
        connectionId: action.connectionId,
        connectionName: action.connectionName,
        previousConnectedAt: connection.connectedAt,
        listConnections: () => denClient.listMcpConnections(organizationId, "usable"),
        isScopeCurrent: () => isChatMcpReconnectScopeCurrent(scope, currentScope()),
      });
      recordInspectorEvent("mcp.chat_reconnect.completed", {
        workspaceId: props.workspaceId,
        sessionId: props.sessionId,
        connectionId: action.connectionId,
        completion: "fresh_authorization",
      });
      return "connected";
    } catch (error) {
      recordInspectorEvent("mcp.chat_reconnect.failed", {
        workspaceId: props.workspaceId,
        sessionId: props.sessionId,
        connectionId: action.connectionId,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  }, [props.onOpenConnect, props.sessionId, props.workspaceId]);

  const handleMcpReopenAuthorization = useCallback(async (
    action: ChatToolReconnectAction,
    authorizeUrl: string,
  ) => {
    await openDesktopUrl(authorizeUrl);
    recordInspectorEvent("mcp.chat_reconnect.authorization_reopened", {
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
      connectionId: action.connectionId,
    });
  }, [props.sessionId, props.workspaceId]);

  const handleMcpRetry = useCallback(async (action: ChatToolReconnectAction) => {
    const prompt = `The ${action.connectionName} connection is restored. Search for the capability again and retry the previous request. Before repeating any write action, confirm it did not already complete.`;
    await typeComposerText(prompt);
    props.onDraftChange(buildDraft(prompt, attachments));
    recordInspectorEvent("mcp.chat_reconnect.retry_drafted", {
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
      connectionId: action.connectionId,
    });
  }, [attachments, buildDraft, props.onDraftChange, props.sessionId, props.workspaceId, typeComposerText]);

  const handleRevertToUserMessage = useCallback((messageId: string) => {
    void props.onRevertToMessage?.(messageId, props.sessionId);
  }, [props.onRevertToMessage, props.sessionId]);

  const handleForkAtMessage = useCallback((messageId: string) => {
    // OpenCode's fork copies messages strictly before the given id, so pass
    // the next real message to make the branch include the clicked message.
    props.onForkAtMessage?.(resolveForkBoundaryId(renderedMessagesRef.current, messageId), props.sessionId);
  }, [props.onForkAtMessage, props.sessionId]);

  const handleEditUserMessage = useCallback((messageId: string, text: string) => {
    // Preserve the boundary with the draft; the destructive revert is deferred
    // until the replacement prompt is actually sent.
    void typeComposerText(text, messageId);
  }, [typeComposerText]);

  const handleRestoreRevertedSession = useCallback(() => {
    if (!props.onRestoreRevertedSession || restoringRevertedMessages) return;
    setRestoringRevertedMessages(true);
    void props.onRestoreRevertedSession(props.sessionId)
      .finally(() => setRestoringRevertedMessages(false));
  }, [props.onRestoreRevertedSession, props.sessionId, restoringRevertedMessages]);

  const sessionScrollTopControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.scroll_top",
    label: "Go to the top of the session",
    description: "Scroll the visible session transcript to the first messages.",
    effects: { data: "none", ui: "focus", external: false },
    sideEffect: "none",
    execute: () => {
      const container = scrollRef.current;
      if (!container) return { ok: false, error: "Session transcript is not mounted" };
      container.scrollTo({ top: 0, behavior: "smooth" });
      return { ok: true, position: "top" };
    },
  }), []);
  useControlAction(props.isControlTarget ? sessionScrollTopControlAction : null);

  const sessionScrollBottomControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.scroll_bottom",
    label: "Go to the bottom of the session",
    description: "Scroll the visible session transcript to the newest messages and composer area.",
    effects: { data: "none", ui: "focus", external: false },
    sideEffect: "none",
    execute: () => {
      sessionScroll.jumpToLatest("smooth");
      return { ok: true, position: "bottom" };
    },
  }), [sessionScroll.jumpToLatest]);
  useControlAction(props.isControlTarget ? sessionScrollBottomControlAction : null);

  const sessionLatestMessageControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.latest_message",
    label: "Read the latest session message",
    description: "Return the latest visible message in the current session transcript.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    execute: () => {
      const message = renderedMessages[renderedMessages.length - 1];
      if (!message) return { ok: false, error: "No messages are visible in this session" };
      return {
        ok: true,
        sessionId: props.sessionId,
        index: renderedMessages.length - 1,
        role: message.role,
        text: messageToReadableText(message),
      };
    },
  }), [props.sessionId, renderedMessages]);
  useControlAction(props.isControlTarget ? sessionLatestMessageControlAction : null);

  const sessionReadTranscriptControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.read_transcript",
    label: "Read the current session transcript",
    description: "Return the last messages from the current session transcript as readable text, including the session ID, title, and message count.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    args: [{ name: "count", type: "number", required: false, description: "Number of recent messages to return, from 1 to 30. Defaults to 10." }],
    execute: (args) => {
      const count = typeof args === "object" && args !== null && "count" in args && typeof (args as { count?: unknown }).count === "number"
        ? Math.min(Math.max(1, (args as { count: number }).count), 30)
        : 10;
      const total = renderedMessages.length;
      const slice = renderedMessages.slice(-count);
      if (!slice.length) return { ok: false, error: "No messages in this session" };
      return {
        ok: true,
        sessionId: props.sessionId,
        messageCount: total,
        returned: slice.length,
        messages: slice.map((message, index) => ({
          index: total - slice.length + index,
          role: message.role,
          text: messageToReadableText(message),
        })),
      };
    },
  }), [props.sessionId, renderedMessages]);
  useControlAction(props.isControlTarget ? sessionReadTranscriptControlAction : null);

  return (
    <DevProfiler id="SessionSurface">
    <div
      data-session-surface-id={props.sessionId}
      data-session-surface-workspace-id={props.workspaceId}
      onPointerDownCapture={handleFindSurfaceInteraction}
      onFocusCapture={handleFindSurfaceInteraction}
      className="flex h-full min-h-0 flex-col"
    >
      {model.transitionState === "switching" && showDelayedLoading ? (
        <div className="flex justify-center px-6 pt-4">
          <div className="rounded-full border border-dls-border bg-dls-hover/80 px-3 py-1 text-xs text-dls-secondary">
            {model.renderSource === "cache" ? "Switching session from cache..." : "Switching session..."}
          </div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onWheel={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onTouchStart={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onTouchMove={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget) return;
            sessionScroll.markScrollGesture(event.currentTarget);
          }}
          onScroll={sessionScroll.handleScroll}
          // Extra top padding while the find bar is open so it never covers
          // the first message (short transcripts cannot scroll it clear).
          className={`absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-y-contain touch-pan-y px-3 pb-4 sm:px-5 ${findOwned ? "pt-16" : "pt-4"}`}
        >
          {/* Chat column: tighter than the composer (800px) so messages
               keep a comfortable reading width and don't feel "too big". */}
          <div ref={contentRef} className="mx-auto w-full max-w-[720px]">
            {revertMessageId ? (
              <RevertedMessagesBanner
                hiddenCount={revertedMessageCount}
                restoring={restoringRevertedMessages}
                onRestore={handleRestoreRevertedSession}
              />
            ) : null}
            {error && snapshot && snapshot.messages.length > 0 ? (
              <SessionErrorCard
                error={error}
                onDismiss={handleDismissError}
                onChangeModel={handleModelChange}
                onOpenModelPicker={handleOpenModelPicker}
              />
            ) : null}
            {showDelayedLoading && pendingSessionLoad ? (
              <div className="px-6 py-16">
                <div className="mx-auto max-w-sm rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center">
                  <div className="text-sm text-dls-secondary">Opening session…</div>
                </div>
              </div>
            ) : (snapshotQuery.isError || error) && !snapshot && renderedMessages.length === 0 ? (
              <div className="px-6 py-8">
                {error ? (
                  <SessionErrorCard
                    error={error}
                    onDismiss={handleDismissError}
                    onChangeModel={handleModelChange}
                    onOpenModelPicker={handleOpenModelPicker}
                  />
                ) : (
                  <div className="mx-auto max-w-xl rounded-3xl border border-red-6/40 bg-red-3/20 px-6 py-5 text-sm text-red-11">
                    {snapshotQuery.error instanceof Error ? snapshotQuery.error.message : "Failed to load session."}
                  </div>
                )}
              </div>
            ) : renderedMessages.length === 0 && effectiveActivityStatus !== "idle" ? (
              <div className="px-6 py-12">
                <AssistantWaitingCard label={getSessionActivityStatusLabel(effectiveActivityStatus)} />
              </div>
            ) : renderedMessages.length === 0 && snapshot && snapshot.messages.length === 0 && error ? (
              <SessionErrorCard
                error={error}
                onDismiss={handleDismissError}
                onChangeModel={handleModelChange}
                onOpenModelPicker={handleOpenModelPicker}
              />
            ) : (
              <DevProfiler id="MessageList">
                <OpenTargetProvider
                  openTargets={verifiedOpenTargets}
                  onOpenTarget={handleOpenTarget}
                >
                  <EnvironmentVariableProvider
                    client={props.isRemoteWorkspace ? null : props.environmentClient ?? props.client}
                    runtimeKey={props.environmentRuntimeKey}
                    onApplyChanges={props.onApplyEnvironmentChanges}
                  >
                    <MessageListProvider
                      workspaceId={props.workspaceId}
                      sessionId={props.sessionId}
                      showThinking={showThinking}
                      highlightQuery={findHighlightQuery}
                      developerMode={props.developerMode}
                      displaySuggestions={shellConfig.starterCards}
                      providerConnectedCount={props.providerConnectedCount ?? 0}
                      connectorIdentities={connectorIdentities}
                      syncDegraded={runSyncHealth.degraded}
                      dispatchAction={handleMessageListDispatchAction}
                      setPrompt={handleMessageListSetPrompt}
                      onRevertToUserMessage={handleRevertToUserMessage}
                      onForkAtMessage={handleForkAtMessage}
                      onEditUserMessage={handleEditUserMessage}
                      onOpenSubagentSession={props.onOpenSubagentSession}
                      onResumeInterrupted={handleResumeInterrupted}
                      onMcpReconnect={handleMcpReconnect}
                      onMcpReopenAuthorization={handleMcpReopenAuthorization}
                      onMcpRetry={handleMcpRetry}
                    >
                      <MessageList
                        messages={renderedMessages}
                        status={status}
                        activityStatus={effectiveActivityStatus}
                        retryStatus={liveStatus.type === "retry" ? liveStatus : null}
                        syncHealth={runSyncHealth}
                      />
                    </MessageListProvider>
                  </EnvironmentVariableProvider>
                </OpenTargetProvider>
              </DevProfiler>
            )}
            {admissionOutcomeUnresolved && renderedMessages.length > 0 ? (
              <AdmissionOutcomeUnknownCard
                resuming={resuming}
                onResume={handleResumeUnknownOutcome}
              />
            ) : null}
          </div>
        </div>
        <SessionScrollOverlay
          sessionId={props.sessionId}
          isStreaming={chatStreaming}
          onJumpToLatest={sessionScroll.jumpToLatest}
          onJumpToStartOfMessage={sessionScroll.jumpToStartOfMessage}
        />
        <SessionFindBar
          sessionId={props.sessionId}
          scrollRef={scrollRef}
          onBeforeJump={handleFindBeforeJump}
        />
      </div>

      <div ref={composerShellRef} className="shrink-0 px-0 pb-2 pt-2">
        {(props.providerConnectedCount ?? 0) === 0 ? (
          <button
            type="button"
            className="mx-3 mb-2 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border border-amber-7/40 bg-amber-2/30 px-3 py-2 text-left text-xs text-amber-11 transition-colors hover:bg-amber-3/40"
            onClick={() => props.onOpenSettingsSection?.("providers")}
          >
            <span className="font-medium">No AI model connected.</span>
            <span className="text-amber-11/70">Add a provider to run tasks.</span>
          </button>
        ) : null}
        {props.cloudMcpSubmissionState.status === "failed" ? (
          <div
            className="mx-3 mb-2 flex items-center gap-3 rounded-xl border border-red-7/40 bg-red-2/40 px-3 py-2 text-xs text-red-11"
            data-testid="cloud-mcp-submission-failure"
          >
            <span className="min-w-0 flex-1">
              {[
                props.cloudMcpSubmissionState.issue?.message ?? "Connected service tools could not be prepared.",
                props.cloudMcpSubmissionState.issue?.recommendedAction,
              ].filter(Boolean).join(" ")}
            </span>
            {props.cloudMcpSubmissionState.issue?.retryable !== false ? (
              <button type="button" className="font-medium hover:underline" onClick={handleRetryCloudSubmission}>
                Retry
              </button>
            ) : null}
            <button type="button" className="font-medium hover:underline" onClick={props.onOpenConnect}>
              Open Connect
            </button>
          </div>
        ) : null}
        <ReactSessionComposer
          draft={draft}
          mentions={mentions}
          onDraftChange={handleComposerDraftChange}
        onSend={handleSend}
        onSteer={handleSteer}
        onQueue={handleQueue}
        onStop={handleAbort}
        busy={chatStreaming}
        steering={steering}
        submissionPreparing={preparingCloudTools}
        queuedCount={queuedItems.length}
        disabled={model.transitionState !== "idle" || sessionModelUnavailable}
        modelUnavailable={sessionModelUnavailable}
        modelUnavailableMessage={sessionModelUnavailable ? props.modelUnavailableMessage : null}
        organizationModelsEmpty={props.organizationModelsEmpty}
        statusLabel={statusLabel(snapshot ?? undefined, chatStreaming)}
        modelPickerOpen={modelPickerOpen}
        selectedModel={sessionModel.selectedModel}
        openWorkModelsEntitled={props.openWorkModelsEntitled}
        openWorkModelsSyncing={props.openWorkModelsSyncing}
        onRefreshOrganizationModels={props.onRefreshOrganizationModels}
        onModelPickerOpenChange={handleModelPickerOpenChange}
        onModelChange={handleModelChange}
        sessionId={props.sessionId}
        attachments={attachments}
        attachmentsUploading={attachmentsUploading}
        onAttachFiles={handleAttachFiles}
        onRemoveAttachment={handleRemoveAttachment}
        attachmentsEnabled={props.attachmentsEnabled}
        attachmentsDisabledReason={props.attachmentsDisabledReason}
        modelVariantLabel={sessionModel.modelVariantLabel}
        modelVariant={sessionModel.modelVariant}
        modelBehaviorOptions={sessionModel.modelBehaviorOptions}
        onModelVariantChange={handleModelVariantChange}
        agentLabel={props.agentLabel}
        selectedAgent={props.selectedAgent}
        listAgents={props.listAgents}
        onSelectAgent={props.onSelectAgent}
        listCommands={props.listCommands}
        listSkills={listSkills}
        skills={toolSkills}
        listMcp={listMcp}
        mcpServers={toolMcpServers}
        mcpStatus={toolMcpStatus}
        mcpStatuses={toolMcpStatuses}
        listImportedPlugins={listImportedPlugins}
        importedPlugins={toolImportedPlugins}
        onOpenSettingsSection={props.onOpenSettingsSection}
        recentFiles={props.recentFiles}
        searchFiles={props.searchFiles}
        onInsertMention={handleInsertMention}
        inputHistory={inputHistory}
        onPasteText={handlePasteText}
        onUnsupportedFileLinks={handleUnsupportedFileLinks}
        pastedText={pasteParts}
        onExpandPastedText={handleExpandPastedText}
        onRemovePastedText={handleRemovePastedText}
        isRemoteWorkspace={props.isRemoteWorkspace}
          isSandboxWorkspace={props.isSandboxWorkspace}
          onUploadInboxFiles={props.onUploadInboxFiles ?? handleUploadInboxFiles}
          compactTopSpacing={Boolean(props.activeQuestion || (props.todos ?? []).some((todo) => todo.content.trim()) || props.activePermission || queuedItems.length > 0)}
          topAccessory={
            props.activeQuestion || (props.todos ?? []).some((todo) => todo.content.trim()) || props.activePermission || queuedItems.length > 0 ? (
              <div>
                {queuedItems.length > 0 ? (
                  <QueuedMessagesPanel
                    items={queuedItems}
                    onRemove={removeQueuedDraft}
                    onSendNow={(id) => void sendQueuedDraftNow(id)}
                    onReorder={(ids) => reorderQueuedDrafts(props.sessionId, ids)}
                    onEdit={editQueuedDraft}
                    sending={sendingQueued}
                  />
                ) : null}
                {props.activeQuestion ? (
                  <QuestionPanel
                    questions={props.activeQuestion.questions}
                    busy={props.questionReplyBusy ?? false}
                    onReply={(answers) => {
                      if (props.activeQuestion) {
                        props.respondQuestion?.(props.activeQuestion.id, answers);
                      }
                    }}
                  />
                ) : (props.todos ?? []).some((todo) => todo.content.trim()) ? (
                  <TodoPanel todos={props.todos ?? []} />
                ) : null}
                {props.activePermission ? (
                  <PermissionApprovalPanel
                    permission={props.activePermission}
                    busy={props.permissionReplyBusy}
                    respondPermission={props.respondPermission}
                    safeStringify={props.safeStringify}
                  />
                ) : null}
              </div>
            ) : null
          }
        />
      </div>
      {/* Error display moved inline into the session conversation area */}
      {props.developerMode ? <SessionDebugPanel model={model} snapshot={snapshot} /> : null}
    </div>
    </DevProfiler>
  );
}
