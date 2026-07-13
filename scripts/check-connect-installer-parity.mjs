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
const cloudDocs = await readFile(
  new URL("../packages/docs/cloud/run-in-the-cloud/cloud-mcp.mdx", import.meta.url),
  "utf8",
);
const onboardingScreen = await readFile(
  new URL("../ee/apps/den-web/app/(den)/dashboard/_components/marketplace-onboarding-screen.tsx", import.meta.url),
  "utf8",
);

const serverUrlMatch = landingConfig.match(/export const MCP_SERVER_URL = "([^"]+)";/);
assert.ok(serverUrlMatch, "Landing installer is missing MCP_SERVER_URL");
const serverUrl = serverUrlMatch[1];
assert.equal(serverUrl, "https://api.openworklabs.com/mcp/agent", "OpenWork Connect must use the public /mcp/agent endpoint");
const codexDeepLinkMatch = landingConfig.match(/export const CODEX_CONNECTIONS_DEEPLINK = "([^"]+)";/);
assert.ok(codexDeepLinkMatch, "Landing installer is missing CODEX_CONNECTIONS_DEEPLINK");
const chatGptSettingsMatch = landingConfig.match(/export const CHATGPT_SETTINGS_URL = "([^"]+)";/);
assert.ok(chatGptSettingsMatch, "Landing installer is missing CHATGPT_SETTINGS_URL");

