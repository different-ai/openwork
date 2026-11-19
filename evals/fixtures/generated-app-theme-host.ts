import { AppBridge, PostMessageTransport, type McpUiHostContext } from "../../ee/apps/den-api/node_modules/@modelcontextprotocol/ext-apps/dist/src/app-bridge.js";

const bridges: AppBridge[] = [];
function context(theme: "light" | "dark", tokens = true): McpUiHostContext {
  return {
    theme, displayMode: "inline",
    styles: { variables: tokens ? {
      "--color-text-primary": theme === "dark" ? "rgb(240, 240, 240)" : "rgb(28, 32, 36)",
      "--color-background-primary": theme === "dark" ? "rgb(24, 24, 24)" : "rgb(248, 249, 250)",
      "--font-sans": "monospace",
    } : {} },
  };
}

async function open() {
  for (const name of ["runtime", "starter", "fallback"]) {
    const frame = document.createElement("iframe");
    frame.title = name === "starter" ? "Starter calculator" : "Generated checklist";
    frame.dataset.app = name;
    frame.dataset.mcpAppResource = `ui://proof/${name}`;
    frame.dataset.loads = "0";
    frame.addEventListener("load", () => {
      if (frame.contentDocument?.getElementById("openwork-mcp-app-root")) frame.dataset.loads = String(Number(frame.dataset.loads) + 1);
    });
    document.querySelector("#apps")!.append(frame);
    if (!frame.contentWindow) throw new Error("App frame missing");
    const bridge = new AppBridge(null, { name: "Theme proof host", version: "1" }, {}, { hostContext: context(name === "fallback" ? "dark" : "light", name !== "fallback") });
    if (name !== "fallback") bridges.push(bridge);
    bridge.oninitialized = () => { frame.dataset.ready = "true"; };
    await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
    // srcdoc runs the actual compiler output, including its CSP and SDK client.
    frame.srcdoc = await (await fetch(`/${name}.html`)).text();
  }
}
const themes: Array<"light" | "dark"> = ["light", "dark"];
for (const theme of themes) {
  document.getElementById(theme)!.addEventListener("click", () => {
    for (const bridge of bridges) bridge.setHostContext(context(theme));
    document.documentElement.style.colorScheme = theme;
    document.querySelector("#status")!.textContent = theme;
  });
}
void open();
