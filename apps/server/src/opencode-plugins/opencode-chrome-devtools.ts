import chromeDevtools from "opencode-chrome-devtools";

const PACKAGE_NAME = "opencode-chrome-devtools";
const PACKAGE_VERSION = "1.0.4";

const plugin = async () => {
  const result = await chromeDevtools();
  return {
    ...result,
    tool: {
      ...result.tool,
      browser_version: {
        ...result.tool.browser_version,
        async execute() {
          return `${PACKAGE_NAME}@${PACKAGE_VERSION}`;
        },
      },
    },
  };
};

export { plugin as server };
export default plugin;
