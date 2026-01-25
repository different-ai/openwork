import { createMemo, createSignal, type Accessor } from "solid-js";

import type { Client, CommandDefinition, ModelRef, WorkspaceCommand } from "./types";
import { buildCommandDraft, resetCommandDraft } from "./utils/commands";
import { addOpencodeCacheHint, isTauriRuntime, parseModelRef, safeStringify } from "./utils";
import { opencodeCommandDelete, opencodeCommandList, opencodeCommandWrite } from "./lib/tauri";
import { unwrap } from "./lib/opencode";
import { t, currentLocale } from "../i18n";

const COMMANDS_PATH = ".opencode/commands";
const COMMAND_FILE_SUFFIX = ".md";
const COMMAND_ARGS_RE = /\$(ARGUMENTS|\d+)/i;

const sanitizeCommandName = (value: string) => {
  const trimmed = value.trim().replace(/^\/+/, "");
  if (!trimmed) return "";
  const normalized = trimmed.replace(/\s+/g, "-");
  const cleaned = normalized.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned.replace(/-+/g, "-");
};

const seedCommandName = (value: string) => sanitizeCommandName(value.toLowerCase());

const commandNeedsDetails = (command: { template: string }) => COMMAND_ARGS_RE.test(command.template);

export function createCommandState(options: {
  client: Accessor<Client | null>;
  selectedSession: Accessor<{ title?: string } | null>;
  prompt: Accessor<string>;
  lastPromptSent: Accessor<string>;
  loadSessions: (scopeRoot?: string) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  setSessionModelById: (value: Record<string, ModelRef> | ((current: Record<string, ModelRef>) => Record<string, ModelRef>)) => void;
  setSessionAgent: (sessionId: string, agent: string | null) => void;
  defaultModel: Accessor<ModelRef>;
  modelVariant: Accessor<string | null>;
  setView: (view: "onboarding" | "dashboard" | "session") => void;
  isDemoMode: Accessor<boolean>;
  activeWorkspaceRoot: Accessor<string>;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setError: (value: string | null) => void;
}) {
  const [commands, setCommands] = createSignal<WorkspaceCommand[]>([]);
  const [commandsLoaded, setCommandsLoaded] = createSignal(false);

  const [commandModalOpen, setCommandModalOpen] = createSignal(false);
  const [commandDraftName, setCommandDraftName] = createSignal("");
  const [commandDraftDescription, setCommandDraftDescription] = createSignal("");
  const [commandDraftTemplate, setCommandDraftTemplate] = createSignal("");
  const [commandDraftScope, setCommandDraftScope] = createSignal<"workspace" | "global">("workspace");

  const [runModalOpen, setRunModalOpen] = createSignal(false);
  const [runModalCommand, setRunModalCommand] = createSignal<WorkspaceCommand | null>(null);
  const [runModalDetails, setRunModalDetails] = createSignal("");

  // Track the just-saved command for scroll-to and highlight animation
  const [justSavedCommand, setJustSavedCommand] = createSignal<{ name: string; scope: string } | null>(null);

  const workspaceCommands = createMemo(() => commands().filter((c) => c.scope === "workspace"));
  const globalCommands = createMemo(() => commands().filter((c) => c.scope === "global"));
  const otherCommands = createMemo(() => commands().filter((c) => c.scope === "unknown"));

  function openCommandModal() {
    const seedTitle = options.selectedSession()?.title ?? "";
    const seedTemplate = options.lastPromptSent() || options.prompt();
    const nextDraft = buildCommandDraft({
      seedName: seedCommandName(seedTitle),
      seedTemplate,
      scope: "workspace",
    });

    resetCommandDraft(
      {
        setName: setCommandDraftName,
        setDescription: setCommandDraftDescription,
        setTemplate: setCommandDraftTemplate,
        setScope: setCommandDraftScope,
      },
      nextDraft.scope,
    );

    setCommandDraftName(nextDraft.name);
    setCommandDraftTemplate(nextDraft.template);
    setCommandModalOpen(true);
  }

  async function saveCommand() {
    const draft = buildCommandDraft({ scope: commandDraftScope() });
    draft.name = commandDraftName().trim();
    draft.description = commandDraftDescription().trim();
    draft.template = commandDraftTemplate().trim();

    const safeName = sanitizeCommandName(draft.name);
    if (!safeName || !draft.template) {
      options.setError(t("app.error.command_name_template_required", currentLocale()));
      return;
    }

    if (!isTauriRuntime()) {
      options.setError(t("app.error.workspace_commands_desktop", currentLocale()));
      return;
    }

    if (draft.scope === "workspace" && !options.activeWorkspaceRoot().trim()) {
      options.setError(t("app.error.pick_workspace_folder", currentLocale()));
      return;
    }

    if (safeName !== draft.name) {
      setCommandDraftName(safeName);
    }

    options.setBusy(true);
    options.setBusyLabel(
      draft.scope === "workspace" ? "status.saving_workspace_command" : "status.saving_command",
    );
    options.setBusyStartedAt(Date.now());
    options.setError(null);

    try {
      const workspaceRoot = options.activeWorkspaceRoot().trim();
      await opencodeCommandWrite({
        scope: draft.scope,
        projectDir: workspaceRoot,
        command: {
          name: safeName,
          description: draft.description || undefined,
          template: draft.template,
        },
      });

      // Directly add/update the command in local state since the SDK's
      // command list won't reflect the new file until app restart
      const newCommand: WorkspaceCommand = {
        name: safeName,
        description: draft.description || undefined,
        template: draft.template,
        scope: draft.scope,
      };

      setCommands((current) => {
        // Check if command already exists (update case)
        const existingIndex = current.findIndex(
          (c) => c.name === safeName && c.scope === draft.scope
        );

        let updated: WorkspaceCommand[];
        if (existingIndex >= 0) {
          // Update existing command
          updated = [...current];
          updated[existingIndex] = newCommand;
        } else {
          // Add new command
          updated = [...current, newCommand];
        }

        // Keep sorted alphabetically
        return updated.sort((a, b) => a.name.localeCompare(b.name));
      });

      setJustSavedCommand({ name: safeName, scope: draft.scope });
      setCommandModalOpen(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function deleteCommand(command: WorkspaceCommand) {
    if (command.scope === "unknown") {
      options.setError(t("app.error.command_scope_unknown", currentLocale()));
      return;
    }

    if (!isTauriRuntime()) {
      options.setError(t("app.error.workspace_commands_desktop", currentLocale()));
      return;
    }

    if (command.scope === "workspace" && !options.activeWorkspaceRoot().trim()) {
      options.setError(t("app.error.pick_workspace_folder", currentLocale()));
      return;
    }

    options.setBusy(true);
    options.setBusyLabel("status.deleting_command");
    options.setBusyStartedAt(Date.now());
    options.setError(null);

    try {
      const workspaceRoot = options.activeWorkspaceRoot().trim();
      await opencodeCommandDelete({
        scope: command.scope,
        projectDir: workspaceRoot,
        name: command.name,
      });
      await loadCommands({ workspaceRoot, quiet: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function runCommand(command: WorkspaceCommand, details?: string) {
    if (options.isDemoMode()) {
      options.setView("session");
      return;
    }

    const c = options.client();
    if (!c) return;

    options.setBusy(true);
    options.setError(null);

    try {
      const session = unwrap(
        await c.session.create({ title: `/${command.name}`, directory: options.activeWorkspaceRoot().trim() }),
      ) as { id: string };
      await options.loadSessions(options.activeWorkspaceRoot().trim());
      await options.selectSession(session.id);
      options.setView("session");

      const commandArgs = details?.trim() ?? "";
      await c.session.command({
        sessionID: session.id,
        command: command.name,
        arguments: commandArgs,
      });

      const override = parseModelRef(command.model ?? null);
      const model = override ?? options.defaultModel();

      options.setSessionModelById((current) => ({
        ...current,
        [session.id]: model,
      }));

      if (command.agent?.trim()) {
        options.setSessionAgent(session.id, command.agent);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : t("app.unknown_error", currentLocale());
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function loadCommands(optionsLoad?: { workspaceRoot?: string; quiet?: boolean }) {
    const c = options.client();
    const root = (optionsLoad?.workspaceRoot ?? options.activeWorkspaceRoot()).trim();
    if (!c) return;

    try {
      const list = unwrap(await c.command.list()) as CommandDefinition[];
      let workspaceNames = new Set<string>();
      let globalNames = new Set<string>();

      if (isTauriRuntime()) {
        if (root) {
          try {
            const names = await opencodeCommandList({ scope: "workspace", projectDir: root });
            workspaceNames = new Set(names);
          } catch {
            workspaceNames = new Set();
          }
        }
        try {
          const names = await opencodeCommandList({ scope: "global", projectDir: root });
          globalNames = new Set(names);
        } catch {
          globalNames = new Set();
        }
      } else if (root) {
        try {
          const nodes = unwrap(
            await c.file.list({ directory: root, path: COMMANDS_PATH }),
          ) as Array<{ name: string; type: "file" | "directory"; ignored?: boolean }>;
          const entries = nodes.filter((n) => !n.ignored && n.type === "file");
          const commandFiles = entries.filter((n) => n.name.toLowerCase().endsWith(COMMAND_FILE_SUFFIX));
          workspaceNames = new Set(
            commandFiles.map((node) => node.name.replace(/\.md$/i, "")),
          );
        } catch {
          workspaceNames = new Set();
        }
      }

      const decorated = list.map((command) => ({
        ...command,
        scope: workspaceNames.has(command.name)
          ? "workspace"
          : globalNames.has(command.name)
            ? "global"
            : "unknown",
      })) as WorkspaceCommand[];

      decorated.sort((a, b) => a.name.localeCompare(b.name));
      setCommands(decorated);
      setCommandsLoaded(true);
    } catch (e) {
      setCommandsLoaded(true);
      if (!optionsLoad?.quiet) {
        const message = e instanceof Error ? e.message : safeStringify(e);
        options.setError(addOpencodeCacheHint(message));
      }
    }
  }

  function openRunModal(command: WorkspaceCommand) {
    if (!commandNeedsDetails(command)) {
      void runCommand(command);
      return;
    }

    setRunModalCommand(command);
    setRunModalDetails("");
    setRunModalOpen(true);
  }

  async function confirmRunModal() {
    const command = runModalCommand();
    if (!command) return;
    const details = runModalDetails();
    setRunModalOpen(false);
    setRunModalCommand(null);
    await runCommand(command, details);
  }

  function closeRunModal() {
    setRunModalOpen(false);
    setRunModalCommand(null);
  }

  function clearJustSavedCommand() {
    setJustSavedCommand(null);
  }

  return {
    commands,
    setCommands,
    commandsLoaded,
    setCommandsLoaded,
    commandModalOpen,
    setCommandModalOpen,
    commandDraftName,
    setCommandDraftName,
    commandDraftDescription,
    setCommandDraftDescription,
    commandDraftTemplate,
    setCommandDraftTemplate,
    commandDraftScope,
    setCommandDraftScope,
    runModalOpen,
    runModalCommand,
    runModalDetails,
    setRunModalDetails,
    workspaceCommands,
    globalCommands,
    otherCommands,
    openCommandModal,
    saveCommand,
    deleteCommand,
    runCommand,
    loadCommands,
    openRunModal,
    confirmRunModal,
    closeRunModal,
    justSavedCommand,
    clearJustSavedCommand,
  };
}
