// The engine sees only MCP. Only the main-window IPC handler can send UI actions.
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, chmod, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const engineMethods = new Set(["initialize", "ping", "tools/list", "tools/call", "notifications/initialized", "notifications/cancelled"]);
export async function createComputerUseHost({ profile, executable }) {
  const directory = path.join(os.tmpdir(), `ow-computer-${createHash("sha256").update(profile).digest("hex").slice(0, 16)}`);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Computer Use control directory is not private.");
  const socketPath = path.join(directory, "host.sock");
  // Only this profile's main process owns this endpoint. A stale socket is left
  // after a crash; a live profile is already protected by Electron's instance lock.
  await unlink(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  const connections = new Map();
  const server = createServer((socket) => {
    if (connections.size >= 16) { socket.destroy(); return; }
    const connectionId = randomUUID();
    const child = spawn(executable, ["mcp-hosted"], { stdio: ["pipe", "pipe", "ignore"] });
    const entry = { child, state: null }; connections.set(connectionId, entry);
    let incoming = "", outgoing = "", closed = false;
    const close = () => {
      if (closed) return; closed = true; connections.delete(connectionId);
      socket.destroy(); child.stdin.end(); child.kill("SIGTERM");
      const timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2_000);
      timeout.unref(); child.once("exit", () => clearTimeout(timeout));
    };
    entry.close = close;
    socket.setEncoding("utf8"); child.stdout.setEncoding("utf8");
    socket.on("end", close); socket.on("error", close); socket.on("close", close); child.on("error", close); child.on("exit", close);
    child.stdin.on("error", close);
    socket.on("data", (chunk) => {
      incoming += chunk;
      if (incoming.length > 1_048_576) { close(); return; }
      let end;
      while ((end = incoming.indexOf("\n")) >= 0) {
        const line = incoming.slice(0, end); incoming = incoming.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { close(); return; }
        if (!message || message.jsonrpc !== "2.0" || !engineMethods.has(message.method)) {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32601, message: "Method not available to the agent." } })}\n`);
          continue;
        }
        child.stdin.write(`${line}\n`);
      }
    });
    child.stdout.on("data", (chunk) => {
      outgoing += chunk;
      if (outgoing.length > 16 * 1024 * 1024) { close(); return; }
      let end;
      while ((end = outgoing.indexOf("\n")) >= 0) {
        const line = outgoing.slice(0, end); outgoing = outgoing.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { close(); return; }
        if (message.method === "openwork/ui") {
          if (message.params?.phase === "closed") entry.state = null;
          else if (message.params && typeof message.params.id === "string") entry.state = { ...entry.state, ...message.params, connectionId, helperPid: child.pid };
        } else socket.write(`${line}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    state: () => [...connections.values()].flatMap((entry) => entry.state ? [entry.state] : []),
    action(value) {
      if (!value || typeof value.connectionId !== "string" || typeof value.id !== "string" || !["approve", "deny", "resume", "stop", "hide", "show"].includes(value.action)) throw new Error("Invalid Computer Use control.");
      const entry = connections.get(value.connectionId);
      if (!entry?.state || entry.state.id !== value.id) throw new Error("This Computer Use request has ended.");
      entry.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "openwork/ui", params: { id: value.id, action: value.action, windowId: value.windowId } })}\n`);
    },
    close() { for (const entry of connections.values()) entry.close(); server.close(); },
  };
}
