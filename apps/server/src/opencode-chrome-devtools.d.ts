declare module "opencode-chrome-devtools" {
  import type { Plugin } from "@opencode-ai/plugin";

  const plugin: Plugin;
  export default plugin;
  export { plugin as server };
}
