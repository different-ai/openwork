// Local UI-control HTTP bridge: a loopback server exposing the legacy
// /snapshot, /actions and /execute routes plus the semantic /context, /query
// and /command surface. Dispatched to the renderer's window.__openworkControl.
// Extracted from main.mjs; state and lifecycle live in this factory
// (createRuntimeManager pattern).
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { open, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// One request of texts to check. The engine sends a long conversation in several of about 8 million characters; one
// text longer than that comes alone, and this is the most a single one may be.
const PRIVATE_TEXT_LIMIT = 64_000_000;

export function createUiControlServer({
  app,
  appName,
  appIdentifier,
  getWindow,
  browserTask = undefined,
  computerTask = undefined,
  computerProgram = undefined,
  computerScript = undefined,
  redactPrivate = undefined,
  terminalBlock = undefined,
  privateValueUse = undefined,
  privateValuesOn = undefined,
}) {
  let uiControlServer = null;
  let uiControlDiscoveryPath = null;
  const uiControlToken = randomBytes(32).toString("hex");

  function sendJsonResponse(response, statusCode, payload) {
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(payload));
  }

  function readJsonRequestBody(request, limit = 128_000) {
    return new Promise((resolve, reject) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > limit) {
          reject(new Error("Request body too large"));
          request.destroy();
        }
      });
      request.on("end", () => {
        if (!raw.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("Request body must be JSON"));
        }
      });
      request.on("error", reject);
    });
  }

  function authorizedUiControlRequest(request) {
    const auth = request.headers.authorization ?? "";
    return auth === `Bearer ${uiControlToken}`;
  }

  function jsonForJavaScript(value) {
    return JSON.stringify(JSON.stringify(value ?? {}));
  }

  async function evaluateOpenworkControl(expression) {
    const win = await getWindow();
    // Commands mutate renderer state directly and do not require the desktop
    // window to become active. Foreground activation must be an explicit
    // affordance, never an implicit side effect of remote control.
    return win.webContents.executeJavaScript(expression, true);
  }

  async function runOpenworkControlCommand(command, args = {}) {
    const argsJsonLiteral = jsonForJavaScript(args);
    if (command === "snapshot") {
      return evaluateOpenworkControl(`(async () => {
        const control = window.__openworkControl;
        if (!control) return { ok: false, error: "OpenWork control surface is not available yet." };
        control.setEnabled?.(true);
        return { ok: true, ...control.snapshot() };
      })()`);
    }
    if (command === "actions") {
      return evaluateOpenworkControl(`(async () => {
        const control = window.__openworkControl;
        if (!control) return { ok: false, error: "OpenWork control surface is not available yet." };
        control.setEnabled?.(true);
        return { ok: true, actions: control.listActions() };
      })()`);
    }
    if (command === "context") {
      return evaluateOpenworkControl(`(async () => {
        const control = window.__openworkControl;
        if (!control) return { ok: false, error: "OpenWork control surface is not available yet." };
        return { ok: true, context: control.context() };
      })()`);
    }
    if (command === "query" || command === "command") {
      return evaluateOpenworkControl(`(async () => {
        const control = window.__openworkControl;
        const input = JSON.parse(${argsJsonLiteral});
        if (!control) return { ok: false, error: "OpenWork control surface is not available yet." };
        if (!input || typeof input.id !== "string" || !input.id.trim()) {
          return { ok: false, error: "Missing OpenWork affordance id." };
        }
        return control[${JSON.stringify(command)}](input);
      })()`);
    }
    if (command === "execute") {
      return evaluateOpenworkControl(`(async () => {
        const control = window.__openworkControl;
        const input = JSON.parse(${argsJsonLiteral});
        if (!control) return { ok: false, error: "OpenWork control surface is not available yet." };
        if (!input || typeof input.actionId !== "string" || !input.actionId.trim()) {
          return { ok: false, error: "Missing OpenWork actionId." };
        }
        control.setEnabled?.(true);
        return control.execute(input.actionId, input.args ?? {});
      })()`);
    }
    return { ok: false, error: `Unknown OpenWork control command: ${command}` };
  }

  async function start() {
    if (uiControlServer) return;
    uiControlServer = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/health") {
          sendJsonResponse(response, 200, { ok: true, app: appName, version: 2 });
          return;
        }
        if (!authorizedUiControlRequest(request)) {
          sendJsonResponse(response, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        if (request.method === "GET" && url.pathname === "/snapshot") {
          sendJsonResponse(response, 200, await runOpenworkControlCommand("snapshot"));
          return;
        }
        if (request.method === "GET" && url.pathname === "/actions") {
          sendJsonResponse(response, 200, await runOpenworkControlCommand("actions"));
          return;
        }
        if (request.method === "GET" && url.pathname === "/context") {
          sendJsonResponse(response, 200, await runOpenworkControlCommand("context"));
          return;
        }
        if (request.method === "POST" && url.pathname === "/query") {
          sendJsonResponse(response, 200, await runOpenworkControlCommand("query", await readJsonRequestBody(request)));
          return;
        }
        if (request.method === "POST" && url.pathname === "/command") {
          sendJsonResponse(response, 200, await runOpenworkControlCommand("command", await readJsonRequestBody(request)));
          return;
        }
        if (request.method === "POST" && url.pathname === "/execute") {
          sendJsonResponse(response, 200, await runOpenworkControlCommand("execute", await readJsonRequestBody(request)));
          return;
        }
        if (request.method === "POST" && url.pathname === "/browser/task") {
          if (typeof browserTask !== "function") { sendJsonResponse(response, 503, { ok: false, code: "browser_unavailable" }); return; }
          const controller = new AbortController();
          response.once("close", () => { if (!response.writableEnded) controller.abort(); });
          sendJsonResponse(response, 200, await browserTask(await readJsonRequestBody(request), { signal: controller.signal }));
          return;
        }
        if (request.method === "POST" && url.pathname === "/computer/program") {
          if (typeof computerProgram !== "function") { sendJsonResponse(response, 503, { ok: false, code: "computer_unavailable" }); return; }
          const controller = new AbortController();
          response.once("close", () => { if (!response.writableEnded) controller.abort(); });
          sendJsonResponse(response, 200, await computerProgram(await readJsonRequestBody(request), { signal: controller.signal }));
          return;
        }
        if (request.method === "POST" && url.pathname === "/computer/script") {
          if (typeof computerScript !== "function") { sendJsonResponse(response, 503, { ok: false, code: "computer_unavailable" }); return; }
          const controller = new AbortController();
          response.once("close", () => { if (!response.writableEnded) controller.abort(); });
          sendJsonResponse(response, 200, await computerScript(await readJsonRequestBody(request), { signal: controller.signal }));
          return;
        }
        if (request.method === "POST" && url.pathname === "/computer/task") {
          if (typeof computerTask !== "function") { sendJsonResponse(response, 503, { ok: false, code: "computer_unavailable" }); return; }
          const controller = new AbortController();
          response.once("close", () => { if (!response.writableEnded) controller.abort(); });
          sendJsonResponse(response, 200, await computerTask(await readJsonRequestBody(request), { signal: controller.signal }));
          return;
        }
        // What the engine is about to send to a model or keep in a conversation, with every private value this app
        // holds replaced. The values never leave this process: the text comes here and goes back without them.
        if (request.method === "POST" && url.pathname === "/private/redact") {
          if (typeof redactPrivate !== "function") { sendJsonResponse(response, 200, { ok: true, held: false }); return; }
          const body = await readJsonRequestBody(request, PRIVATE_TEXT_LIMIT);
          const texts = Array.isArray(body?.texts) && body.texts.every((text) => typeof text === "string") ? body.texts : null;
          sendJsonResponse(response, 200, { ok: true, ...await redactPrivate(texts) });
          return;
        }
        // Whether private values are on for this person, so the engine offers the tool only then.
        if (request.method === "POST" && url.pathname === "/private/state") {
          sendJsonResponse(response, 200, { ok: true, enabled: typeof privateValuesOn === "function" && typeof privateValueUse === "function" && await privateValuesOn() === true });
          return;
        }
        // Private values given to one program or one https request. The values are fetched, used and replaced in
        // this process; what goes back holds none of them.
        if (request.method === "POST" && url.pathname === "/private/use") {
          if (typeof privateValueUse !== "function") { sendJsonResponse(response, 503, { ok: false, code: "values_unavailable" }); return; }
          const controller = new AbortController();
          response.once("close", () => { if (!response.writableEnded) controller.abort(); });
          sendJsonResponse(response, 200, await privateValueUse(await readJsonRequestBody(request), { signal: controller.signal }));
          return;
        }
        // Whether the organization keeps password managers out of the agent's own terminal. The engine asks before
        // it runs a command that names one.
        if (request.method === "POST" && url.pathname === "/private/terminal") {
          if (typeof terminalBlock !== "function") { sendJsonResponse(response, 200, { ok: true, blocked: false }); return; }
          sendJsonResponse(response, 200, { ok: true, ...await terminalBlock() });
          return;
        }
        sendJsonResponse(response, 404, { ok: false, error: "Not found" });
      } catch (error) {
        if (/^\/(?:browser|private)(?:\/|$)/.test(request.url ?? "")) console.error("[ui-control] request failed");
        else console.error("[ui-control] request failed", error);
        sendJsonResponse(response, 500, { ok: false, error: "OpenWork UI control request failed." });
      }
    });
    await new Promise((resolve, reject) => {
      uiControlServer.once("error", reject);
      uiControlServer.listen(0, "127.0.0.1", () => resolve(undefined));
    });
    const address = uiControlServer.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!port) throw new Error("Could not start OpenWork UI control bridge.");
    uiControlDiscoveryPath = path.join(app.getPath("userData"), "openwork-ui-control.json");
    const discovery = `${JSON.stringify({ version: 2, app: appName, identifier: appIdentifier, platform: process.platform, baseUrl: `http://127.0.0.1:${port}`, token: uiControlToken }, null, 2)}\n`;
    if (process.platform === "win32") {
      await writeFile(uiControlDiscoveryPath, discovery, "utf8");
    } else {
      const file = await open(uiControlDiscoveryPath, "w", 0o600);
      try {
        // open's mode applies only to new files. Tighten an existing discovery
        // file before writing the new bearer, not after exposing it briefly.
        await file.chmod(0o600);
        await file.writeFile(discovery, "utf8");
      } finally {
        await file.close();
      }
    }
    // Make the discovery path available to child processes (server → managed OpenCode → plugin).
    process.env.OPENWORK_UI_CONTROL_DISCOVERY = uiControlDiscoveryPath;
  }

  async function stop() {
    if (uiControlDiscoveryPath) {
      await rm(uiControlDiscoveryPath, { force: true }).catch(() => undefined);
      uiControlDiscoveryPath = null;
    }
    if (!uiControlServer) return;
    await new Promise((resolve) => uiControlServer.close(() => resolve(undefined)));
    uiControlServer = null;
  }

  return { start, stop };
}
