/**
 * Workspace permission rules: the `permission` block of the workspace's own
 * opencode.json, edited the way an OpenCode user would edit it.
 *
 * The workspace file is the layer the engine reads last, so a rule written
 * here is the last word for this workspace; it is visible, portable, and
 * shareable through the repository. OpenWork adds no storage of its own:
 * listing reads the file, "always allow" adds an `allow` entry under the
 * permission the engine asked about, and revoking removes that entry again.
 * Edits preserve the file's comments and formatting.
 */
import { readJsoncFile, updateJsoncPath } from "./jsonc.js";
import { opencodeConfigPath } from "./workspace-files.js";

export type WorkspacePermissionAction = "allow" | "ask" | "deny";

export interface WorkspacePermissionRule {
  permission: string;
  pattern: string;
  action: WorkspacePermissionAction;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is WorkspacePermissionAction {
  return value === "allow" || value === "ask" || value === "deny";
}

/** Flatten a `permission` block as written: string shorthand becomes a `*` entry. */
export function rulesFromPermissionBlock(block: unknown): WorkspacePermissionRule[] {
  const entries = isAction(block) ? { "*": block } : isRecord(block) ? block : null;
  if (!entries) return [];
  const rules: WorkspacePermissionRule[] = [];
  for (const [permission, value] of Object.entries(entries)) {
    if (isAction(value)) {
      rules.push({ permission, pattern: "*", action: value });
      continue;
    }
    if (!isRecord(value)) continue;
    for (const [pattern, action] of Object.entries(value)) {
      if (isAction(action)) rules.push({ permission, pattern, action });
    }
  }
  return rules;
}

async function readPermissionBlock(workspaceRoot: string): Promise<unknown> {
  const empty: Record<string, unknown> = {};
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), empty, { allowInvalid: true });
  return data.permission;
}

export async function listWorkspacePermissionRules(workspaceRoot: string): Promise<WorkspacePermissionRule[]> {
  return rulesFromPermissionBlock(await readPermissionBlock(workspaceRoot));
}

/**
 * Add `pattern: action` under `permission`. A string shorthand at either level
 * is expanded to its `"*"` form first so nothing the user wrote is lost.
 * Returns false when the exact rule already exists.
 */
export async function addWorkspacePermissionRule(
  workspaceRoot: string,
  rule: WorkspacePermissionRule,
): Promise<boolean> {
  const path = opencodeConfigPath(workspaceRoot);
  const block = await readPermissionBlock(workspaceRoot);
  if (isAction(block)) {
    // `"permission": "allow"` → keep that as the catch-all, add the new entry beside it.
    await updateJsoncPath(path, ["permission"], { "*": block, [rule.permission]: { [rule.pattern]: rule.action } });
    return true;
  }
  const current = isRecord(block) ? block[rule.permission] : undefined;
  if (isRecord(current)) {
    if (current[rule.pattern] === rule.action) return false;
    await updateJsoncPath(path, ["permission", rule.permission, rule.pattern], rule.action);
    return true;
  }
  const expanded: Record<string, WorkspacePermissionAction> = isAction(current) ? { "*": current } : {};
  if (expanded[rule.pattern] === rule.action) return false;
  await updateJsoncPath(path, ["permission", rule.permission], { ...expanded, [rule.pattern]: rule.action });
  return true;
}

/** Remove one entry; an emptied permission object is removed with it. Returns false when absent. */
export async function removeWorkspacePermissionRule(
  workspaceRoot: string,
  rule: Pick<WorkspacePermissionRule, "permission" | "pattern">,
): Promise<boolean> {
  const path = opencodeConfigPath(workspaceRoot);
  const block = await readPermissionBlock(workspaceRoot);
  if (isAction(block)) {
    if (rule.permission !== "*" || rule.pattern !== "*") return false;
    await updateJsoncPath(path, ["permission"], undefined);
    return true;
  }
  if (!isRecord(block)) return false;
  const current = block[rule.permission];
  if (isAction(current)) {
    if (rule.pattern !== "*") return false;
    await updateJsoncPath(path, ["permission", rule.permission], undefined);
    return true;
  }
  if (!isRecord(current) || !(rule.pattern in current)) return false;
  const remaining = Object.keys(current).filter((pattern) => pattern !== rule.pattern);
  if (remaining.length === 0) {
    await updateJsoncPath(path, ["permission", rule.permission], undefined);
  } else {
    await updateJsoncPath(path, ["permission", rule.permission, rule.pattern], undefined);
  }
  return true;
}
