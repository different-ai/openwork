import path from "node:path";

/**
 * Native confirmation copy contains the decision, not remote IDs or sharing URLs.
 * @param {import("../../server/src/types.js").DriveFileApprovalRequest} request
 * @returns {import("electron").MessageBoxOptions}
 */
export function driveFileApprovalOptions({ provider, action, name, displayPath, mode }) {
  const service = provider === "microsoft-365" ? "OneDrive or SharePoint" : "Google Drive";
  const fileName = String(name).replace(/[\r\n\x00-\x1f\x7f]/g, " ");
  // Older hosts may not supply a relative label. Never fall back to an absolute path.
  const destination = displayPath && !path.posix.isAbsolute(displayPath) && !path.win32.isAbsolute(displayPath)
    ? displayPath.replace(/[\r\n\x00-\x1f\x7f]/g, " ")
    : "the workspace copy";
  const overwrite = action === "overwrite";
  const copy = mode === "copy";
  const label = overwrite ? "Replace local copy" : copy ? "Save a copy" : "Save changes";
  return {
    type: "question",
    message: overwrite ? `Replace the local copy of ${fileName}?` : copy ? `Save a copy of ${fileName} to ${service}?` : `Save changes to ${fileName} in ${service}?`,
    detail: overwrite
      ? `Replaces ${destination} with the current file from ${service}. Local edits will be lost; the file in ${service} will not change.`
      : copy
        ? `Saves ${destination} as a new file next to the original in ${service}. The original will not change.`
        : `Replaces the file in ${service} with ${destination}. People with access to it will see your changes.`,
    buttons: ["Cancel", label], defaultId: 0, cancelId: 0, noLink: true,
  };
}
