import { applyEdits, createScanner, findNodeAtLocation, parseTree, SyntaxKind, type Edit, type Node } from "jsonc-parser";
import { writeFile } from "node:fs/promises";
import { ApiError } from "./errors.js";
import { readJsoncFile } from "./jsonc.js";
import { opencodeConfigPath } from "./workspace-files.js";

export type WorkspaceRunMode = "default" | "approve" | "run-everything";
export type WorkspaceRunModeState = {
  catchAll: "allow" | "ask" | "deny" | null;
} & ({ mode: WorkspaceRunMode; supported: true; reason?: never } | { mode: WorkspaceRunMode | null; supported: false; reason: string });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is "allow" | "ask" | "deny" {
  return value === "allow" || value === "ask" || value === "deny";
}

export function runModeFromPermissionBlock(block: unknown): WorkspaceRunModeState {
  const catchAll = isAction(block) ? block : isRecord(block) && isAction(block["*"]) ? block["*"] : null;
  const unsupported = (reason: string): WorkspaceRunModeState => ({ mode: null, catchAll, supported: false, reason });
  if (block !== undefined && !isAction(block) && !isRecord(block)) {
    return unsupported("The workspace permission block is not an action or a rule object.");
  }
  if (isRecord(block)) {
    if (Object.hasOwn(block, "*") && !isAction(block["*"])) {
      return unsupported("An object or invalid catch-all cannot be represented by a workspace run mode.");
    }
    if (Object.values(block).some((value) => !isAction(value) && !(isRecord(value) && Object.values(value).every(isAction)))) {
      return unsupported("The workspace contains an invalid permission rule.");
    }
  }
  if (catchAll === "deny") return unsupported("A deny catch-all cannot be represented by a workspace run mode.");
  return { mode: catchAll === "ask" ? "approve" : catchAll === "allow" ? "run-everything" : "default", catchAll, supported: true };
}

function hasDuplicateKeys(node: Node, recursive = false): boolean {
  const keys = new Set<string>();
  for (const property of node.children ?? []) {
    const key: unknown = property.children?.[0]?.value;
    if (typeof key !== "string" || keys.has(key)) return true;
    keys.add(key);
    const value = property.children?.[1];
    if (recursive && value?.type === "object" && hasDuplicateKeys(value, true)) return true;
  }
  return false;
}

async function readRunModeFile(workspaceRoot: string) {
  const path = opencodeConfigPath(workspaceRoot);
  const { data, raw, invalid, missing } = await readJsoncFile<unknown>(path, {}, { allowInvalid: true });
  const tree = parseTree(missing ? "{}" : raw, [], { allowTrailingComma: true });
  const permission = tree && findNodeAtLocation(tree, ["permission"]);
  let state: WorkspaceRunModeState;
  if (invalid || !isRecord(data) || !tree || hasDuplicateKeys(tree) || (permission?.type === "object" && hasDuplicateKeys(permission, true))) {
    state = { mode: null, catchAll: null, supported: false, reason: "The workspace config must be valid JSONC with an object root and no duplicate permission or top-level keys." };
  } else {
    state = runModeFromPermissionBlock(data.permission);
  }
  return { path, raw, tree, permission, state };
}

export async function readWorkspaceRunMode(workspaceRoot: string): Promise<WorkspaceRunModeState & { path: string }> {
  const { state, path } = await readRunModeFile(workspaceRoot);
  return { ...state, path };
}

// Delete syntax tokens, not trivia. JSONC's generic property removal can eat
// adjacent comments; commas inside comments must never be treated as separators.
function removeProperty(content: string, object: Node, property: Node): string {
  const edits: Edit[] = [];
  const scanner = createScanner(content);
  scanner.setPosition(property.offset);
  while (scanner.scan() !== SyntaxKind.EOF && scanner.getTokenOffset() < property.offset + property.length) {
    const token = scanner.getToken();
    if (token !== SyntaxKind.Trivia && token !== SyntaxKind.LineBreakTrivia && token !== SyntaxKind.LineCommentTrivia && token !== SyntaxKind.BlockCommentTrivia) {
      edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: "" });
    }
  }
  const siblings = object.children ?? [];
  const index = siblings.indexOf(property);
  const separator = createScanner(content, true);
  separator.setPosition(property.offset + property.length);
  if (separator.scan() !== SyntaxKind.CommaToken && index > 0) {
    const previous = siblings[index - 1];
    separator.setPosition(previous.offset + previous.length);
    separator.scan();
  }
  if (separator.getToken() === SyntaxKind.CommaToken) edits.push({ offset: separator.getTokenOffset(), length: 1, content: "" });
  return applyEdits(content, edits);
}

function insertFirst(content: string, object: Node, key: string, value: unknown): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lineStart = content.lastIndexOf("\n", object.offset) + 1;
  const indent = content.slice(lineStart, object.offset).match(/^[\t ]*/)?.[0] ?? "";
  const entry = `${eol}${indent}  ${JSON.stringify(key)}: ${JSON.stringify(value)}${object.children?.length ? "," : ""}${eol}`;
  return applyEdits(content, [{ offset: object.offset + 1, length: 0, content: entry }]);
}

/** Edit only the workspace catch-all; narrower rules keep their bytes and order. */
export async function setWorkspaceRunMode(workspaceRoot: string, mode: WorkspaceRunMode): Promise<boolean> {
  const { path, raw, tree, permission, state } = await readRunModeFile(workspaceRoot);
  if (!state.supported) throw new ApiError(409, "workspace_run_mode_unsupported", state.reason);
  if (!tree) throw new Error("Workspace config has no syntax tree");
  const target = mode === "approve" ? "ask" : mode === "run-everything" ? "allow" : null;
  const catchAllProperty = permission?.type === "object"
    ? permission.children?.find((property) => property.children?.[0]?.value === "*")
    : undefined;
  const needsReorder = target !== null && catchAllProperty !== undefined && permission?.children?.[0] !== catchAllProperty;
  if (state.catchAll === target && !needsReorder) return false;

  let content = raw || "{}\n";
  if (permission?.type === "string") {
    if (target === null && permission.parent) content = removeProperty(content, tree, permission.parent);
    else content = applyEdits(content, [{ offset: permission.offset, length: permission.length, content: JSON.stringify(target) }]);
  } else if (permission?.type === "object") {
    if (catchAllProperty && (target === null || needsReorder)) content = removeProperty(content, permission, catchAllProperty);
    if (target !== null) {
      const value = catchAllProperty?.children?.[1];
      if (value && !needsReorder) content = applyEdits(content, [{ offset: value.offset, length: value.length, content: JSON.stringify(target) }]);
      else {
        const updatedTree = parseTree(content, [], { allowTrailingComma: true });
        const object = updatedTree && findNodeAtLocation(updatedTree, ["permission"]);
        if (!object) throw new Error("Workspace permission object disappeared during edit");
        content = insertFirst(content, object, "*", target);
      }
    }
  } else {
    content = insertFirst(content, tree, "permission", { "*": target });
  }
  const errors: { error: number; offset: number; length: number }[] = [];
  parseTree(content, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error("Workspace run mode edit produced invalid JSONC");
  await writeFile(path, content, "utf8");
  return true;
}
