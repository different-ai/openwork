import type { DesktopConfig, DesktopExecutionPolicy, DesktopPolicyKey } from "@openwork/types/den/desktop-policies";

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
    for (const origin of policy.browserOrigins) {
      rules.push({ action: "webfetch", resource: origin, effect: "allow" });
      rules.push({ action: "webfetch", resource: `${origin}/*`, effect: "allow" });
    }
  }
  return rules;
}
export function legacyExecutionPermissions(policy: DesktopExecutionPolicy | undefined): Record<string, Record<string, "allow" | "deny">> {
  const permissions: Record<string, Record<string, "allow" | "deny">> = {};
  for (const rule of executionRules(policy)) {
    const key = rule.action === "shell" ? "bash" : rule.action;
    permissions[key] ??= {};
    permissions[key][rule.resource] = rule.effect;
  }
  return permissions;
}
function matches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "is").test(value);
}
export function policyDenial(policy: DesktopConfig, action: string, input: Record<string, unknown>): string | null {
  const execution = policy.execution;
  if (action === "shell") {
    if (execution?.commands === "deny") return "Your organization has blocked OS commands for your team.";
    const command = typeof input.command === "string" ? input.command : "";
    if (execution?.blockedCommands.some((pattern) => matches(pattern, command))) return "This command is blocked by your team's policy.";
  }
  if (action === "file_write" && (hasExecutionLimits(execution) || policy.allowCustomProviders === false || policy.allowManageExtensions === false || policy.allowControlSettings === false)) {
    const paths = [input.filePath, input.path, input.patchText, input.patch, ...(Array.isArray(input.ops) ? input.ops.map((op) => typeof op === "object" && op !== null ? JSON.stringify(op) : "") : [])];
    if (paths.some((path) => typeof path === "string" && /(?:^|[\\/\s"])(?:opencode\.jsonc?|runtime-opencode-config\.json|\.opencode[\\/](?:plugins?|tools?|skills?|agents?)(?:[\\/]|$))/im.test(path))) return "Your organization manages this configuration. Change access in Den.";
  }
  if (action === "engine_config" && (hasExecutionLimits(execution) || policy.allowCustomProviders === false || policy.allowManageExtensions === false || policy.allowControlSettings === false)) return "Your organization manages engine configuration. Change access in Den.";
  if (action === "browser_external" && (hasExecutionLimits(execution) || policy.allowBuiltInExtensions === false)) return "Open this site in the managed browser.";
  if (action === "model" && policy.allowZenModel === false && input.providerID === "opencode") return "Your organization has disabled this AI provider.";
  if (action === "browser" || action === "webfetch") {
    if (action === "browser" && policy.allowBuiltInExtensions === false) return "Built-in extensions are disabled by your organization.";
    const url = typeof input.url === "string" ? input.url : "";
    if (execution?.browserOrigins !== undefined) {
      try {
        const target = new URL(url);
        if (target.username || target.password || !execution.browserOrigins.includes(target.origin)) return "This website is not approved by your organization.";
      } catch { return "This website is not approved by your organization."; }
    }
    if (execution?.blockBrowserUploads && (input.hasUpload === true || (typeof input.method === "string" && !["GET", "HEAD", "OPTIONS"].includes(input.method)))) return "Browser uploads are blocked by your team's policy.";
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

export function policyRequestActions(method: string, path: string): string[] {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return [];
  const actions: string[] = [];
  if (/^\/workspaces\/(local|remote)$/.test(path)) actions.push("workspace");
  if (/^\/runtime-config\/providers$/.test(path)) actions.push("provider");
  if (/^\/workspace\/[^/]+\/(?:claude-plugins|plugins|skills|commands|mcp)(?:\/|$)/.test(path)
    && !/\/mcp\/[^/]+\/(?:auth|managed\/connect)$/.test(path)) actions.push("extensions");
  if (/^\/workspace\/[^/]+\/(?:config|opencode-config|permissions|authorized-folders)(?:\/|$)/.test(path)) actions.push("settings");
  if (/\/opencode-config$/.test(path)) actions.push("engine_config");
  return actions;
}
