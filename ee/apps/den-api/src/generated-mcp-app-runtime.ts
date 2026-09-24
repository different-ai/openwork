export const GENERATED_MCP_APP_ENTRY = `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
  const GeneratedApp = React.lazy(() => import("artifact:view"));
  const mount = document.getElementById("openwork-mcp-app-root");
  const app = new App(
    { name: "OpenWork Generated App", version: "1.0.0" },
    {},
    { autoResize: true, strict: true },
  );
  let root = null;
  let initialized = false;
  let disposed = false;
  let input = {};
  let result;
  const reportRuntimeError = (stage) => {
    if (initialized && !disposed) {
      void app.sendLog({ level: "error", logger: "generated-mcp-app", data: stage }).catch(() => {});
    }
  };
  const renderFailure = () => React.createElement("p", { role: "alert" }, "This App could not render. Reopen it to try again.");
  class GeneratedAppErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { failed: false }; }
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch() { reportRuntimeError("react-render"); }
    render() { return this.state.failed ? renderFailure() : this.props.children; }
  }
  const render = () => {
    if (!initialized || disposed) return;
    try {
      if (!mount) throw new Error("The generated App mount element is missing.");
      root ||= createRoot(mount);
      root.render(React.createElement(GeneratedAppErrorBoundary, null,
        React.createElement(React.Suspense, { fallback: null },
          React.createElement(GeneratedApp, { app, input, result, hostContext: app.getHostContext() }))));
    } catch {
      reportRuntimeError("react-mount");
      if (mount) mount.textContent = "This App could not render. Reopen it to try again.";
    }
  };
  app.addEventListener("toolinput", (params) => {
    input = params.arguments?.input ?? {};
    render();
  });
  app.addEventListener("toolresult", (next) => {
    result = next;
    render();
  });
  app.addEventListener("hostcontextchanged", render);
  app.onteardown = async () => {
    disposed = true;
    initialized = false;
    root?.unmount();
    root = null;
    return {};
  };
  void app.connect(new PostMessageTransport(window.parent, window.parent)).then(() => {
    if (disposed) return;
    initialized = true;
    render();
  }).catch(() => {
    if (!disposed && mount) mount.textContent = "This App could not initialize. Reopen it to try again.";
  });
`
