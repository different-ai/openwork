type Rule = { whitelist?: string[]; blacklist?: string[] };
type Catalog = {
  provider: { list(): { provider: { id: string }; models: Map<string, unknown> }[] };
  model: { remove(provider: string, model: string): void };
};
type Context = {
  options: { providers?: Record<string, Rule> };
  catalog: { transform(callback: (catalog: Catalog) => void): Promise<{ dispose(): Promise<void> }> };
};

// The pinned v2 config has no v1 whitelist/blacklist equivalent. Filter the
// native catalog itself, including built-in and subsequently discovered models.
export default {
  id: "openwork.provider-filters",
  async setup(context: Context) {
    const registration = await context.catalog.transform(catalog => {
      for (const { provider, models } of catalog.provider.list()) {
        const rule = context.options.providers?.[provider.id];
        if (!rule) continue;
        for (const id of models.keys()) {
          if ((rule.whitelist !== undefined && !rule.whitelist.includes(id)) || rule.blacklist?.includes(id)) {
            catalog.model.remove(provider.id, id);
          }
        }
      }
    });
    return () => registration.dispose();
  },
};
