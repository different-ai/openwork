#!/usr/bin/env node
import { readFile, writeFile, mkdir, realpath, lstat } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const gatewayUrl = "https://api.openworklabs.com/mcp/agent";
const apiOrigin = "https://api.openworklabs.com";
const authOrigin = "https://app.openworklabs.com";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureUrl = new URL("../../integrations/marketplace-submissions/fixtures/reviewer-weekly-brief/SKILL.md", import.meta.url);

class PreflightError extends Error {}

export function skillBody(markdown) {
  requireCondition(typeof markdown === "string", "Skill content missing");
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}

export function parseRpcResponse(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  // Streamable HTTP may return SSE; ignore comments and unrelated notifications.
  for (const event of text.replaceAll("\r\n", "\n").split("\n\n")) {
    const data = event.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    const message = JSON.parse(data);
    if (Object.hasOwn(message, "id")) return message;
  }
  throw new PreflightError("No JSON-RPC response received");
}

export function toolData(result) {
  if (result?.isError) throw new PreflightError("Tool returned an error");
  if (result?.structuredContent) return result.structuredContent;
  for (const content of result?.content ?? []) {
    if (content.type !== "text") continue;
    try { return JSON.parse(content.text); } catch { /* Text need not be JSON. */ }
  }
  throw new PreflightError("Tool did not return structured data");
}

export function annotationSummary(tools) {
  const keys = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  return tools.map((tool) => ({
    name: tool.name,
    complete: keys.every((key) => typeof tool.annotations?.[key] === "boolean"),
    // Do not echo arbitrary server metadata or non-boolean reflected credentials.
    annotations: tool.annotations ? Object.fromEntries(keys.map((key) => [
      key, typeof tool.annotations[key] === "boolean" ? tool.annotations[key] : null,
    ])) : null,
  }));
}

async function request(url, options = {}) {
  try {
    return await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(30000) });
  } catch {
    throw new PreflightError(`Request failed at ${new URL(url).pathname}`);
  }
}

async function jsonRequest(url, options = {}) {
  const response = await request(url, options);
  if (!response.ok) throw new PreflightError(`HTTP ${response.status} at ${new URL(url).pathname}`);
  try { return await response.json(); } catch { throw new PreflightError("Invalid JSON response"); }
}

function requireCondition(condition, message) {
  if (!condition) throw new PreflightError(message);
}

async function privateDirectory(path) {
  const directory = resolve(path);
  const root = await realpath(repoRoot);
  // Resolve an existing parent before creating anything, including through symlinks.
  let ancestor = directory;
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      requireCondition(parent !== ancestor, "Private directory has no existing parent");
      ancestor = parent;
    }
  }
  for (const candidate of [directory, ancestor]) {
    const rel = relative(root, candidate);
    requireCondition(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel), "QA credentials must be outside the checkout");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  requireCondition(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && (typeof process.getuid !== "function" || stat.uid === process.getuid()),
    "Private directory must be a real directory with owner-only permissions");
  return directory;
}

async function readPrivateState(directory) {
  const path = join(directory, "bootstrap.json");
  const stat = await lstat(path);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && (typeof process.getuid !== "function" || stat.uid === process.getuid()),
    "QA state must be a regular owner-only file");
  const state = JSON.parse(await readFile(path, "utf8"));
  requireCondition(state.identity?.tokenEndpoint === `${authOrigin}/api/auth/oauth2/token`, "Unexpected QA token endpoint");
  requireCondition(typeof state.setup?.expiresAt === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(state.setup.expiresAt)
    && Date.parse(state.setup.expiresAt) > Date.now(), "QA workspace expired or invalid; explicitly prepare a new one");
  return state;
}

