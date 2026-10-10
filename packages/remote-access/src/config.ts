import { BridgeError } from "./contract/index.js";
export function readConfig(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--origin")
    throw new BridgeError("CONFIG_REQUIRED");
  const url = new URL(args[1]!);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname.endsWith(".ts.net")
  )
    throw new BridgeError("INVALID_ORIGIN", 400);
  return { origin: url.origin, remotePort: 9288, adminPort: 9289 };
}
