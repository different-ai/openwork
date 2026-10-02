export type NativePermission = { key: string; label: string; scope?: string; detail?: string };
export type NativePermissionGroup = { name: string; permissions: readonly NativePermission[] };

export const GOOGLE_WORKSPACE_DEFAULT_FEATURES: readonly string[] = ["calendarRead", "gmailDraft", "driveFile"];

export const GOOGLE_WORKSPACE_PERMISSION_GROUPS: readonly NativePermissionGroup[] = [
  {
    name: "Calendar",
    permissions: [
      { key: "calendarRead", label: "Read calendar" },
      { key: "calendarWrite", label: "Create, edit, and cancel calendar events" },
    ],
  },
  {
    name: "Gmail",
    permissions: [
      { key: "gmailDraft", label: "Create and edit email drafts" },
      { key: "gmailSend", label: "Send email drafts after confirmation" },
      { key: "gmailRead", label: "Read Gmail" },
      { key: "gmailManage", label: "Manage Gmail: send, archive, read status, labels, and trash" },
      { key: "gmailLabels", label: "Create and manage Gmail labels" },
    ],
  },
  {
    name: "Drive",
    permissions: [
      { key: "driveFile", label: "Work with selected Drive files" },
      { key: "driveRead", label: "Read all Drive files" },
      { key: "driveFull", label: "Full Drive access" },
    ],
  },
  {
    name: "Sheets",
    permissions: [
      { key: "sheetsRead", label: "Read spreadsheets" },
      { key: "sheetsWrite", label: "Create spreadsheets and edit cells" },
    ],
  },
  {
    name: "Chat",
    permissions: [
      { key: "chat", label: "Google Chat" },
    ],
  },
];
