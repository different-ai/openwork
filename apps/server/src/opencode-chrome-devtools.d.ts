declare module "opencode-chrome-devtools" {
  type ToolDefinition = Record<string, unknown> & {
    execute: (...args: never[]) => unknown;
  };

  type PluginResult = Record<string, unknown> & {
    tool: Record<string, ToolDefinition> & {
      browser_version: ToolDefinition;
    };
  };

  type PluginFactory = () => Promise<PluginResult>;

  const plugin: PluginFactory;
  export const server: PluginFactory;
  export default plugin;
}
