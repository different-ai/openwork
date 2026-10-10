import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { BridgeError, record } from "../contract/index.js";
export async function discoverDesktopAt(root: string) {
  const read = async (name: string) => {
    const file = join(root, name),
      s = await lstat(file);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.uid !== process.getuid?.() ||
      s.size > 65536
    )
      throw new BridgeError("UNTRUSTED_INSTALLATION");
    const result: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!record(result)) throw new BridgeError("UPSTREAM_UNAVAILABLE");
    return result;
  };
  const state = await read("openwork-server-state.json");
  const portValid = (v: unknown): v is number =>
    Number.isInteger(v) && Number(v) > 0 && Number(v) <= 65535;
  const ports = [
    ...new Set(
      record(state.workspacePorts)
        ? Object.values(state.workspacePorts).filter(portValid)
        : [],
    ),
  ];
  const port = portValid(state.preferredPort)
    ? state.preferredPort
    : ports.length === 1
      ? ports[0]
      : undefined;
  if (!port) throw new BridgeError("UPSTREAM_UNAVAILABLE");
  const tokens = await read("openwork-server-tokens.json");
  const credentials = record(tokens.credentials) ? tokens.credentials : null;
  if (typeof credentials?.clientToken !== "string" || !credentials.clientToken)
    throw new BridgeError("UPSTREAM_UNAVAILABLE");
  return { origin: `http://127.0.0.1:${port}`, token: credentials.clientToken };
}
