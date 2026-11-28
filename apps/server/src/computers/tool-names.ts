import { SANDBOX_TOOL_NAMES, type SandboxToolName } from "../sandbox-tool-host.js";

export const computersSandboxConflict = "This chat can't run on another computer while the local sandbox is enabled for this folder.";
export const localComputerTools = new Set([
  "patch", "opencode_session_move", "opencode_worktree_create", "opencode_worktree_list", "opencode_worktree_remove",
  "openwork_drive_upload", "openwork_gmail_draft", "openwork_outlook_draft", "drive_pull_file", "drive_file_status", "drive_push_file",
]);
export function routedComputerTool(name: string): SandboxToolName | undefined {
  return SANDBOX_TOOL_NAMES.find(tool => name === tool);
}

