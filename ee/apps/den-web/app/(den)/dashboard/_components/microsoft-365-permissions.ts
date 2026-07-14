import {
  MICROSOFT_365_DEFAULT_FEATURES,
  type Microsoft365Feature,
} from "@openwork/types/den/microsoft-365";

export { MICROSOFT_365_DEFAULT_FEATURES };

export type Microsoft365Permission = {
  key: Microsoft365Feature;
  label: string;
  scope: string;
  detail?: string;
};

export type Microsoft365PermissionGroup = {
  name: string;
  permissions: readonly Microsoft365Permission[];
};

export const MICROSOFT_365_PERMISSION_GROUPS: readonly Microsoft365PermissionGroup[] = [
  {
    name: "Calendar",
    permissions: [
      { key: "calendarRead", label: "Read Outlook calendar", scope: "Calendars.Read" },
      {
        key: "calendarWrite",
        label: "Create and manage calendar events",
        scope: "Calendars.ReadWrite",
        detail: "Microsoft grants full access to the member's calendars.",
      },
    ],
  },
  {
    name: "Outlook",
    permissions: [
      {
        key: "mailDraft",
        label: "Create and manage email drafts",
        scope: "Mail.ReadWrite",
        detail: "Microsoft grants mailbox read/write access. This option does not send mail.",
      },
      { key: "mailRead", label: "Read Outlook mail", scope: "Mail.Read" },
    ],
  },
  {
    name: "OneDrive",
    permissions: [
      { key: "filesRead", label: "Read OneDrive files", scope: "Files.Read" },
      { key: "filesWrite", label: "Create and update OneDrive files", scope: "Files.ReadWrite" },
      { key: "filesReadAll", label: "Read all files the member can access", scope: "Files.Read.All" },
      { key: "filesFull", label: "Full access to files the member can access", scope: "Files.ReadWrite.All" },
    ],
  },
  {
    name: "Teams",
    permissions: [
      { key: "teamsChatRead", label: "Read Teams chats", scope: "Chat.Read" },
      {
        key: "teamsChatSend",
        label: "Send Teams chat messages",
        scope: "Chat.Read + ChatMessage.Send",
        detail: "Includes chat read access so OpenWork can find an existing chat; it cannot create a new chat.",
      },
    ],
  },
];

export const MICROSOFT_365_DISPLAY_SCOPES = new Set(
  MICROSOFT_365_PERMISSION_GROUPS.flatMap((group) =>
    group.permissions.flatMap((permission) => permission.scope.split(" + ")),
  ),
);
