import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const landingConfig = await readFile(
  new URL("../ee/apps/landing/components/openwork-connect-installer-config.ts", import.meta.url),
  "utf8",
);
const docsInstaller = await readFile(
  new URL("../packages/docs/snippets/openwork-connect-installer.jsx", import.meta.url),
  "utf8",
);

const serverUrlMatch = landingConfig.match(/export const MCP_SERVER_URL = "([^"]+)";/);
assert.ok(serverUrlMatch, "Landing installer is missing MCP_SERVER_URL");
const serverUrl = serverUrlMatch[1];
const cursorDeepLinkMatch = landingConfig.match(/export const CURSOR_DEEPLINK = "([^"]+)";/);
assert.ok(cursorDeepLinkMatch, "Landing installer is missing CURSOR_DEEPLINK");
const codexDeepLinkMatch = landingConfig.match(/export const CODEX_CONNECTIONS_DEEPLINK = "([^"]+)";/);
assert.ok(codexDeepLinkMatch, "Landing installer is missing CODEX_CONNECTIONS_DEEPLINK");

const clientsMatch = landingConfig.match(/export const CONNECT_CLIENTS[^=]*= \[([^\]]+)\];/);
assert.ok(clientsMatch, "Landing installer is missing CONNECT_CLIENTS");
const clients = [...clientsMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);

for (const client of clients) {
  assert.match(docsInstaller, new RegExp(`id: ["']${client}["']`), `Docs installer is missing ${client}`);
}

const sharedValueNames = [
  "CURSOR_SNIPPET",
  "CLAUDE_CODE_COMMAND",
  "CODEX_COMMAND",
  "OPENCODE_SNIPPET",
  "VS_CODE_COMMAND",
  "ANY_CLIENT_COMMAND",
];

assert.ok(docsInstaller.includes(serverUrl), "Docs installer is using a different MCP server URL");
assert.ok(docsInstaller.includes(cursorDeepLinkMatch[1]), "Docs installer is using a different Cursor install link");
assert.ok(docsInstaller.includes(codexDeepLinkMatch[1]), "Docs installer is using a different Codex connections link");

for (const name of sharedValueNames) {
  const valueMatch = landingConfig.match(new RegExp("export const " + name + " = `([\\s\\S]*?)`;"));
  assert.ok(valueMatch, `Landing installer is missing ${name}`);

  for (const part of valueMatch[1].split("${MCP_SERVER_URL}")) {
    if (part.trim()) {
      assert.ok(docsInstaller.includes(part), `Docs installer drifted from ${name}: ${part}`);
    }
  }
}

console.log("OpenWork Connect landing and docs installers are in parity.");
