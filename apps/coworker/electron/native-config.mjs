import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const actionName = (name) => name === "bash" ? "shell" : name === "task" ? "subagent" : name === "write" || name === "patch" ? "edit" : name;
const refuse = (field) => { throw new Error(`Cannot safely migrate OpenCode config field ${field}; original file is unchanged.`); };

// Only the exact app-generated registration, corroborated by the local broker
// connection, owns the old blanket false. A server name or loopback URL alone
// is not provenance. Stale/custom entries keep their policy until app registration.
function generatedCoworkerServer(server, connection) {
  if (!record(server) || !record(connection) || server.type !== "remote" || server.oauth !== false
    || typeof connection.token !== "string" || !connection.token
    || !record(server.headers) || Object.keys(server.headers).length !== 1
    || server.headers.Authorization !== `Bearer ${connection.token}`
    || Object.keys(server).some((key) => !["type", "url", "headers", "oauth", "disabled", "codemode"].includes(key))) return false;
  try {
    const url = new URL(server.url);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port)
      && server.url === `${url.origin}/mcp` && connection.url === `${url.origin}/context`;
  } catch { return false; }
}

export function nativePermissions(permission, tools, rules = []) {
  if (!Array.isArray(rules) || rules.some((rule) => !record(rule) || typeof rule.action !== "string" || typeof rule.resource !== "string" || !["allow", "ask", "deny"].includes(rule.effect))) refuse("permissions");
  const result = [];
  if (permission !== undefined) {
    const entries = typeof permission === "string" ? [["*", permission]] : record(permission) ? Object.entries(permission) : refuse("permission");
    for (const [key, value] of entries) {
      for (const [resource, effect] of typeof value === "string" ? [["*", value]] : record(value) ? Object.entries(value) : refuse("permission")) {
        if (!["allow", "ask", "deny"].includes(effect)) refuse("permission");
        result.push({ action: actionName(key), resource, effect });
      }
    }
  }
  result.push(...rules);
  if (tools !== undefined) {
    if (!record(tools) || Object.values(tools).some((value) => typeof value !== "boolean")) refuse("tools");
    // A disabled v1 tool must stay disabled even beside a broad permission allow.
    for (const [action, enabled] of Object.entries(tools)) {
      if (!enabled) result.push({ action: actionName(action), resource: "*", effect: "deny" });
    }
  }
  return result;
}

/** Only the generated v1 surface and lossless user extensions are migrated.
 * Unknown legacy shapes fail closed instead of relying on v2's lossy normalizer. */
