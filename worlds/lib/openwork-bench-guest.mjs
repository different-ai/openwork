// Runs inside an openwork-bench world's sandbox, next to the desktop app.
// It asks the desktop, over its CDP port on loopback, for the embedded
// OpenWork server's address and tokens, and writes them to an env file only
// the sandbox user can read. It prints the address and the file's path,
// never a token, so the values never leave the sandbox.
//
//   node openwork-bench-guest.mjs <cdp-port> <env-file> <tasks-dir>
import { chmod, writeFile } from "node:fs/promises";

/** Names written to the env file, in order. openwork-bench's openwork-desktop harness reads these. */
export const ENV_NAMES = ["OPENWORK_URL", "OPENWORK_TOKEN", "OPENWORK_HOST_TOKEN", "OWB_TASKS_DIR"];

const SERVER_INFO = `(async () => {
  const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
  return info ? { running: info.running === true, baseUrl: info.baseUrl ?? null, clientToken: info.clientToken ?? null, hostToken: info.hostToken ?? null } : null;
})()`;

/** `export NAME='value'` lines a POSIX shell can source; values are single-quoted. */
export function envFileText(values) {
  return ENV_NAMES.map((name) => {
    const value = values[name];
    if (typeof value !== "string" || !value) throw new Error(`Missing ${name}.`);
    return `export ${name}='${value.replaceAll("'", "'\\''")}'\n`;
  }).join("");
}

async function evaluate(webSocketDebuggerUrl, expression) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const timer = setTimeout(() => socket.close(), 10_000);
  try {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error("CDP socket failed"));
    });
    const reply = new Promise((resolve, reject) => {
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id === 1) resolve(message);
      };
      socket.onclose = () => reject(new Error("CDP socket closed"));
    });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    const message = await reply;
    return message.result?.result?.value ?? null;
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}

async function readServerInfo(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) });
  const targets = await response.json();
  for (const target of Array.isArray(targets) ? targets : []) {
    if (target?.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") continue;
    const info = await evaluate(target.webSocketDebuggerUrl, SERVER_INFO).catch(() => null);
    if (info?.running && info.baseUrl && info.clientToken && info.hostToken) return info;
  }
  return null;
}

async function main([port, envFile, tasksDir]) {
  if (!/^\d+$/.test(port ?? "") || !envFile?.startsWith("/") || !tasksDir?.startsWith("/")) {
    throw new Error("Usage: node openwork-bench-guest.mjs <cdp-port> <absolute env file> <absolute tasks dir>");
  }
  const deadline = Date.now() + 180_000;
  let info = null;
  while (!info && Date.now() < deadline) {
    info = await readServerInfo(port).catch(() => null);
    if (!info) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!info) throw new Error("The desktop's OpenWork server did not report ready within 3 minutes.");
  await writeFile(envFile, envFileText({
    OPENWORK_URL: info.baseUrl, OPENWORK_TOKEN: info.clientToken, OPENWORK_HOST_TOKEN: info.hostToken, OWB_TASKS_DIR: tasksDir,
  }), { mode: 0o600 });
  await chmod(envFile, 0o600);
  console.log(JSON.stringify({ openworkUrl: info.baseUrl, envFile, names: ENV_NAMES }));
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
