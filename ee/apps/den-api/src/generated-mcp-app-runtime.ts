/** The host-context flag a host sets to receive snapshots, and the notification that carries one. */
export const MCP_APP_SNAPSHOT_METHOD = "openwork/snapshot"
export const MCP_APP_SNAPSHOT_MAX_BYTES = 200_000

/**
 * A static picture of what the App shows, sent to a host that advertises
 * `experimental["openwork/snapshot"]` so it can paint it on the next open
 * while the live App starts. It is the rendered root markup and the
 * document's inline style text, never scripts, event handlers or URLs other
 * than in-document fragments and raster data images. Sent two animation
 * frames after the App last changed, and only after it has its launch result.
 */
export const GENERATED_MCP_APP_SNAPSHOT_RUNTIME = String.raw`
  function createOpenworkAppSnapshots({ app, mount, document, requestFrame, observe }) {
    const droppedElements = new Set(["script", "noscript", "template", "iframe", "frame", "frameset", "object", "embed",
      "applet", "portal", "link", "meta", "base", "xmp", "noembed", "noframes", "plaintext",
      "animate", "animatemotion", "animatetransform", "set", "discard"]);
    const urlAttributes = new Set(["href", "xlink:href", "src", "srcset", "srcdoc", "action", "formaction", "poster",
      "ping", "cite", "data", "background", "lowsrc", "longdesc", "codebase", "manifest", "usemap"]);
    const encoder = new TextEncoder();
    let started = false;
    let disposed = false;
    let pending = false;
    let changes = 0;
    let last = "";
    let stopObserving = null;
    const wanted = () => app.getHostContext()?.experimental?.["${MCP_APP_SNAPSHOT_METHOD}"] === true;
    const keepsAttribute = (name, value) => {
      if (name.startsWith("on")) return false;
      const plain = String(value).replace(/[\u0000- \u007f-\u009f]/gu, "").toLowerCase();
      if (plain.includes("javascript:") || plain.includes("vbscript:")) return false;
      if (!urlAttributes.has(name)) return true;
      return plain.startsWith("#")
        || (["src", "href", "xlink:href"].includes(name) && /^data:image\/(?:png|gif|jpe?g|webp|avif);/u.test(plain));
    };
    const cleanAttributes = (element) => {
      for (const attribute of Array.from(element.attributes)) {
        if (!keepsAttribute(attribute.name.toLowerCase(), attribute.value)) element.removeAttributeNode(attribute);
      }
    };
    // Style text can never close its element in the painted copy.
    const cssText = (text) => String(text).replace(/</gu, "\\3c ");
    const clean = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType !== 1) {
          if (child.nodeType !== 3) child.remove();
          continue;
        }
        const name = String(child.localName).toLowerCase();
        if (droppedElements.has(name)) {
          child.remove();
          continue;
        }
        cleanAttributes(child);
        if (name === "style") child.textContent = cssText(child.textContent || "");
        else clean(child);
      }
    };
    const capture = () => {
      const copy = mount.cloneNode(true);
      cleanAttributes(copy);
      clean(copy);
      const styles = Array.from(document.querySelectorAll("style"))
        .filter((element) => !mount.contains(element))
        .map((element) => cssText(element.textContent || ""))
        .join("\n");
      const html = (styles ? "<style>" + styles + "</style>" : "") + copy.outerHTML;
      return encoder.encode(html).byteLength <= ${MCP_APP_SNAPSHOT_MAX_BYTES} ? html : null;
    };
    const send = () => {
      if (disposed || !wanted()) return;
      const html = capture();
      if (!html || html === last) return;
      last = html;
      void app.notification({ method: "${MCP_APP_SNAPSHOT_METHOD}", params: { html } }).catch(() => {});
    };
    const schedule = () => {
      changes += 1;
      if (!started || pending || disposed) return;
      pending = true;
      const settle = (seen) => requestFrame(() => requestFrame(() => {
        if (disposed) return;
        if (seen !== changes) return settle(changes);
        pending = false;
        send();
      }));
      settle(changes);
    };
    return {
      // Called once the App has its launch result and after each render.
      start() {
        if (disposed || !wanted()) return;
        started = true;
        stopObserving ||= observe(schedule);
        schedule();
      },
      dispose() {
        disposed = true;
        stopObserving?.();
        stopObserving = null;
      },
    };
  }
`

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
  ${GENERATED_MCP_APP_SNAPSHOT_RUNTIME}
  const snapshots = mount ? createOpenworkAppSnapshots({
    app,
    mount,
    document,
    requestFrame: (callback) => requestAnimationFrame(callback),
    observe: (callback) => {
      const observer = new MutationObserver(callback);
      observer.observe(mount, { subtree: true, childList: true, attributes: true, characterData: true });
      return () => observer.disconnect();
    },
  }) : null;
  let root = null;
  let initialized = false;
  let disposed = false;
  let input = {};
  let result;
  // The document owns the canvas and inherited styles. Applying the theme only
  // inside GeneratedApp can leave dark text tokens over a light iframe canvas.
  const applyTheme = (context) => {
    const documentRoot = document.documentElement;
    const variables = context?.styles?.variables ?? {};
    for (const [name, value] of Object.entries(variables)) {
      if (name.startsWith("--") && typeof value === "string") {
        documentRoot.style.setProperty(name, value);
      }
    }
    if (context?.theme === "light" || context?.theme === "dark") {
      documentRoot.dataset.theme = context.theme;
      documentRoot.style.colorScheme = context.theme;
    } else {
      delete documentRoot.dataset.theme;
      documentRoot.style.colorScheme = "light dark";
    }
    documentRoot.style.color = "var(--color-text-primary, CanvasText)";
    documentRoot.style.backgroundColor = "var(--color-background-primary, Canvas)";
    documentRoot.style.fontFamily = "var(--font-sans, system-ui, sans-serif)";
  };
  // A render that failed before launch data arrived recovers once toolinput or
  // toolresult is delivered; healthy trees keep their state across updates.
  let renderRevision = 0;
  const reportRuntimeError = (stage) => {
    // A document that failed stops taking pictures of itself.
    snapshots?.dispose();
    if (initialized && !disposed) {
      void app.sendLog({ level: "error", logger: "generated-mcp-app", data: stage }).catch(() => {});
    }
  };
  const renderFailure = () => React.createElement("p", { role: "alert" }, "This App could not render. Reopen it to try again.");
  class GeneratedAppErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { failed: false, revision: props.revision }; }
    static getDerivedStateFromError() { return { failed: true }; }
    static getDerivedStateFromProps(props, state) {
      return state.failed && props.revision !== state.revision
        ? { failed: false, revision: props.revision }
        : state.revision === props.revision ? null : { revision: props.revision };
    }
    componentDidCatch() { reportRuntimeError("react-render"); }
    render() { return this.state.failed ? renderFailure() : this.props.children; }
  }
  const render = () => {
    if (!initialized || disposed) return;
    try {
      const hostContext = app.getHostContext();
      applyTheme(hostContext);
      if (!mount) throw new Error("The generated App mount element is missing.");
      root ||= createRoot(mount);
      root.render(React.createElement(GeneratedAppErrorBoundary, { revision: renderRevision },
        React.createElement(React.Suspense, { fallback: null },
          React.createElement(GeneratedApp, { app, input, result, hostContext }))));
      if (result !== undefined) snapshots?.start();
    } catch {
      reportRuntimeError("react-mount");
      if (mount) mount.textContent = "This App could not render. Reopen it to try again.";
    }
  };
  app.addEventListener("toolinput", (params) => {
    input = params.arguments?.input ?? {};
    renderRevision += 1;
    render();
  });
  app.addEventListener("toolresult", (next) => {
    result = next;
    renderRevision += 1;
    render();
  });
  app.addEventListener("hostcontextchanged", render);
  app.onteardown = async () => {
    disposed = true;
    initialized = false;
    snapshots?.dispose();
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
