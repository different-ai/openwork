import { createMemo, createSignal, type Accessor } from "solid-js";

import type { Client, ModelRef, WorkspaceTemplate } from "./types";
import { buildTemplateDraft, createTemplateRecord, resetTemplateDraft } from "./utils/templates";
import { addOpencodeCacheHint, isTauriRuntime, parseTemplateFrontmatter, safeParseJson, safeStringify } from "./utils";
import { workspaceTemplateDelete, workspaceTemplateWrite } from "./lib/tauri";
import { unwrap } from "./lib/opencode";
import { t, currentLocale } from "../i18n";

export function createTemplateState(options: {
  client: Accessor<Client | null>;
  selectedSession: Accessor<{ title?: string } | null>;
  prompt: Accessor<string>;
  lastPromptSent: Accessor<string>;
  loadSessions: (scopeRoot?: string) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  setSessionModelById: (value: Record<string, ModelRef> | ((current: Record<string, ModelRef>) => Record<string, ModelRef>)) => void;
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
  const [templates, setTemplates] = createSignal<WorkspaceTemplate[]>([]);
  const [workspaceTemplatesLoaded, setWorkspaceTemplatesLoaded] = createSignal(false);
  const [globalTemplatesLoaded, setGlobalTemplatesLoaded] = createSignal(false);

  // DEBUG: Track the last template used for debugging purposes
  const [lastUsedTemplate, setLastUsedTemplate] = createSignal<WorkspaceTemplate | null>(null);

  const [templateModalOpen, setTemplateModalOpen] = createSignal(false);
  const [templateDraftTitle, setTemplateDraftTitle] = createSignal("");
  const [templateDraftDescription, setTemplateDraftDescription] = createSignal("");
  const [templateDraftPrompt, setTemplateDraftPrompt] = createSignal("");
  const [templateDraftScope, setTemplateDraftScope] = createSignal<"workspace" | "global">("workspace");
  const [templateDraftAutoRun, setTemplateDraftAutoRun] = createSignal(true);

  const workspaceTemplates = createMemo(() => templates().filter((t) => t.scope === "workspace"));
  const globalTemplates = createMemo(() => templates().filter((t) => t.scope === "global"));

  function openTemplateModal() {
    const seedTitle = options.selectedSession()?.title ?? "";
    const seedPrompt = options.lastPromptSent() || options.prompt();
    const nextDraft = buildTemplateDraft({ seedTitle, seedPrompt, scope: "workspace", autoRun: true });

    resetTemplateDraft(
      {
        setTitle: setTemplateDraftTitle,
        setDescription: setTemplateDraftDescription,
        setPrompt: setTemplateDraftPrompt,
        setScope: setTemplateDraftScope,
        setAutoRun: setTemplateDraftAutoRun,
      },
      nextDraft.scope,
    );

    setTemplateDraftTitle(nextDraft.title);
    setTemplateDraftPrompt(nextDraft.prompt);
    setTemplateModalOpen(true);
  }

  async function saveTemplate() {
    const draft = buildTemplateDraft({ scope: templateDraftScope(), autoRun: templateDraftAutoRun() });
    draft.title = templateDraftTitle().trim();
    draft.description = templateDraftDescription().trim();
    draft.prompt = templateDraftPrompt().trim();
    draft.autoRun = templateDraftAutoRun();

    if (!draft.title || !draft.prompt) {
      options.setError(t("app.error.title_prompt_required", currentLocale()));
      return;
    }

    if (draft.scope === "workspace") {
      if (!isTauriRuntime()) {
        options.setError(t("app.error.workspace_templates_desktop", currentLocale()));
        return;
      }
      if (!options.activeWorkspaceRoot().trim()) {
        options.setError(t("app.error.pick_workspace_folder", currentLocale()));
        return;
      }
    }

    options.setBusy(true);
    options.setBusyLabel(draft.scope === "workspace" ? "status.saving_workspace_template" : "status.saving_template");
    options.setBusyStartedAt(Date.now());
    options.setError(null);

    try {
      const template = createTemplateRecord(draft);

      if (draft.scope === "workspace") {
        const workspaceRoot = options.activeWorkspaceRoot().trim();
        await workspaceTemplateWrite({ workspacePath: workspaceRoot, template });
        await loadWorkspaceTemplates({ workspaceRoot, quiet: true });
      } else {
        setTemplates((current) => [template, ...current]);
        setGlobalTemplatesLoaded(true);
      }

      setTemplateModalOpen(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function deleteTemplate(templateId: string) {
    const scope = templates().find((t) => t.id === templateId)?.scope;

    if (scope === "workspace") {
      if (!isTauriRuntime()) return;
      const workspaceRoot = options.activeWorkspaceRoot().trim();
      if (!workspaceRoot) return;

      options.setBusy(true);
      options.setBusyLabel("status.deleting_template");
      options.setBusyStartedAt(Date.now());
      options.setError(null);

      try {
        await workspaceTemplateDelete({ workspacePath: workspaceRoot, templateId });
        await loadWorkspaceTemplates({ workspaceRoot, quiet: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : safeStringify(e);
        options.setError(addOpencodeCacheHint(message));
      } finally {
        options.setBusy(false);
        options.setBusyLabel(null);
        options.setBusyStartedAt(null);
      }

      return;
    }

    setTemplates((current) => current.filter((t) => t.id !== templateId));
    setGlobalTemplatesLoaded(true);
  }

  async function runTemplate(template: WorkspaceTemplate) {
    // DEBUG: Log template data when running
    console.log("[DEBUG runTemplate] Template being run:", {
      id: template.id,
      title: template.title,
      autoRun: template.autoRun,
      autoRunType: typeof template.autoRun,
      autoRunStrictEqualFalse: template.autoRun === false,
      autoRunLooseEqualFalse: template.autoRun == false,
      fullTemplate: template,
    });

    // DEBUG: Store the template being used for debugging
    setLastUsedTemplate(template);

    // Also expose to window for debugging
    if (typeof window !== "undefined") {
      (window as any).__DEBUG_LAST_TEMPLATE__ = template;
    }

    if (options.isDemoMode()) {
      options.setView("session");
      return;
    }

    const c = options.client();
    if (!c) return;

    // Check autoRun setting (default to true for backwards compatibility)
    const shouldAutoRun = template.autoRun !== false;
    console.log("[DEBUG runTemplate] shouldAutoRun calculated as:", shouldAutoRun);

    options.setBusy(true);
    options.setError(null);

    try {
      const session = unwrap(
        await c.session.create({ title: template.title, directory: options.activeWorkspaceRoot().trim() }),
      );
      await options.loadSessions(options.activeWorkspaceRoot().trim());
      await options.selectSession(session.id);
      options.setView("session");

      if (shouldAutoRun) {
        console.log("[DEBUG runTemplate] AUTO-RUNNING template - sending prompt automatically");
        const model = options.defaultModel();

        await c.session.promptAsync({
          sessionID: session.id,
          model,
          variant: options.modelVariant() ?? undefined,
          parts: [{ type: "text", text: template.prompt }],
        });

        options.setSessionModelById((current) => ({
          ...current,
          [session.id]: model,
        }));
      } else {
        // Don't auto-run: populate the prompt input and let user send manually
        console.log("[DEBUG runTemplate] NOT AUTO-RUNNING - just populating prompt input");
        window.dispatchEvent(new CustomEvent("openwork:setPrompt", { detail: template.prompt }));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : t("app.unknown_error", currentLocale());
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function loadWorkspaceTemplates(optionsLoad?: { workspaceRoot?: string; quiet?: boolean }) {
    const c = options.client();
    const root = (optionsLoad?.workspaceRoot ?? options.activeWorkspaceRoot()).trim();
    if (!c || !root) return;

    try {
      const templatesPath = ".openwork/templates";
      const nodes = unwrap(await c.file.list({ directory: root, path: templatesPath }));
      const entries = nodes.filter((n) => !n.ignored);
      const templateFiles = entries.filter((n) => n.type === "file");
      const templateDirs = entries.filter((n) => n.type === "directory");

      const loaded: WorkspaceTemplate[] = [];
      const seenIds = new Set<string>();

      const pushTemplate = (template: WorkspaceTemplate) => {
        if (seenIds.has(template.id)) return;
        seenIds.add(template.id);
        loaded.push(template);
      };

      const parseTemplateContent = (raw: string, fallbackId: string) => {
        const parsedFrontmatter = parseTemplateFrontmatter(raw);
        if (parsedFrontmatter) {
          const meta = parsedFrontmatter.data;

          // DEBUG: Log raw frontmatter data
          console.log("[DEBUG parseTemplateContent] Raw frontmatter meta:", meta);
          console.log("[DEBUG parseTemplateContent] meta.autoRun:", {
            value: meta.autoRun,
            type: typeof meta.autoRun,
            isBoolean: typeof meta.autoRun === "boolean",
            isStringFalse: meta.autoRun === "false",
            isStringTrue: meta.autoRun === "true",
          });

          const title = typeof meta.title === "string" ? meta.title : t("common.untitled", currentLocale());
          const promptText = parsedFrontmatter.body ?? "";
          if (!promptText.trim()) return false;

          const createdAtValue = Number(meta.createdAt);

          // DEBUG: Convert string "true"/"false" to actual booleans
          let autoRunValue: boolean;
          if (typeof meta.autoRun === "boolean") {
            autoRunValue = meta.autoRun;
          } else if (meta.autoRun === "false") {
            autoRunValue = false;
          } else if (meta.autoRun === "true") {
            autoRunValue = true;
          } else {
            autoRunValue = true; // default
          }

          console.log("[DEBUG parseTemplateContent] Final autoRunValue:", autoRunValue);

          pushTemplate({
            id: typeof meta.id === "string" ? meta.id : fallbackId,
            title,
            description: typeof meta.description === "string" ? meta.description : "",
            prompt: promptText,
            createdAt: Number.isFinite(createdAtValue) && createdAtValue > 0 ? createdAtValue : Date.now(),
            scope: "workspace",
            autoRun: autoRunValue,
          });
          return true;
        }

        const parsed = safeParseJson<Partial<WorkspaceTemplate> & Record<string, unknown>>(raw);
        if (!parsed) return false;

        // DEBUG: Log JSON parsed data
        console.log("[DEBUG parseTemplateContent JSON] Parsed JSON:", parsed);
        console.log("[DEBUG parseTemplateContent JSON] parsed.autoRun:", {
          value: parsed.autoRun,
          type: typeof parsed.autoRun,
          isBoolean: typeof parsed.autoRun === "boolean",
        });

        const title = typeof parsed.title === "string" ? parsed.title : t("common.untitled", currentLocale());
        const promptText = typeof parsed.prompt === "string" ? parsed.prompt : "";
        if (!promptText.trim()) return false;

        // For JSON, autoRun should already be a boolean if properly serialized
        let jsonAutoRunValue: boolean;
        if (typeof parsed.autoRun === "boolean") {
          jsonAutoRunValue = parsed.autoRun;
        } else if (parsed.autoRun === "false" || parsed.autoRun === false) {
          jsonAutoRunValue = false;
        } else {
          jsonAutoRunValue = true; // default
        }

        console.log("[DEBUG parseTemplateContent JSON] Final jsonAutoRunValue:", jsonAutoRunValue);

        pushTemplate({
          id: typeof parsed.id === "string" ? parsed.id : fallbackId,
          title,
          description: typeof parsed.description === "string" ? parsed.description : "",
          prompt: promptText,
          createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
          scope: "workspace",
          autoRun: jsonAutoRunValue,
        });

        return true;
      };

      const readTemplatePath = async (path: string, fallbackId: string) => {
        try {
          const content = unwrap(await c.file.read({ directory: root, path }));
          if (content.type !== "text") return false;

          // DEBUG: Log raw file content
          console.log("[DEBUG readTemplatePath] Raw file content for", path, ":");
          console.log(content.content);

          return parseTemplateContent(content.content, fallbackId);
        } catch {
          return false;
        }
      };

      for (const dir of templateDirs) {
        const basePath = `${templatesPath}/${dir.name}`;
        const candidates = [`${basePath}/template.yml`, `${basePath}/template.yaml`, `${basePath}/template.json`];
        for (const candidate of candidates) {
          const loadedTemplate = await readTemplatePath(candidate, dir.name);
          if (loadedTemplate) break;
        }
      }

      const frontmatterFiles = templateFiles.filter((n) => /\.(yml|yaml)$/i.test(n.name));
      const jsonFiles = templateFiles.filter((n) => n.name.toLowerCase().endsWith(".json"));

      for (const node of frontmatterFiles) {
        const fallbackId = node.name.replace(/\.(yml|yaml)$/i, "");
        await readTemplatePath(node.path, fallbackId);
      }

      for (const node of jsonFiles) {
        const fallbackId = node.name.replace(/\.json$/i, "");
        await readTemplatePath(node.path, fallbackId);
      }

      const stable = loaded.slice().sort((a, b) => b.createdAt - a.createdAt);

      setTemplates((current) => {
        const globals = current.filter((t) => t.scope === "global");
        return [...stable, ...globals];
      });
      setWorkspaceTemplatesLoaded(true);
    } catch (e) {
      setWorkspaceTemplatesLoaded(true);
      if (!optionsLoad?.quiet) {
        const message = e instanceof Error ? e.message : safeStringify(e);
        options.setError(addOpencodeCacheHint(message));
      }
    }
  }

  return {
    templates,
    setTemplates,
    workspaceTemplatesLoaded,
    setWorkspaceTemplatesLoaded,
    globalTemplatesLoaded,
    setGlobalTemplatesLoaded,
    templateModalOpen,
    setTemplateModalOpen,
    templateDraftTitle,
    setTemplateDraftTitle,
    templateDraftDescription,
    setTemplateDraftDescription,
    templateDraftPrompt,
    setTemplateDraftPrompt,
    templateDraftScope,
    setTemplateDraftScope,
    templateDraftAutoRun,
    setTemplateDraftAutoRun,
    workspaceTemplates,
    globalTemplates,
    openTemplateModal,
    saveTemplate,
    deleteTemplate,
    runTemplate,
    loadWorkspaceTemplates,
    // DEBUG: Expose last used template for debugging
    lastUsedTemplate,
  };
}