async function checkAuthenticated(state, report, redactions) {
  const token = await jsonRequest(state.identity.tokenEndpoint, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: state.identity.assertionType, assertion: state.identity.assertion }),
  });
  requireCondition(typeof token.access_token === "string" && token.access_token.length > 0, "Missing QA access token");
  redactions.push(token.access_token);
  let id = 0;
  let sessionId;
  async function rpc(method, params) {
    const headers = {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token.access_token}`,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (method !== "initialize") headers["MCP-Protocol-Version"] = report.protocolVersion;
    const requestId = ++id;
    const response = await request(gatewayUrl, {
      method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
    });
    requireCondition(response.ok, `MCP HTTP ${response.status} for ${method}`);
    sessionId ??= response.headers.get("Mcp-Session-Id");
    const message = parseRpcResponse(await response.text());
    requireCondition(message.jsonrpc === "2.0" && message.id === requestId, `MCP response mismatch for ${method}`);
    requireCondition(!message.error, `MCP request failed for ${method}`);
    return message.result;
  }
  const init = await rpc("initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "openwork-listing-qa", version: "1.0.0" },
  });
  requireCondition(["2025-11-25", "2026-07-28"].includes(init?.protocolVersion), "Unexpected MCP protocol version");
  report.protocolVersion = init.protocolVersion;
  const notificationHeaders = {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token.access_token}`, "MCP-Protocol-Version": report.protocolVersion,
  };
  if (sessionId) notificationHeaders["Mcp-Session-Id"] = sessionId;
  const initialized = await request(gatewayUrl, {
    method: "POST", headers: notificationHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  requireCondition(initialized.ok, "MCP initialization notification failed");
  const catalog = await rpc("tools/list", {});
  report.tools = annotationSummary(catalog.tools);
  requireCondition(report.tools.every((tool) => tool.complete), "Some tools lack explicit annotations");
  for (const name of ["search_capabilities", "execute_capability", "list_skills", "get_skill", "create_skill"]) {
    requireCondition(catalog.tools.some((tool) => tool.name === name), `Required gateway tool missing: ${name}`);
  }
  const call = async (name, args) => toolData(await rpc("tools/call", { name, arguments: args }));
  let list = await call("list_skills", { query: "reviewer-weekly-brief" });
  let skill = list.skills?.find((item) => item.title === "reviewer-weekly-brief");
  if (!skill) {
    await call("create_skill", {
      pluginName: "Marketplace Review Fixture", skillMarkdown: await readFile(fixtureUrl, "utf8"),
    });
    list = await call("list_skills", { query: "reviewer-weekly-brief" });
    skill = list.skills?.find((item) => item.title === "reviewer-weekly-brief");
  }
  requireCondition(skill?.capability, "Review fixture not discoverable");
  const read = await call("get_skill", { name: skill.capability });
  // OpenWork canonicalizes the skill name/frontmatter; its instructions must not change.
  requireCondition(skillBody(read.content) === skillBody(await readFile(fixtureUrl, "utf8")), "Review fixture content differs");
  const search = await call("search_capabilities", { query: "reviewer weekly brief", type: "skills", limit: 20 });
  const match = search.matches?.find((item) => item.name === skill.capability);
  requireCondition(match, "Review fixture not found through capability search");
  const execution = await rpc("tools/call", { name: "execute_capability", arguments: { name: match.name } });
  requireCondition(!execution.isError, "Review fixture capability failed");
  requireCondition(JSON.stringify(execution).includes("Documentation refresh"), "Review fixture content not returned");
  report.qa = { status: "passed", expiresAt: state.setup.expiresAt, fixture: "reviewer-weekly-brief", humanOAuthTested: false };
}

export async function main(args) {
  const mode = args[0] ?? "--public";
  requireCondition(["--public", "--prepare-qa", "--check-qa"].includes(mode), "Use --public, --prepare-qa <private-dir>, or --check-qa <private-dir>");
  requireCondition(args.length <= (mode === "--public" ? 1 : 2) && (mode === "--public" || args[1]), "Invalid preflight arguments");
  const report = { checkedAt: new Date().toISOString(), gatewayUrl, checks: [] };
  const redactions = [];
  const check = async (name, fn) => {
    try { await fn(); report.checks.push({ name, status: "passed" }); }
    catch (error) {
      report.checks.push({ name, status: "failed", reason: error instanceof PreflightError
        ? error.message : "Response or local-state validation failed; credentials were not printed" });
    }
  };
  let authorization;
  await check("OAuth discovery and challenge", async () => {
    const response = await request(gatewayUrl, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const metadataUrl = `${apiOrigin}/.well-known/oauth-protected-resource/mcp/agent`;
    requireCondition(response.status === 401 && response.headers.get("www-authenticate")?.includes(metadataUrl), "Missing OAuth discovery challenge");
    const resource = await jsonRequest(metadataUrl);
    requireCondition(resource.resource === gatewayUrl && resource.authorization_servers?.includes(`${authOrigin}/api/auth`), "Protected resource metadata mismatch");
    const candidate = await jsonRequest(`${authOrigin}/.well-known/oauth-authorization-server/api/auth`);
    requireCondition(candidate.issuer === `${authOrigin}/api/auth` && candidate.code_challenge_methods_supported?.includes("S256"), "Issuer or PKCE metadata mismatch");
    requireCondition(candidate.registration_endpoint === `${authOrigin}/api/auth/oauth2/register` && candidate.grant_types_supported?.includes("refresh_token"), "Registration or refresh metadata missing");
    authorization = candidate;
  });
  await check("Official MCP Registry entry", async () => {
    const catalog = await jsonRequest("https://registry.modelcontextprotocol.io/v0.1/servers?search=com.openworklabs%2Fopenwork&limit=100");
    const entry = catalog.servers?.find((item) => item.server.name === "com.openworklabs/openwork" && item._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest);
    requireCondition(entry?._meta?.["io.modelcontextprotocol.registry/official"]?.status === "active" && entry.server.remotes?.some((remote) => remote.url === gatewayUrl), "No active matching Registry entry");
  });
  for (const path of ["privacy", "terms", "docs/start-here/connect-openwork-mcp"]) {
    await check(`Public page: ${path}`, async () => {
      requireCondition((await request(`https://openworklabs.com/${path}`)).ok, "Public page unavailable");
    });
  }
  if (mode !== "--public") {
    await check("Isolated synthetic QA workspace", async () => {
      requireCondition(authorization?.token_endpoint === `${authOrigin}/api/auth/oauth2/token`, "QA requires trusted OAuth metadata");
      const directory = await privateDirectory(args[1]);
      if (mode === "--prepare-qa") {
        // Reserve state before provisioning so a rerun never creates duplicate workspaces.
        const path = join(directory, "bootstrap.json");
        await writeFile(path, "{}\n", { mode: 0o600, flag: "wx" });
        const state = await jsonRequest(`${apiOrigin}/v1/bootstrap/workspace`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceName: "OpenWork Gateway Listing QA", claimRoles: ["owner"] }),
        });
        await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      }
      const state = await readPrivateState(directory);
      redactions.push(state.identity.assertion, ...(state.claimLinks ?? []).map((link) => link.token));
      await checkAuthenticated(state, report, redactions);
    });
  }
  report.notVerified = ["Platform approval or submission", "Human OAuth sign-in, refresh and revocation in each target client", "Durable reviewer login and host screenshots"];
  // Defense in depth: even a credential reflected in an otherwise valid tool name must stay private.
  const output = JSON.stringify(report, (_key, value) => {
    if (typeof value !== "string") return value;
    let sanitized = value;
    for (const secret of redactions) {
      if (typeof secret === "string" && secret.length > 0) sanitized = sanitized.replaceAll(secret, "[redacted]");
    }
    return sanitized;
  }, 2);
  console.log(output);
  return report.checks.every((item) => item.status === "passed") ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch { console.error("Preflight could not start. Check arguments and private-directory permissions; no credentials were printed."); process.exitCode = 1; }
}