export function nativeConfig(config, { coworkerConnection } = {}) {
  if (!record(config)) refuse("root");
  const next = { ...config };
  for (const key of ["provider", "command", "mode", "small_model", "enabled_providers", "disabled_providers"]) if (key in config) refuse(key);
  if ("permission" in config || "permissions" in config || "tools" in config) next.permissions = nativePermissions(config.permission, config.tools, config.permissions);
  delete next.permission;
  delete next.tools;
  if ("plugin" in config || "plugins" in config) {
    if ((config.plugin !== undefined && !Array.isArray(config.plugin)) || (config.plugins !== undefined && !Array.isArray(config.plugins))) refuse("plugins");
    next.plugins = [...(config.plugin ?? []).map((entry) => {
      if (typeof entry === "string") return entry;
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && record(entry[1])) return { package: entry[0], options: entry[1] };
      return refuse("plugin");
    }), ...(config.plugins ?? [])].filter((entry, index, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(entry)) === index);
  }
  delete next.plugin;
  if ("agent" in config) {
    if (!record(config.agent) || (config.agents !== undefined && !record(config.agents))) refuse("agents");
    next.agents = { ...config.agents };
    for (const [name, agent] of Object.entries(config.agent)) {
      if (!record(agent) || name in next.agents) refuse(`agents.${name}`);
      const migrated = { ...agent };
      if (("prompt" in agent && "system" in agent && agent.prompt !== agent.system)
        || ("disable" in agent && "disabled" in agent && agent.disable !== agent.disabled)) refuse(`agents.${name}`);
      if ("prompt" in agent) { migrated.system = agent.prompt; delete migrated.prompt; }
      if ("disable" in agent) { migrated.disabled = agent.disable; delete migrated.disable; }
      if ("permission" in agent || "tools" in agent) migrated.permissions = nativePermissions(agent.permission, agent.tools, agent.permissions);
      delete migrated.permission; delete migrated.tools;
      if ("options" in agent || "temperature" in agent || "top_p" in agent) {
        if (agent.request !== undefined) refuse(`agents.${name}.request`);
        migrated.request = { body: { ...agent.options, ...(agent.temperature === undefined ? {} : { temperature: agent.temperature }), ...(agent.top_p === undefined ? {} : { top_p: agent.top_p }) } };
        delete migrated.options; delete migrated.temperature; delete migrated.top_p;
      }
      if (agent.variant !== undefined) {
        if (typeof agent.model !== "string" || agent.model.includes("#")) refuse(`agents.${name}.variant`);
        migrated.model = agent.model + "#" + agent.variant; delete migrated.variant;
      }
      if (Object.keys(migrated).some((key) => !["model", "request", "system", "description", "mode", "hidden", "color", "steps", "disabled", "permissions"].includes(key))) refuse(`agents.${name}`);
      next.agents[name] = migrated;
    }
  }
  delete next.agent;
  if ("mcp" in config) {
    if (!record(config.mcp) || (config.mcp.servers !== undefined && !record(config.mcp.servers))) refuse("mcp");
    const servers = { ...config.mcp.servers };
    for (const [name, server] of Object.entries(config.mcp)) {
      if (["servers", "timeout"].includes(name)) continue;
      if (!record(server) || !["remote", "local"].includes(server.type) || name in servers) refuse(`mcp.${name}`);
      const migrated = { ...server };
      if ("enabled" in server) {
        if (typeof server.enabled !== "boolean" || ("disabled" in server && server.disabled !== !server.enabled)) refuse(`mcp.${name}.enabled`);
        migrated.disabled = !server.enabled; delete migrated.enabled;
      }
      if (record(server.oauth) && Object.keys(server.oauth).some((key) => !["client_id", "client_secret", "scope", "callback_port", "redirect_uri"].includes(key))) refuse(`mcp.${name}.oauth`);
      if (typeof server.timeout === "number") migrated.timeout = { catalog: server.timeout, execution: server.timeout };
      servers[name] = migrated;
    }
    if (servers.coworker?.codemode === false && generatedCoworkerServer(servers.coworker, coworkerConnection)) {
      servers.coworker = { ...servers.coworker, codemode: true };
    }
    next.mcp = { ...(config.mcp.timeout === undefined ? {} : { timeout: config.mcp.timeout }), ...(Object.keys(servers).length ? { servers } : {}) };
  }
  if (record(config.skills)) next.skills = [...(config.skills.paths ?? []), ...(config.skills.urls ?? [])];
  if ("snapshot" in config) { next.snapshots ??= config.snapshot; delete next.snapshot; }
  if ("autoupdate" in config) { next.update ??= config.autoupdate === false ? "disable" : "notify"; delete next.autoupdate; }
  const supported = new Set(["$schema", "shell", "model", "default_agent", "update", "share", "enterprise", "username", "permissions", "agents", "snapshots", "watcher", "formatter", "lsp", "media", "tool_output", "mcp", "compaction", "skills", "commands", "instructions", "references", "websearch", "plugins", "warming", "providers", "experimental"]);
  for (const key of Object.keys(next)) if (!supported.has(key)) refuse(key);
  return next;
}

const writes = new Map();
export function updateNativeConfig(directory, transform = (config) => config) {
  const target = path.join(directory, "opencode.json");
  const operation = (writes.get(target) ?? Promise.resolve()).catch(() => {}).then(async () => {
    let original;
    try { original = await readFile(target, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parsed = original === undefined ? {} : JSON.parse(original);
    const coworkerConnection = await readFile(path.join(directory, ".opencode", "coworker-context.json"), "utf8")
      .then((text) => JSON.parse(text)).catch((error) => { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; });
    const migrated = nativeConfig(parsed, { coworkerConnection });
    const next = transform(migrated);
    if (JSON.stringify(parsed) === JSON.stringify(next)) return false;
    if (original !== undefined && JSON.stringify(parsed) !== JSON.stringify(migrated)) {
      // Never overwrite the first recoverable pre-migration bytes.
      await writeFile(`${target}.pre-v2.bak`, original, { flag: "wx", mode: 0o600 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, target);
    return true;
  });
  writes.set(target, operation);
  operation.finally(() => { if (writes.get(target) === operation) writes.delete(target); }).catch(() => {});
  return operation;
}
