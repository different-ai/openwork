// One isolated participant process, with three private HTTP listeners. Node builtins only.
import { once } from "node:events";
import { isAbsolute, join } from "node:path";

async function portOf(server) {
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
  return address.port;
}

try {
  process.env.HOST = "127.0.0.1";
  process.env.PORT = "0";
  const directory = process.env.OPEN_WORKPLACE_PARTICIPANT_DATA_DIR;
  if (directory && !isAbsolute(directory)) throw new Error("Invalid participant storage directory");

  // Each service captures its store during import; never let one inherit another's file.
  delete process.env.OPEN_WORKPLACE_STATE_FILE;
  if (directory) process.env.OPEN_WORKPLACE_STATE_FILE = join(directory, "microsoft.sqlite");
  const microsoft = await import("./microsoft365.mjs");
  const microsoftPort = await portOf(microsoft.server);

  delete process.env.OPEN_WORKPLACE_STATE_FILE;
  if (directory) process.env.OPEN_WORKPLACE_STATE_FILE = join(directory, "atlassian.sqlite");
  const atlassian = await import("./atlassian.mjs");
  const atlassianPort = await portOf(atlassian.server);

  delete process.env.OPEN_WORKPLACE_STATE_FILE;
  process.env.ATLASSIAN_BASE_URL = `http://127.0.0.1:${atlassianPort}`;
  const web = await import("./atlassian-web.mjs");
  const webPort = await portOf(web.server);

  process.send?.({ type: "workshop-ready", ports: { microsoft: microsoftPort, atlassian: atlassianPort, web: webPort } });
} catch {
  // Startup exceptions may contain private paths or configuration; do not forward them.
  console.error("Workshop participant failed to start.");
  process.exit(1);
}
