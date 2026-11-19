type Rule = { whitelist?: string[]; blacklist?: string[] };
type ModelEditor = {
  list(): readonly { providerID: string; id: string }[];
  remove(provider: string, model: string): void;
};
type Context = {
  options: { providers?: Record<string, Rule> };
  model: { transform(callback: (editor: ModelEditor) => void): Promise<{ dispose(): Promise<void> }> };
};

// Filter the active model collection after provider discovery, including built-in
// and subsequently refreshed models. Stable V2 exposes this through model.transform.
export default {
  id: "openwork.provider-filters",
  async setup(context: Context) {
    const registration = await context.model.transform(editor => {
      for (const model of editor.list()) {
        const rule = context.options.providers?.[model.providerID];
        if (!rule) continue;
        if ((rule.whitelist !== undefined && !rule.whitelist.includes(model.id)) || rule.blacklist?.includes(model.id)) {
          editor.remove(model.providerID, model.id);
        }
      }
    });
    return () => registration.dispose();
  },
};
