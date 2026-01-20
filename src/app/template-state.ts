import { createMemo, createSignal, type Accessor } from "solid-js";

import type { Client, ModelRef, WorkspaceTemplate } from "./types";
import { buildTemplateDraft, createTemplateRecord, resetTemplateDraft } from "./utils/templates";
import { addOpencodeCacheHint, isTauriRuntime, parseTemplateFrontmatter, safeParseJson, safeStringify } from "./utils";
import { workspaceTemplateDelete, workspaceTemplateWrite } from "./lib/tauri";
import { unwrap } from "./lib/opencode";

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

  const [templateModalOpen, setTemplateModalOpen] = createSignal(false);
  const [templateDraftTitle, setTemplateDraftTitle] = createSignal("");
  const [templateDraftDescription, setTemplateDraftDescription] = createSignal("");
  const [templateDraftPrompt, setTemplateDraftPrompt] = createSignal("");
  const [templateDraftScope, setTemplateDraftScope] = createSignal<"workspace" | "global">("workspace");

  const workspaceTemplates = createMemo(() => templates().filter((t) => t.scope === "workspace"));
  const globalTemplates = createMemo(() => templates().filter((t) => t.scope === "global"));

  function openTemplateModal() {
    const seedTitle = options.selectedSession()?.title ?? "";
    const seedPrompt = options.lastPromptSent() || options.prompt();
    const nextDraft = buildTemplateDraft({ seedTitle, seedPrompt, scope: "workspace" });

    resetTemplateDraft(
      {
        setTitle: setTemplateDraftTitle,
        setDescription: setTemplateDraftDescription,
        setPrompt: setTemplateDraftPrompt,
        setScope: setTemplateDraftScope,
      },
      nextDraft.scope,
    );

    setTemplateDraftTitle(nextDraft.title);
    setTemplateDraftPrompt(nextDraft.prompt);
    setTemplateModalOpen(true);
  }

  async function saveTemplate() {
    const draft = buildTemplateDraft({ scope: templateDraftScope() });
    draft.title = templateDraftTitle().trim();
    draft.description = templateDraftDescription().trim();
    draft.prompt = templateDraftPrompt().trim();

    if (!draft.title || !draft.prompt) {
      options.setError("Template title and prompt are required.");
      return;
    }

    if (draft.scope === "workspace") {
      if (!isTauriRuntime()) {
        options.setError("Workspace templates require the desktop app.");
        return;
      }
      if (!options.activeWorkspaceRoot().trim()) {
        options.setError("Pick a workspace folder first.");
        return;
      }
    }

    options.setBusy(true);
    options.setBusyLabel(draft.scope === "workspace" ? "Saving workspace template" : "Saving template");
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
      options.setBusyLabel("Deleting template");
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
        await c.session.create({ title: template.title, directory: options.activeWorkspaceRoot().trim() }),
      );
      await options.loadSessions(options.activeWorkspaceRoot().trim());
      await options.selectSession(session.id);
      options.setView("session");

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
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
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
          const title = typeof meta.title === "string" ? meta.title : "Untitled";
          const promptText = parsedFrontmatter.body ?? "";
          if (!promptText.trim()) return false;

          const createdAtValue = Number(meta.createdAt);
          pushTemplate({
            id: typeof meta.id === "string" ? meta.id : fallbackId,
            title,
            description: typeof meta.description === "string" ? meta.description : "",
            prompt: promptText,
            createdAt: Number.isFinite(createdAtValue) && createdAtValue > 0 ? createdAtValue : Date.now(),
            scope: "workspace",
          });
          return true;
        }

        const parsed = safeParseJson<Partial<WorkspaceTemplate> & Record<string, unknown>>(raw);
        if (!parsed) return false;

        const title = typeof parsed.title === "string" ? parsed.title : "Untitled";
        const promptText = typeof parsed.prompt === "string" ? parsed.prompt : "";
        if (!promptText.trim()) return false;

        pushTemplate({
          id: typeof parsed.id === "string" ? parsed.id : fallbackId,
          title,
          description: typeof parsed.description === "string" ? parsed.description : "",
          prompt: promptText,
          createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
          scope: "workspace",
        });

        return true;
      };

      const readTemplatePath = async (path: string, fallbackId: string) => {
        try {
          const content = unwrap(await c.file.read({ directory: root, path }));
          if (content.type !== "text") return false;
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
    workspaceTemplates,
    globalTemplates,
    openTemplateModal,
    saveTemplate,
    deleteTemplate,
    runTemplate,
    loadWorkspaceTemplates,
  };
}
