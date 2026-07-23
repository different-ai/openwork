import { StringDecoder } from "node:string_decoder";

import { resolveDesktopObservabilityControl } from "./observability-control.mjs";

export const OBSERVABILITY_CONSOLE_EVENT = "openwork:observability-console";

export function resolveObservabilityConsoleEnabled(options = {}, env = process.env) {
  return resolveDesktopObservabilityControl(options, env).consoleEnabled;
}

/**
 * Gate renderer sends on document readiness. BrowserWindow exists before its
 * preload has installed the IPC listener, so existence alone is not delivery.
 */
export function createObservabilityRendererTarget({ getWindow, eventName = OBSERVABILITY_CONSOLE_EVENT }) {
  let ready = false;
  return {
    markLoading() {
      ready = false;
    },
    markReady() {
      ready = true;
    },
    send(payload) {
      const window = getWindow();
      if (!ready || !window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
      window.webContents.send(eventName, payload);
      return true;
    },
  };
}

function isObservabilityLine(line) {
  return line.startsWith("[openwork][")
    || line.startsWith("[opencode:stdout] [openwork][")
    || line.startsWith("[opencode:stderr] [openwork][");
}

function isSafeInitializationLine(line) {
  return /^(?:\[opencode:(?:stdout|stderr)\] )?\[openwork\]\[agent-prompt\] observer initialized: at=[^,\r\n]{1,64}, level=(?:off|metadata|exact), enabled=(?:true|false), exact=(?:true|false), source=[A-Z0-9_-]{1,64}$/.test(line);
}

/**
 * Forward only opt-in OpenWork/OpenCode diagnostic lines to renderer DevTools.
 * Prompt and MCP history is never retained. One strictly content-free observer
 * initialization record may be held until the first renderer load so an
 * operator can prove that the plugin was instantiated before DevTools existed.
 * Every logical line is character bounded.
 */
export function createObservabilityConsoleBridge({
  send,
  maxLineChars = 2 * 1024 * 1024,
}) {
  let enabled = false;
  let decoder = new StringDecoder("utf8");
  let remainder = "";
  let droppingOversizeLine = false;
  let pendingSafeInitialization = null;

  const reset = () => {
    decoder = new StringDecoder("utf8");
    remainder = "";
    droppingOversizeLine = false;
  };

  const deliver = (record) => {
    try {
      return send(record) !== false;
    } catch {
      return false;
    }
  };

  const emit = (line) => {
    const normalized = line.replace(/\r$/, "");
    if (!isObservabilityLine(normalized)) return;
    const record = { line: normalized, truncated: false };
    if (!deliver(record) && isSafeInitializationLine(normalized)) {
      pendingSafeInitialization = record;
    }
  };

  const omitOversizeLine = (line) => {
    if (!isObservabilityLine(line)) return;
    deliver({
      line: `[openwork][observability-bridge] line omitted: reason=max-line-chars limit=${maxLineChars}`,
      truncated: true,
    });
  };

  const consume = () => {
    while (true) {
      const newline = remainder.indexOf("\n");
      if (newline < 0) {
        if (remainder.length <= maxLineChars) return;
        omitOversizeLine(remainder);
        remainder = "";
        droppingOversizeLine = true;
        return;
      }
      const line = remainder.slice(0, newline);
      remainder = remainder.slice(newline + 1);
      if (droppingOversizeLine) {
        droppingOversizeLine = false;
        continue;
      }
      if (line.length > maxLineChars) omitOversizeLine(line);
      else emit(line);
    }
  };

  return {
    setEnabled(next) {
      const normalized = next === true;
      if (enabled === normalized) return;
      enabled = normalized;
      if (!enabled) pendingSafeInitialization = null;
      reset();
    },
    push(chunk) {
      if (!enabled) return;
      remainder += typeof chunk === "string" ? chunk : decoder.write(chunk);
      consume();
    },
    flush() {
      if (!enabled) return;
      remainder += decoder.end();
      if (!droppingOversizeLine && remainder) {
        if (remainder.length > maxLineChars) omitOversizeLine(remainder);
        else emit(remainder);
      }
      reset();
    },
    replaySafeInitialization() {
      if (!enabled || !pendingSafeInitialization) return false;
      const record = pendingSafeInitialization;
      if (!deliver(record)) return false;
      pendingSafeInitialization = null;
      return true;
    },
  };
}
