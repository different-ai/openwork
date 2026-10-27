import { z } from "zod";

// The host performs these actions for its signed-in caller, as with drive_upload_file. Agents use these tools, which ask before writes.
export const DRIVE_FILE_ACTIONS = ["drive_pull_file", "drive_file_status", "drive_push_file"] as const;
export type DriveFileAction = (typeof DRIVE_FILE_ACTIONS)[number];

type CallDriveAction = (action: DriveFileAction, args: Record<string, unknown>, context: unknown) => Promise<unknown>;

const connectionId = z.string().regex(/^(google-workspace|microsoft-365|emc_[A-Za-z0-9]+)$/).optional()
  .describe("Selected Google Workspace or Microsoft 365 connection; omit for the default. Unavailable selections never fall back to another account.");
const workspacePath = z.string().min(1).max(4096);

export const drivePullFileArgs = z.object({
  fileId: z.string().min(1).max(2048).describe("Google Drive file ID or link, or a OneDrive, SharePoint or Teams file link or item id."),
  driveId: z.string().min(1).max(512).optional().describe("Microsoft 365 only: the driveId that came with the item id from a search or folder listing."),
  provider: z.enum(["google-workspace", "microsoft-365"]).optional().describe("Only needed for a Microsoft item id without driveId; links and driveId identify Microsoft 365 files."),
  path: workspacePath.optional().describe("Workspace path to save to. Defaults to drive/<file name>."),
  format: z.string().regex(/^[a-z]{2,5}$/).optional().describe("Docs, Sheets, Slides and Drawings: xlsx, csv (first tab only), docx, md, txt, pptx, pdf, png or svg. OneDrive and SharePoint: pdf converts an Office file."),
  connectionId,
  overwrite: z.boolean().optional().describe("Replace a local copy even if it has edits not in Drive. Asks the person first."),
}).strict();

export const driveFileStatusArgs = z.object({
  path: workspacePath.optional().describe("One pulled file; omit for all of them."),
}).strict();

export const drivePushFileArgs = z.object({
  path: workspacePath.describe("Workspace path of a pulled file."),
  mode: z.enum(["replace", "copy"]).optional().describe("replace (default for stored files) updates the same file; copy saves a new file next to it."),
  name: z.string().min(1).max(255).optional().describe("Name for a copy."),
}).strict();

/** What the model sees for each tool; v1 tools and the v2 context plugin share these. */
export const DRIVE_FILE_TOOLS = {
  drive_pull_file: {
    description: "Save a Google Drive, OneDrive or SharePoint file into the workspace and return its path and revision, never its content. Use it to analyze or edit Office, PDF, CSV or any large file with shell tools. Docs, Sheets and Slides arrive as docx, xlsx and pptx unless format says otherwise.",
    args: drivePullFileArgs,
  },
  drive_file_status: {
    description: "For files pulled with drive_pull_file, report whether the local copy has edits not saved back and whether the file changed in Drive, OneDrive or SharePoint since the pull.",
    args: driveFileStatusArgs,
  },
  drive_push_file: {
    description: "Save a pulled file back to where it came from when the person asks. Asks the person first. Stored files, including Office files in OneDrive and SharePoint, are replaced in place as a new version; Google Docs, Sheets and Slides and PDF conversions are saved as a new file next to the original. Returns drive_conflict, and changes nothing, when someone changed the file since the pull: pull it again and reapply the edits, or save a copy.",
    args: drivePushFileArgs,
  },
} satisfies Record<DriveFileAction, { description: string; args: z.ZodObject }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Engine permissions check writes; Desktop separately confirms every transfer at the host boundary. */
async function askPermission(context: unknown, permission: DriveFileAction, patterns: string[], metadata: Record<string, unknown>) {
  const ask = isRecord(context) && typeof context.ask === "function" ? context.ask : null;
  if (!ask) throw new Error("This OpenWork engine cannot ask for approval, so nothing was changed. Update OpenWork to save files to Drive.");
  // "Always" covers only these patterns, so one approval never extends to other files.
  await ask.call(context, { permission, patterns, always: patterns, metadata });
}

export function createDriveFileTools(call: CallDriveAction) {
  return {
    drive_pull_file: {
      description: DRIVE_FILE_TOOLS.drive_pull_file.description,
      args: drivePullFileArgs.shape,
      async execute(rawArgs: unknown, context: unknown) {
        const args = drivePullFileArgs.parse(rawArgs ?? {});
        if (args.overwrite) await askPermission(context, "drive_pull_file", [args.path ?? args.fileId], { fileId: args.fileId, path: args.path ?? null, overwrite: true });
        return JSON.stringify(await call("drive_pull_file", args, context), null, 2);
      },
    },
    drive_file_status: {
      description: DRIVE_FILE_TOOLS.drive_file_status.description,
      args: driveFileStatusArgs.shape,
      async execute(rawArgs: unknown, context: unknown) {
        return JSON.stringify(await call("drive_file_status", driveFileStatusArgs.parse(rawArgs ?? {}), context), null, 2);
      },
    },
    drive_push_file: {
      description: DRIVE_FILE_TOOLS.drive_push_file.description,
      args: drivePushFileArgs.shape,
      async execute(rawArgs: unknown, context: unknown) {
        const args = drivePushFileArgs.parse(rawArgs ?? {});
        await askPermission(context, "drive_push_file", [args.path], { path: args.path, mode: args.mode ?? "default", ...(args.name ? { name: args.name } : {}) });
        return JSON.stringify(await call("drive_push_file", args, context), null, 2);
      },
    },
  };
}
