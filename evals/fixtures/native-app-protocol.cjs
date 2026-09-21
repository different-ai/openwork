// Test-only main-process registry. It replaces OS protocol lookup and external
// launch so evals never inspect or open applications installed on the host.
if (process.versions.electron && process.type === "browser") {
  const Module = require("node:module");
  const originalFetch = globalThis.fetch.bind(globalThis);
  const controlUrl = "http://127.0.0.1/__openwork_native_app_test_control";
  const allowedSchemes = new Set(["notion:", "linear:", "slack:"]);
  const handlers = new Map();
  const lookups = [];
  const launches = [];
  let lookupError = false;

  const snapshot = () => ({
    witness: "native-app-protocol-v1",
    handlers: Object.fromEntries(handlers),
    lookups: [...lookups],
    launches: [...launches],
    lookupError,
  });

  let electronPatched = false;
  const originalModuleLoad = Module._load;
  Module._load = function nativeAppProtocolLoad(request, parent, isMain) {
    const loaded = originalModuleLoad.call(this, request, parent, isMain);
    if (request === "electron" && !electronPatched && loaded?.app && loaded?.shell) {
      electronPatched = true;
      loaded.app.getApplicationNameForProtocol = (rawUrl) => {
        const url = new URL(rawUrl);
        lookups.push(url.href);
        if (lookupError) throw new Error("Injected protocol lookup failure");
        return handlers.get(url.protocol) ?? "";
      };
      loaded.shell.openExternal = async (rawUrl) => {
        launches.push(new URL(rawUrl).href);
      };
    }
    return loaded;
  };

  globalThis.fetch = async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl !== controlUrl) return originalFetch(input, init);
    const request = new Request(input, init);
    if (request.method !== "POST") throw new Error("Native app witness control requires POST");
    const command = await request.json();
    if (command.action === "configure") {
      if (!command.handlers || typeof command.handlers !== "object" || Array.isArray(command.handlers)) {
        throw new Error("Native app witness handlers must be an object");
      }
      handlers.clear();
      for (const [scheme, name] of Object.entries(command.handlers)) {
        if (!allowedSchemes.has(scheme) || typeof name !== "string" || !name.trim()) {
          throw new Error("Native app witness received an invalid handler");
        }
        handlers.set(scheme, name);
      }
      lookupError = command.lookupError === true;
    } else if (command.action === "clear-launches") {
      launches.length = 0;
    } else if (command.action !== "state") {
      throw new Error("Unknown native app witness command");
    }
    return Response.json(snapshot());
  };
}