const clientsMatch = landingConfig.match(/export const CONNECT_CLIENTS[^=]*= \[([^\]]+)\];/);
assert.ok(clientsMatch, "Landing installer is missing CONNECT_CLIENTS");
const clients = [...clientsMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const supportMatch = landingConfig.match(/export const CONNECT_CLIENT_SUPPORT[\s\S]*?= \{([\s\S]*?)\};/);
assert.ok(supportMatch, "Landing installer is missing CONNECT_CLIENT_SUPPORT");

const verifiedClients = [];

for (const client of clients) {
  const supportEntry = supportMatch[1].match(new RegExp(`"${client}": \\{\\s*status: "([^"]+)",\\s*explanation: "([^"]+)"`, "m"));
  assert.ok(supportEntry, `Landing installer is missing support evidence for ${client}`);

  const status = supportEntry[1];
  const explanation = supportEntry[2];

  if (status === "Verified") {
    verifiedClients.push(client);
  } else {
    assert.equal(status, "Setup only", `${client} has an unsupported status: ${status}`);
  }

  assert.ok(docsInstaller.includes(`supportStatus: "${status}"`), `Docs installer is missing ${client} support status`);
  assert.ok(docsInstaller.includes(`supportExplanation: "${explanation}"`), `Docs installer is missing ${client} support explanation`);
}

assert.deepEqual(verifiedClients.sort(), ["opencode"], "Only OpenCode should be verified");

for (const client of clients) {
  assert.match(docsInstaller, new RegExp(`id: ["']${client}["']`), `Docs installer is missing ${client}`);
}

const expectedSupportRows = new Map([
  ["OpenCode", "Verified"],
  ["Codex", "Setup only"],
  ["Cursor", "Setup only"],
  ["ChatGPT Desktop", "Setup only"],
  ["Claude Code", "Setup only"],
  ["VS Code", "Setup only"],
  ["Any client", "Setup only"],
]);

for (const [client, status] of expectedSupportRows) {
  assert.ok(cloudDocs.includes(`| ${client} | ${status} |`), `Cloud MCP docs are missing ${client} ${status} support row`);
}

const sharedValueNames = [
  "CURSOR_SNIPPET",
  "CLAUDE_CODE_COMMAND",
  "CODEX_COMMAND",
  "CODEX_LOGIN_COMMAND",
  "CODEX_RECONNECT_COMMAND",
  "OPENCODE_SNIPPET",
  "OPENCODE_AUTH_COMMAND",
  "OPENCODE_RECONNECT_COMMAND",
  "VS_CODE_COMMAND",
  "ANY_CLIENT_COMMAND",
];

assert.ok(docsInstaller.includes(serverUrl), "Docs installer is using a different MCP server URL");
assert.ok(docsInstaller.includes(codexDeepLinkMatch[1]), "Docs installer is using a different Codex connections link");
assert.ok(docsInstaller.includes(chatGptSettingsMatch[1]), "Docs installer is using a different ChatGPT settings link");
assert.ok(!landingConfig.includes("CURSOR_DEEPLINK") && !docsInstaller.includes("CURSOR_DEEPLINK"), "Cursor desktop install deeplinks must not be exposed");
assert.ok(!landingConfig.includes("cursor.com/en/install-mcp") && !docsInstaller.includes("cursor.com/en/install-mcp"), "Cursor add-to-desktop install links must not be exposed");
assert.ok(!landingConfig.includes("~/.cursor/mcp.json") && !docsInstaller.includes("~/.cursor/mcp.json") && !cloudDocs.includes("~/.cursor/mcp.json"), "Cursor desktop mcp.json must not be shown as a working path");
assert.ok(cloudDocs.includes("cursor://anysphere.cursor-mcp/oauth/callback"), "Cloud MCP docs must explain why Cursor Desktop OAuth is not currently supported");
assert.ok(cloudDocs.includes("Settings > MCP servers"), "Cloud MCP docs must use current ChatGPT Settings > MCP servers wording");

for (const name of sharedValueNames) {
  const valueMatch = landingConfig.match(new RegExp("export const " + name + " = `([\\s\\S]*?)`;"));
  assert.ok(valueMatch, `Landing installer is missing ${name}`);

  for (const part of valueMatch[1].split("${MCP_SERVER_URL}")) {
    if (part.trim()) {
      assert.ok(docsInstaller.includes(part), `Docs installer drifted from ${name}: ${part}`);
    }
  }
}

const exactCommands = [
  { docsInstallerNeedle: "opencode mcp auth openwork", cloudDocsNeedle: "opencode mcp auth openwork" },
  { docsInstallerNeedle: "opencode mcp logout openwork\nopencode mcp auth openwork", cloudDocsNeedle: "opencode mcp logout openwork\nopencode mcp auth openwork" },
  { docsInstallerNeedle: "codex mcp add openwork --url ${MCP_SERVER_URL}", cloudDocsNeedle: `codex mcp add openwork --url ${serverUrl}` },
  { docsInstallerNeedle: "codex mcp login openwork", cloudDocsNeedle: "codex mcp login openwork" },
  { docsInstallerNeedle: "codex mcp logout openwork\ncodex mcp login openwork", cloudDocsNeedle: "codex mcp logout openwork\ncodex mcp login openwork" },
];

for (const command of exactCommands) {
  assert.ok(docsInstaller.includes(command.docsInstallerNeedle), `Docs installer is missing exact command: ${command.docsInstallerNeedle}`);
  assert.ok(cloudDocs.includes(command.cloudDocsNeedle), `Cloud MCP docs are missing exact command: ${command.cloudDocsNeedle}`);
}

assert.ok(cloudDocs.includes(serverUrl), "Cloud MCP docs are missing the public endpoint");
assert.ok(
  cloudDocs.includes("`app.openworklabs.com/api/den` is an internal same-origin desktop proxy"),
  "Cloud MCP docs must describe app.openworklabs.com/api/den as an internal same-origin desktop proxy",
);
assert.ok(cloudDocs.includes("https://app.openworklabs.com/api/auth"), "Cloud MCP docs are missing the auth server origin");
assert.ok(cloudDocs.includes("RFC9728"), "Cloud MCP docs are missing RFC9728 discovery guidance");
assert.ok(cloudDocs.includes("PKCE") && cloudDocs.includes("S256"), "Cloud MCP docs are missing PKCE S256 guidance");
assert.ok(cloudDocs.includes("OAuth authorize and token requests must include exactly one"), "Cloud MCP docs are missing exact resource guidance");
assert.ok(cloudDocs.includes("JWTs signed and validated with EdDSA") && cloudDocs.includes("issuer is exactly") && cloudDocs.includes("audience is exactly") && cloudDocs.includes("15 minutes"), "Cloud MCP docs are missing JWT access token contract guidance");
assert.ok(cloudDocs.includes("Refresh tokens are opaque rotating grants") && cloudDocs.includes("30-day inactivity window"), "Cloud MCP docs are missing refresh grant lifetime guidance");
assert.ok(cloudDocs.includes("invalid_grant"), "Cloud MCP docs are missing invalid_grant reconnect guidance");
assert.ok(cloudDocs.includes("Retry-After"), "Cloud MCP docs are missing 429 Retry-After guidance");
assert.ok(cloudDocs.includes("X-Request-Id") && cloudDocs.includes("referenceId") && cloudDocs.includes("reference_id"), "Cloud MCP docs are missing support reference guidance");
assert.ok(cloudDocs.includes("search_capabilities") && cloudDocs.includes("execute_capability"), "Cloud MCP docs are missing /mcp/agent tool guidance");
assert.ok(!cloudDocs.includes("openwork-ui-mcp"), "Cloud MCP docs must not reference the local UI MCP package");
assert.ok(!cloudDocs.includes("opaque bearer tokens") && !cloudDocs.includes("Access tokens are opaque"), "Cloud MCP docs must not claim opaque public access tokens");
assert.ok(!cloudDocs.includes("JWKS"), "Cloud MCP docs must not expose JWKS implementation details");

assert.ok(onboardingScreen.includes(serverUrl), "Cloud onboarding must copy the public /mcp/agent endpoint");
assert.ok(!onboardingScreen.includes("openwork-ui-mcp"), "Cloud onboarding must not copy the local UI MCP package");
assert.ok(
  onboardingScreen.includes("https://openworklabs.com/docs/cloud/run-in-the-cloud/cloud-mcp"),
  "Cloud onboarding must link to the Cloud MCP docs",
);
assert.ok(onboardingScreen.includes("OpenCode is verified"), "Cloud onboarding must state verified clients");
assert.ok(onboardingScreen.includes("setup guides"), "Cloud onboarding must state setup-only client coverage");
assert.ok(onboardingScreen.includes("break-all") && onboardingScreen.includes("whitespace-normal"), "Cloud onboarding endpoint text must wrap on narrow screens");
assert.ok(onboardingScreen.includes("aria-live=\"polite\"") && onboardingScreen.includes("Copy OpenWork MCP endpoint"), "Cloud onboarding must expose accessible copy feedback");

console.log("OpenWork Connect landing and docs installers are in parity.");
