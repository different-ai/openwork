import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { OperationalDiagnostics } from "../src/react-app/shell/operational-diagnostics";
import { initializeDenBootstrapConfig, readDenBootstrapConfig, setDenBootstrapConfig } from "../src/app/lib/den";

afterEach(async () => {
  delete window.__OPENWORK_ELECTRON__;
  await GlobalRegistrator.unregister();
});

test("absent or disabled operator block mounts no feature reader or provider-dependent hooks", () => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
  expect(renderToStaticMarkup(createElement(OperationalDiagnostics))).toBe("");
  window.__OPENWORK_ELECTRON__ = { meta: { desktopBootstrap: { diagnostics: { enabled: false } } } };
  expect(renderToStaticMarkup(createElement(OperationalDiagnostics))).toBe("");
});

test("desktop diagnostics survive bootstrap normalization and branding-only persistence", async () => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
  const diagnostics = { enabled: true, output: "file", intervalMinutes: 60 };
  let persisted;
  const initial = { baseUrl: "https://example.invalid", apiBaseUrl: "https://example.invalid", requireSignin: false, diagnostics };
  window.__OPENWORK_ELECTRON__ = {
    meta: { desktopBootstrap: initial },
    invokeDesktop: async (command, config) => {
      if (command === "setDesktopBootstrapConfig") { persisted = config; return config; }
      if (command === "getDesktopBootstrapConfig") return initial;
      throw new Error("Unexpected IPC command");
    },
  };
  await initializeDenBootstrapConfig();
  expect(readDenBootstrapConfig().diagnostics).toEqual(diagnostics);
  await setDenBootstrapConfig({ baseUrl: initial.baseUrl, apiBaseUrl: initial.apiBaseUrl, requireSignin: false, brandAppName: "OpenWork" });
  expect(persisted.diagnostics).toEqual(diagnostics);
  expect(readDenBootstrapConfig().diagnostics).toEqual(diagnostics);
});
