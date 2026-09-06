import type { DesktopConfig, DesktopExecutionPolicy, DesktopPolicyKey } from "@openwork/types/den/desktop-policies";
import { z } from "zod";

export const managedPolicyActionSchema = z.enum([
  "sync", "shell", "terminal", "saved_command", "file_write", "engine_config", "browser_external",
  "model", "webfetch", "websearch", "browser", "extensions", "settings", "provider", "workspace",
]);
export type ManagedPolicyAction = z.infer<typeof managedPolicyActionSchema>;

// Every existing Den control must have an explicit owner. Adding a key without
// mapping it is a type error; UI-only fields cannot pretend to be tool rules.
export const desktopPolicyTargets = {
  allowCustomProviders: "provider", allowZenModel: "provider",
  allowMultipleWorkspaces: "workspace", allowControlSettings: "settings",
  allowManageExtensions: "extensions", allowBuiltInExtensions: "builtins",
  allowAlphaUpdates: "app", showWelcomePage: "app",
} satisfies Record<DesktopPolicyKey, string>;

export const executionPolicyTargets = {
  commands: ["engine.shell", "tool.before", "shell.before", "engine.proxy"],
  blockedCommands: ["engine.shell", "tool.before", "shell.before", "engine.proxy"],
  browserOrigins: ["engine.webfetch", "tool.before", "browser.request"],
  blockBrowserUploads: ["browser.request"],
} satisfies Record<keyof DesktopExecutionPolicy, readonly string[]>;

export type EnginePermissionRule = { action: string; resource: string; effect: "allow" | "deny" };
export function executionRules(policy: DesktopExecutionPolicy | undefined): EnginePermissionRule[] {
  if (!policy) return [];
  const rules: EnginePermissionRule[] = [];
  if (policy.commands === "deny") rules.push({ action: "shell", resource: "*", effect: "deny" });
  for (const resource of policy.blockedCommands) rules.push({ action: "shell", resource, effect: "deny" });
  if (policy.browserOrigins !== undefined) {
    rules.push({ action: "webfetch", resource: "*", effect: "deny" });
    rules.push({ action: "websearch", resource: "*", effect: "deny" });
  }
  return rules;
}
type LegacyExecutionPermissions = {
  bash?: Record<string, "allow" | "deny">;
  webfetch?: "allow" | "deny";
  websearch?: "allow" | "deny";
};
export function legacyExecutionPermissions(policy: DesktopExecutionPolicy | undefined): LegacyExecutionPermissions {
  const permissions: LegacyExecutionPermissions = {};
  for (const rule of executionRules(policy)) {
    if (rule.action === "shell") {
      permissions.bash ??= {};
      permissions.bash[rule.resource] = rule.effect;
    } else if (rule.action === "webfetch" || rule.action === "websearch") {
      // The pinned engine accepts only scalar actions for these two tools.
      permissions[rule.action] = rule.effect;
    }
  }
  return permissions;
}
// Glob matching without a regular expression: repeated wildcard patterns must
// not create catastrophic backtracking on a long command.
function matches(pattern: string, value: string): boolean {
  const rule = pattern.toLowerCase();
  const command = value.toLowerCase();
  let ruleIndex = 0;
  let commandIndex = 0;
  let star = -1;
  let retry = 0;
  while (commandIndex < command.length) {
    if (rule[ruleIndex] === "?" || rule[ruleIndex] === command[commandIndex]) { ruleIndex++; commandIndex++; }
    else if (rule[ruleIndex] === "*") { star = ruleIndex++; retry = commandIndex; }
    else if (star >= 0) { ruleIndex = star + 1; commandIndex = ++retry; }
    else return false;
  }
  while (rule[ruleIndex] === "*") ruleIndex++;
  return ruleIndex === rule.length;
}

