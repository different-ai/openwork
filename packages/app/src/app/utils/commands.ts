type CommandDraft = {
  name: string;
  description: string;
  template: string;
  scope: "workspace" | "global";
};

type CommandDraftSetters = {
  setName: (value: string) => void;
  setDescription: (value: string) => void;
  setTemplate: (value: string) => void;
  setScope: (value: "workspace" | "global") => void;
};

export function resetCommandDraft(setters: CommandDraftSetters, scope: "workspace" | "global" = "workspace") {
  setters.setName("");
  setters.setDescription("");
  setters.setTemplate("");
  setters.setScope(scope);
}

export function buildCommandDraft(params: {
  seedName?: string;
  seedTemplate?: string;
  scope?: "workspace" | "global";
}): CommandDraft {
  return {
    name: params.seedName ?? "",
    description: "",
    template: params.seedTemplate ?? "",
    scope: params.scope ?? "workspace",
  };
}
