import type { WorkspaceTemplate } from "../types";

type TemplateDraft = {
  title: string;
  description: string;
  prompt: string;
  scope: "workspace" | "global";
};

type TemplateDraftSetters = {
  setTitle: (value: string) => void;
  setDescription: (value: string) => void;
  setPrompt: (value: string) => void;
  setScope: (value: "workspace" | "global") => void;
};

export function resetTemplateDraft(setters: TemplateDraftSetters, scope: "workspace" | "global" = "workspace") {
  setters.setTitle("");
  setters.setDescription("");
  setters.setPrompt("");
  setters.setScope(scope);
}

export function buildTemplateDraft(params: {
  seedTitle?: string;
  seedPrompt?: string;
  scope?: "workspace" | "global";
}): TemplateDraft {
  return {
    title: params.seedTitle ?? "",
    description: "",
    prompt: params.seedPrompt ?? "",
    scope: params.scope ?? "workspace",
  };
}

export function createTemplateRecord(draft: TemplateDraft): WorkspaceTemplate {
  return {
    id: `tmpl_${Date.now()}`,
    title: draft.title,
    description: draft.description,
    prompt: draft.prompt,
    createdAt: Date.now(),
    scope: draft.scope,
  };
}