export function policyDenial(policy: DesktopConfig, action: ManagedPolicyAction, input: Record<string, unknown>): string | null {
  const execution = policy.execution;
  if (action === "terminal" && (execution?.commands === "deny" || execution?.blockedCommands.length)) return "Interactive terminals are blocked by your team's command policy.";
  if (action === "saved_command" && (execution?.commands === "deny" || execution?.blockedCommands.length)) return "Saved commands are blocked by your team's command policy.";
  if (action === "shell") {
    if (execution?.commands === "deny") return "Your organization has blocked OS commands for your team.";
    const command = typeof input.command === "string" ? input.command : "";
    if (execution?.blockedCommands.some((pattern) => matches(pattern, command))) return "This command is blocked by your team's policy.";
  }
  if (action === "file_write" && (hasExecutionLimits(execution) || policy.allowCustomProviders === false || policy.allowManageExtensions === false || policy.allowControlSettings === false)) {
    const paths: unknown[] = [input.filePath, input.path];
    for (const patch of [input.patchText, input.patch]) {
      if (typeof patch === "string") for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) paths.push(match[1]);
    }
    if (Array.isArray(input.operations)) for (const operation of input.operations) {
      if (typeof operation === "object" && operation !== null) {
        for (const [key, value] of Object.entries(operation)) if (["path", "from", "to"].includes(key)) paths.push(value);
      }
    }
    if (paths.some((path) => typeof path === "string" && /(?:^|[\\/])(?:opencode\.jsonc?$|runtime-opencode-config\.json$|\.opencode(?:[\\/]|$)|opencode[\\/](?:plugins?|tools?|skills?|agents?)(?:[\\/]|$))/i.test(path.trim()))) return "Your organization manages this configuration. Change access in Den.";
  }
  if (action === "engine_config" && (hasExecutionLimits(execution) || policy.allowCustomProviders === false || policy.allowManageExtensions === false || policy.allowControlSettings === false)) return "Your organization manages engine configuration. Change access in Den.";
  if (action === "browser_external" && (execution?.browserOrigins !== undefined || execution?.blockBrowserUploads || policy.allowBuiltInExtensions === false)) return "Open this site in the managed browser.";
  if ((action === "model" || action === "provider") && input.providerID === "opencode") {
    return policy.allowZenModel === false ? "Your organization has disabled this AI provider." : null;
  }
  // Native fetch follows redirects inside the engine. Until it exposes a
  // per-hop hook, approved-site browsing must use the intercepted browser.
  if ((action === "webfetch" || action === "websearch") && execution?.browserOrigins !== undefined) return "Use OpenWork's built-in browser to open approved websites.";
  if (action === "browser" || action === "webfetch") {
    if (action === "browser" && policy.allowBuiltInExtensions === false) return "Built-in extensions are disabled by your organization.";
    const url = typeof input.url === "string" ? input.url : "";
    if (execution?.browserOrigins !== undefined) {
      try {
        const target = new URL(url);
        if (target.username || target.password || !execution.browserOrigins.includes(target.origin)) return "This website is not approved by your organization.";
      } catch { return "This website is not approved by your organization."; }
    }
    if (execution?.blockBrowserUploads && (/^wss?:/i.test(url) || input.hasUpload === true || (typeof input.method === "string" && !["GET", "HEAD", "OPTIONS"].includes(input.method)))) return "Browser uploads are blocked by your team's policy.";
  }
  if (action === "extensions" && policy.allowManageExtensions === false) return "Your organization has disabled local extension management.";
  if (action === "settings" && policy.allowControlSettings === false) return "Your organization has disabled changing these settings.";
  if (action === "provider" && policy.allowCustomProviders === false) return "Your organization only allows its assigned AI providers.";
  if (action === "workspace" && policy.allowMultipleWorkspaces === false) return "Your organization has restricted additional workspaces.";
  return null;
}

export function hasExecutionLimits(execution: DesktopExecutionPolicy | undefined): boolean {
  return !!execution && (execution.commands === "deny" || execution.blockedCommands.length > 0 || execution.browserOrigins !== undefined || execution.blockBrowserUploads);
}

export function policyRequestActions(method: string, path: string): ManagedPolicyAction[] {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return [];
  const actions: ManagedPolicyAction[] = [];
  if (/^\/workspaces\/(local|remote)$/.test(path)) actions.push("workspace");
  if (/^\/runtime-config\/providers$/.test(path)) actions.push("provider");
  if (/^\/workspace\/[^/]+\/(?:cloud-plugins|claude-plugins|plugins|skills|commands|mcp)(?:\/|$)/.test(path)
    && !/\/mcp\/[^/]+\/(?:auth|managed\/connect)$/.test(path)) actions.push("extensions");
  if (/^\/workspace\/[^/]+\/(?:config|opencode-config|permissions|authorized-folders)(?:\/|$)/.test(path)) actions.push("settings");
  if (path === "/experimental/engine-v2-preview") actions.push("settings");
  if (/\/opencode-config$/.test(path)) actions.push("engine_config");
  return actions;
}
